package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/fullstorydev/grpcui"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/desc/builder"
	"github.com/jhump/protoreflect/desc/protoprint"
	"google.golang.org/grpc"
)

// Wire contract: docs/API.md. The /api/metadata and /api/invoke payloads come
// straight from the upstream grpcui handlers.

const (
	csrfCookieName = "_grpcui_csrf_token"
	csrfHeaderName = "x-grpcui-csrf-token"
)

type discoverFunc func(ctx context.Context) ([]*desc.MethodDescriptor, []*desc.FileDescriptor, error)

type gatewayConfig struct {
	target          string
	conn            grpc.ClientConnInterface
	discover        discoverFunc
	discoverTimeout time.Duration
	defaultMetadata []string // "name: value", pre-filled in the UI
	extraMetadata   []string // "name: value", added to every RPC
	preserveHeaders []string
	emitDefaults    bool
	verbosity       int
	maxTime         time.Duration // 0 = unlimited
	examples        []byte        // JSON array, may be nil
	basePath        string
}

// catalog is everything derived from one successful schema discovery. It is
// swapped atomically so a reload never disturbs in-flight requests.
type catalog struct {
	servicesJSON []byte
	metadata     http.Handler
	invoke       http.Handler
}

type gateway struct {
	cfg gatewayConfig

	current   atomic.Pointer[catalog]
	refreshMu sync.Mutex
	lastErr   atomic.Pointer[string]
}

func newGateway(cfg gatewayConfig) *gateway {
	return &gateway{cfg: cfg}
}

// refresh runs schema discovery once and, on success, installs a new catalog.
// On failure the previous catalog (if any) stays in place.
func (g *gateway) refresh(ctx context.Context) error {
	g.refreshMu.Lock()
	defer g.refreshMu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, g.cfg.discoverTimeout)
	defer cancel()
	methods, files, err := g.cfg.discover(ctx)
	if err != nil {
		msg := err.Error()
		g.lastErr.Store(&msg)
		return err
	}
	servicesJSON, err := json.Marshal(buildServices(g.cfg.target, g.cfg.defaultMetadata, methods))
	if err != nil {
		return err
	}

	invokeOpts := grpcui.InvokeOptions{
		ExtraMetadata:   g.cfg.extraMetadata,
		PreserveHeaders: g.cfg.preserveHeaders,
		EmitDefaults:    g.cfg.emitDefaults,
		Verbosity:       g.cfg.verbosity,
	}
	g.current.Store(&catalog{
		servicesJSON: servicesJSON,
		metadata:     grpcui.RPCMetadataHandler(methods, files),
		invoke:       http.StripPrefix("/api/invoke", grpcui.RPCInvokeHandlerWithOptions(g.cfg.conn, methods, invokeOpts)),
	})
	g.lastErr.Store(nil)
	log.Printf("Discovered %d methods on %s", len(methods), g.cfg.target)
	return nil
}

// discoverUntilReady retries discovery with backoff until the first success.
func (g *gateway) discoverUntilReady(ctx context.Context) {
	delay := time.Second
	for g.current.Load() == nil {
		err := g.refresh(ctx)
		if err == nil || ctx.Err() != nil {
			return
		}
		log.Printf("Schema discovery for %s failed, retrying in %s: %v", g.cfg.target, delay, err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		delay = min(delay*2, 15*time.Second)
	}
}

func (g *gateway) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/services", g.handleServices)
	mux.Handle("GET /api/metadata", g.withCatalog(func(c *catalog) http.Handler { return c.metadata }))
	mux.Handle("/api/invoke/", g.requireCSRF(serverTiming(g.limitTime(
		g.withCatalog(func(c *catalog) http.Handler { return c.invoke })))))
	mux.Handle("POST /api/reload", g.requireCSRF(http.HandlerFunc(g.handleReload)))
	mux.HandleFunc("GET /api/examples", g.handleExamples)
	mux.Handle("/api/", http.NotFoundHandler()) // never fall through to the SPA
	mux.HandleFunc("GET /healthz", g.handleHealth)
	mux.Handle("/", spaHandler())
	return g.ensureCSRFCookie(mux)
}

