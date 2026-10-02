package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/fullstorydev/grpcurl"
	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/grpcreflect"
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/credentials"
	insecurecreds "google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/grpclog"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
)

// newClient creates a lazily-connecting client. Unlike upstream grpcui we do
// not block on dialing: under an orchestrator (e.g. .NET Aspire) the target
// often starts after the UI, so the UI must come up first and keep retrying.
func newClient(target string) (*grpc.ClientConn, error) {
	var creds credentials.TransportCredentials
	if *plaintext {
		creds = insecurecreds.NewCredentials()
	} else {
		tlsConf, err := grpcurl.ClientTLSConfig(*insecure, *cacert, *cert, *key)
		if err != nil {
			return nil, fmt.Errorf("failed to create TLS config: %w", err)
		}
		creds = credentials.NewTLS(tlsConf)
	}

	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(creds),
		// Reconnect quickly once the target comes (back) up; the default
		// backoff grows to two minutes, which is painful in a dev loop.
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff:           backoff.Config{BaseDelay: 500 * time.Millisecond, Multiplier: 1.6, Jitter: 0.2, MaxDelay: 5 * time.Second},
			MinConnectTimeout: 5 * time.Second,
		}),
		grpc.WithUserAgent("grpcui/" + version),
	}
	if override := firstNonEmpty(*authority, *serverName); override != "" && (!*plaintext || *authority != "") {
		opts = append(opts, grpc.WithAuthority(override))
	}
	if *keepaliveTime > 0 {
		timeout := floatSecondsToDuration(*keepaliveTime)
		opts = append(opts, grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: timeout, Timeout: timeout}))
	}
	if *maxMsgSz > 0 {
		opts = append(opts, grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(*maxMsgSz)))
	}

	if isUnixSocket != nil && isUnixSocket() {
		target = "unix:" + target
	} else if !strings.Contains(target, "://") {
		// match upstream grpcui, which dials host:port directly
		target = "passthrough:///" + target
	}
	return grpc.NewClient(target, opts...)
}

// discoverer returns a function that loads the exposed methods and all known
// files, from reflection and/or proto sources per the command-line flags.
func discoverer(cc *grpc.ClientConn) discoverFunc {
	return func(ctx context.Context) ([]*desc.MethodDescriptor, []*desc.FileDescriptor, error) {
		configs, err := computeSvcConfigs(services, methods)
		if err != nil {
			return nil, nil, err
		}

		var fileSource grpcurl.DescriptorSource
		switch {
		case len(protoset) > 0:
			fileSource, err = grpcurl.DescriptorSourceFromProtoSets(protoset...)
		case len(protoFiles) > 0:
			fileSource, err = grpcurl.DescriptorSourceFromProtoFiles(importPaths, protoFiles...)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("failed to process proto files: %w", err)
		}

		descSource := fileSource
		if reflection.val {
			md := grpcurl.MetadataFromHeaders(append(append([]string{}, addlHeaders...), reflHeaders...))
			refClient := grpcreflect.NewClientAuto(metadata.NewOutgoingContext(ctx, md), cc)
			refClient.AllowMissingFileDescriptors()
			defer refClient.Reset()
			reflSource := grpcurl.DescriptorSourceFromServer(ctx, refClient)
			if fileSource != nil {
				descSource = compositeSource{reflSource, fileSource}
			} else {
				descSource = reflSource
			}
		}

		ms, err := getMethods(descSource, configs)
		if err != nil {
			return nil, nil, err
		}
		files, err := grpcurl.GetAllFiles(descSource)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to enumerate all proto files: %w", err)
		}
		return ms, files, nil
	}
}

// compositeSource uses a file source as a fallback for resolving symbols and
// extensions, but only uses the reflection source for listing services.
type compositeSource struct {
	reflection grpcurl.DescriptorSource
	file       grpcurl.DescriptorSource
}

func (cs compositeSource) ListServices() ([]string, error) {
	return cs.reflection.ListServices()
}

func (cs compositeSource) FindSymbol(fullyQualifiedName string) (desc.Descriptor, error) {
	d, err := cs.reflection.FindSymbol(fullyQualifiedName)
	if err == nil {
		return d, nil
	}
	return cs.file.FindSymbol(fullyQualifiedName)
}

func (cs compositeSource) AllExtensionsForType(typeName string) ([]*desc.FieldDescriptor, error) {
	exts, err := cs.reflection.AllExtensionsForType(typeName)
	if err != nil {
		// On error fall back to file source
		return cs.file.AllExtensionsForType(typeName)
	}
	// Track the tag numbers from the reflection source
	tags := make(map[int32]bool)
	for _, ext := range exts {
		tags[ext.GetNumber()] = true
	}
	fileExts, err := cs.file.AllExtensionsForType(typeName)
	if err != nil {
		return exts, nil
	}
	for _, ext := range fileExts {
		// Prioritize extensions found via reflection
		if !tags[ext.GetNumber()] {
			exts = append(exts, ext)
		}
	}
	return exts, nil
}