type unavailableBody struct {
	Status string `json:"status"`
	Target string `json:"target"`
	Error  string `json:"error,omitempty"`
}

func (g *gateway) unavailable(w http.ResponseWriter, code int) {
	body := unavailableBody{Status: "connecting", Target: g.cfg.target}
	if msg := g.lastErr.Load(); msg != nil {
		body.Error = *msg
	}
	writeJSON(w, code, body)
}

func (g *gateway) handleServices(w http.ResponseWriter, _ *http.Request) {
	c := g.current.Load()
	if c == nil {
		g.unavailable(w, http.StatusServiceUnavailable)
		return
	}
	writeRawJSON(w, http.StatusOK, c.servicesJSON)
}

func (g *gateway) handleReload(w http.ResponseWriter, r *http.Request) {
	if err := g.refresh(r.Context()); err != nil {
		log.Printf("Schema reload for %s failed: %v", g.cfg.target, err)
		g.unavailable(w, http.StatusBadGateway)
		return
	}
	writeRawJSON(w, http.StatusOK, g.current.Load().servicesJSON)
}

func (g *gateway) handleExamples(w http.ResponseWriter, _ *http.Request) {
	examples := g.cfg.examples
	if len(examples) == 0 {
		examples = []byte("[]")
	}
	writeRawJSON(w, http.StatusOK, examples)
}

func (g *gateway) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if g.current.Load() == nil {
		http.Error(w, "discovering schema", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok"))
}

// withCatalog serves via the current catalog, or 503 before discovery.
func (g *gateway) withCatalog(pick func(*catalog) http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := g.current.Load()
		if c == nil {
			g.unavailable(w, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		pick(c).ServeHTTP(w, r)
	})
}

// limitTime enforces -max-time on invocations.
func (g *gateway) limitTime(next http.Handler) http.Handler {
	if g.cfg.maxTime <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), g.cfg.maxTime)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// ensureCSRFCookie issues the double-submit token cookie (same scheme as
// upstream grpcui). It is readable by JS, which echoes it in a header.
func (g *gateway) ensureCSRFCookie(next http.Handler) http.Handler {
	cookiePath := strings.TrimSuffix(g.cfg.basePath, "/")
	if cookiePath == "" {
		cookiePath = "/"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := r.Cookie(csrfCookieName); err != nil {
			tokenBytes := make([]byte, 32)
			if _, err := rand.Read(tokenBytes); err != nil {
				http.Error(w, "failed to create CSRF token", http.StatusInternalServerError)
				return
			}
			http.SetCookie(w, &http.Cookie{
				Name:     csrfCookieName,
				Value:    base64.RawURLEncoding.EncodeToString(tokenBytes),
				Path:     cookiePath,
				SameSite: http.SameSiteStrictMode,
			})
		}
		next.ServeHTTP(w, r)
	})
}

func (g *gateway) requireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie(csrfCookieName)
		h := r.Header.Get(csrfHeaderName)
		if c == nil || c.Value == "" || c.Value != h {
			http.Error(w, "incorrect CSRF token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// serverTiming buffers the response so it can add a Server-Timing header with
// the time spent invoking the RPC. The upstream handler already builds the
// whole result in memory, so buffering costs nothing extra.
func serverTiming(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := &bufferedWriter{header: http.Header{}, code: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(buf, r)
		elapsed := time.Since(start)

		for k, v := range buf.header {
			w.Header()[k] = v
		}
		w.Header().Set("Server-Timing", fmt.Sprintf("grpc;dur=%.2f", float64(elapsed.Microseconds())/1000))
		w.WriteHeader(buf.code)
		_, _ = w.Write(buf.body.Bytes())
	})
}

type bufferedWriter struct {
	header http.Header
	code   int
	body   bytes.Buffer
}

func (b *bufferedWriter) Header() http.Header         { return b.header }
func (b *bufferedWriter) Write(p []byte) (int, error) { return b.body.Write(p) }
func (b *bufferedWriter) WriteHeader(code int)        { b.code = code }

func writeJSON(w http.ResponseWriter, code int, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeRawJSON(w, code, data)
}

func writeRawJSON(w http.ResponseWriter, code int, data []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_, _ = w.Write(data)
}

// ---- GET /api/services ----

type metadataPair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type methodInfo struct {
	Name            string `json:"name"`
	FullName        string `json:"fullName"`
	RequestType     string `json:"requestType"`
	ResponseType    string `json:"responseType"`
	ClientStreaming bool   `json:"clientStreaming"`
	ServerStreaming bool   `json:"serverStreaming"`
	Description     string `json:"description"`
	// Types lists the request, response and every message/enum they
	// reference (transitively), as keys into servicesResponse.Types.
	Types []string `json:"types"`
}

type serviceInfo struct {
	Name        string       `json:"name"`
	Package     string       `json:"package"`
	ShortName   string       `json:"shortName"`
	Description string       `json:"description"`
	Methods     []methodInfo `json:"methods"`
}

type servicesResponse struct {
	Target          string         `json:"target"`
	DefaultMetadata []metadataPair `json:"defaultMetadata"`
	Services        []serviceInfo  `json:"services"`
	// Types maps a fully-qualified message/enum name to its proto source.
	Types map[string]string `json:"types"`
}

var protoPrinter = protoprint.Printer{Compact: true, Indent: "   "}

// buildServices is the JSON counterpart of the data upstream's
// WebFormContentsWithOptions rendered into its HTML template.
func buildServices(target string, defaultMetadata []string, methods []*desc.MethodDescriptor) servicesResponse {
	resp := servicesResponse{
		Target:          target,
		DefaultMetadata: []metadataPair{},
		Services:        []serviceInfo{},
		Types:           map[string]string{},
	}
	for _, md := range defaultMetadata {
		name, value, _ := strings.Cut(md, ":")
		resp.DefaultMetadata = append(resp.DefaultMetadata, metadataPair{
			Name:  strings.TrimSpace(name),
			Value: strings.TrimLeftFunc(value, unicode.IsSpace),
		})
	}

	byService := map[string]*serviceInfo{}
	for _, md := range methods {
		sd := md.GetService()
		svc := byService[sd.GetFullyQualifiedName()]
		if svc == nil {
			svc = &serviceInfo{
				Name:        sd.GetFullyQualifiedName(),
				Package:     sd.GetFile().GetPackage(),
				ShortName:   sd.GetName(),
				Description: describeService(sd),
				Methods:     []methodInfo{},
			}
			byService[svc.Name] = svc
		}
		svc.Methods = append(svc.Methods, methodInfo{
			Name:            md.GetName(),
			FullName:        md.GetFullyQualifiedName(),
			RequestType:     md.GetInputType().GetFullyQualifiedName(),
			ResponseType:    md.GetOutputType().GetFullyQualifiedName(),
			ClientStreaming: md.IsClientStreaming(),
			ServerStreaming: md.IsServerStreaming(),
			Description:     describeMethod(md),
			Types:           relatedTypes(md, resp.Types),
		})
	}

	for _, svc := range byService {
		sort.Slice(svc.Methods, func(i, j int) bool { return svc.Methods[i].Name < svc.Methods[j].Name })
		resp.Services = append(resp.Services, *svc)
	}
	sort.Slice(resp.Services, func(i, j int) bool { return resp.Services[i].Name < resp.Services[j].Name })
	return resp
}

// describeMethod renders the method's proto source (with comments), indented
// to sit inside its service block.
func describeMethod(md *desc.MethodDescriptor) string {
	s, err := protoPrinter.PrintProtoToString(md)
	if err != nil {
		// generate simple description with no comments or options
		var reqStr, respStr string
		if md.IsClientStreaming() {
			reqStr = "stream "
		}
		if md.IsServerStreaming() {
			respStr = "stream "
		}
		return fmt.Sprintf("   rpc %s (%s%s) returns (%s%s);", md.GetName(), reqStr,
			md.GetInputType().GetFullyQualifiedName(), respStr, md.GetOutputType().GetFullyQualifiedName())
	}
	lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	for i := range lines {
		lines[i] = "   " + lines[i]
	}
	return strings.Join(lines, "\n")
}

// relatedTypes returns the request and response types of md plus every
// message and enum they reference, in breadth-first order, and adds their
// proto source to defs. Nested types are covered by their outermost listed
// parent, and google.protobuf well-known types are left out.
func relatedTypes(md *desc.MethodDescriptor, defs map[string]string) []string {
	var order []desc.Descriptor
	seen := map[string]bool{}
	visit := func(d desc.Descriptor) {
		if d == nil || seen[d.GetFullyQualifiedName()] || d.GetFile().GetPackage() == "google.protobuf" {
			return
		}
		seen[d.GetFullyQualifiedName()] = true
		order = append(order, d)
	}
	visit(md.GetInputType())
	visit(md.GetOutputType())
	for i := 0; i < len(order); i++ {
		msg, ok := order[i].(*desc.MessageDescriptor)
		if !ok {
			continue
		}
		var walk func(m *desc.MessageDescriptor)
		walk = func(m *desc.MessageDescriptor) {
			for _, fd := range m.GetFields() {
				if fd.GetMessageType() != nil {
					visit(fd.GetMessageType())
				} else if fd.GetEnumType() != nil {
					visit(fd.GetEnumType())
				}
			}
			// nested declarations are printed with their parent
			for _, nested := range m.GetNestedMessageTypes() {
				seen[nested.GetFullyQualifiedName()] = true
				walk(nested)
			}
			for _, nested := range m.GetNestedEnumTypes() {
				seen[nested.GetFullyQualifiedName()] = true
			}
		}
		walk(msg)
	}

	names := make([]string, 0, len(order))
	for _, d := range order {
		if hasListedAncestor(d, order) {
			continue
		}
		name := d.GetFullyQualifiedName()
		if _, ok := defs[name]; !ok {
			defs[name] = describeType(d)
		}
		names = append(names, name)
	}
	return names
}

// hasListedAncestor reports whether d is nested in a message that is printed
// in full, which already includes d's declaration.
func hasListedAncestor(d desc.Descriptor, order []desc.Descriptor) bool {
	for p := d.GetParent(); p != nil; p = p.GetParent() {
		if _, ok := p.(*desc.MessageDescriptor); !ok {
			return false
		}
		for _, o := range order {
			if o == p {
				return true
			}
		}
	}
	return false
}

// describeType renders a message or enum's proto source, with comments.
func describeType(d desc.Descriptor) string {
	s, err := protoPrinter.PrintProtoToString(d)
	if err != nil {
		return fmt.Sprintf("// %s: %v", d.GetFullyQualifiedName(), err)
	}
	return strings.TrimSuffix(s, "\n")
}

// describeService renders the service's comments and options, up to and
// including the opening brace (methods omitted).
func describeService(sd *desc.ServiceDescriptor) string {
	fallback := fmt.Sprintf("service %s {", sd.GetName())
	sb, err := builder.FromService(sd)
	if err != nil {
		return fallback
	}
	for _, md := range sd.GetMethods() {
		sb.RemoveMethod(md.GetName())
	}
	built, err := sb.Build()
	if err != nil {
		return fallback
	}
	s, err := protoPrinter.PrintProtoToString(built)
	if err != nil {
		return fallback
	}
	s = strings.TrimSuffix(s, "\n")
	return strings.TrimSuffix(s, "\n}")
}

// validateExamples checks that an -examples file is a JSON array of examples.
func validateExamples(data []byte) error {
	var examples []struct {
		Name    string `json:"name"`
		Service string `json:"service"`
		Method  string `json:"method"`
	}
	if err := json.Unmarshal(data, &examples); err != nil {
		return fmt.Errorf("failed to decode json to examples: %w", err)
	}
	return nil
}