type svcConfig struct {
	includeService bool
	includeMethods map[string]struct{}
}

func computeSvcConfigs(services, methods []string) (map[string]*svcConfig, error) {
	if len(services) == 0 && len(methods) == 0 {
		return nil, nil
	}
	configs := map[string]*svcConfig{}
	for _, svc := range services {
		configs[svc] = &svcConfig{
			includeService: true,
			includeMethods: map[string]struct{}{},
		}
	}
	for _, fqMethod := range methods {
		svc, method := splitMethodName(fqMethod)
		if svc == "" || method == "" {
			return nil, fmt.Errorf("could not parse name into service and method names: %q", fqMethod)
		}
		cfg := configs[svc]
		if cfg == nil {
			cfg = &svcConfig{includeMethods: map[string]struct{}{}}
			configs[svc] = cfg
		}
		cfg.includeMethods[method] = struct{}{}
	}
	return configs, nil
}

func splitMethodName(name string) (svc, method string) {
	sep := max(strings.LastIndex(name, "."), strings.LastIndex(name, "/"))
	if sep < 0 {
		return "", name
	}
	return name[:sep], name[sep+1:]
}

// getMethods lists the methods to expose. It consumes configs.
func getMethods(source grpcurl.DescriptorSource, configs map[string]*svcConfig) ([]*desc.MethodDescriptor, error) {
	servicesConfigured := len(configs) > 0
	allServices, err := source.ListServices()
	if err != nil {
		return nil, err
	}

	var descs []*desc.MethodDescriptor
	for _, svc := range allServices {
		if svc == "grpc.reflection.v1alpha.ServerReflection" || svc == "grpc.reflection.v1.ServerReflection" {
			continue
		}
		d, err := source.FindSymbol(svc)
		if err != nil {
			return nil, err
		}
		sd, ok := d.(*desc.ServiceDescriptor)
		if !ok {
			return nil, fmt.Errorf("%s should be a service descriptor but instead is a %T", d.GetFullyQualifiedName(), d)
		}
		cfg := configs[svc]
		if cfg == nil && servicesConfigured {
			// not configured to expose this service
			continue
		}
		delete(configs, svc)
		for _, md := range sd.GetMethods() {
			if cfg == nil {
				descs = append(descs, md)
				continue
			}
			_, found := cfg.includeMethods[md.GetName()]
			delete(cfg.includeMethods, md.GetName())
			if found || cfg.includeService {
				descs = append(descs, md)
			}
		}
		if cfg != nil && len(cfg.includeMethods) > 0 {
			// configured methods not found
			methodNames := make([]string, 0, len(cfg.includeMethods))
			for m := range cfg.includeMethods {
				methodNames = append(methodNames, fmt.Sprintf("%s/%s", svc, m))
			}
			sort.Strings(methodNames)
			return nil, fmt.Errorf("configured methods not found: %s", strings.Join(methodNames, ", "))
		}
	}

	if len(configs) > 0 {
		// configured services not found
		svcNames := make([]string, 0, len(configs))
		for s := range configs {
			svcNames = append(svcNames, s)
		}
		sort.Strings(svcNames)
		return nil, fmt.Errorf("configured services not found: %s", strings.Join(svcNames, ", "))
	}

	return descs, nil
}

func configureGRPCLogging(verbosity int) {
	switch {
	case verbosity == 1:
		// verbose will let grpc package print warnings and errors
		grpclog.SetLoggerV2(grpclog.NewLoggerV2(io.Discard, os.Stdout, io.Discard))
	case verbosity > 1:
		// very verbose will let grpc package log info
		// and very very verbose turns up the verbosity
		grpcVerbosity := 0
		if verbosity > 2 {
			grpcVerbosity = 5
		}
		grpclog.SetLoggerV2(grpclog.NewLoggerV2WithVerbosity(os.Stdout, io.Discard, io.Discard, grpcVerbosity))
	}
}

// logRequests logs one line per HTTP request (enabled with -v).
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s %s %d %dms %dbytes", r.RemoteAddr, r.Method, r.RequestURI, sw.code, time.Since(start).Milliseconds(), sw.size)
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
	size int
}

func (w *statusWriter) WriteHeader(code int) {
	w.code = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	n, err := w.ResponseWriter.Write(b)
	w.size += n
	return n, err
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
