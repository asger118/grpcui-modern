// Command grpcui serves a modern web UI for invoking gRPC methods. It is a
// drop-in replacement for fullstorydev/grpcui: it accepts the same flags and
// reuses its reflection and invocation handlers, but serves an embedded React
// SPA backed by a JSON API (see docs/API.md).
//
// Every flag can also be supplied as an environment variable named
// GRPCUI_<FLAG> (upper case, dashes as underscores), e.g. GRPCUI_PLAINTEXT=true.
// The target may be given as the positional argument or GRPCUI_TARGET, and the
// listen port defaults to $PORT, then 8080.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/fullstorydev/grpcurl"
	"github.com/pkg/browser"
	"golang.org/x/term"

	// Register gzip compressor so compressed responses will work
	_ "google.golang.org/grpc/encoding/gzip"
)

var version = "dev"

var (
	isUnixSocket func() bool // nil when run on non-unix platform

	flags = flag.NewFlagSet(os.Args[0], flag.ExitOnError)

	help         = flags.Bool("help", false, "Print usage instructions and exit.")
	printVersion = flags.Bool("version", false, "Print version.")

	plaintext = flags.Bool("plaintext", false, prettify(`
		Use plain-text HTTP/2 when connecting to server (no TLS). Implied when
		the target is given as an http:// URL.`))
	insecure = flags.Bool("insecure", false, prettify(`
		Skip server certificate and domain verification. (NOT SECURE!) Not
		valid with -plaintext option.`))
	cacert = flags.String("cacert", "", prettify(`
		File containing trusted root certificates for verifying the server.
		Ignored if -insecure is specified.`))
	cert = flags.String("cert", "", prettify(`
		File containing client certificate (public key), to present to the
		server. Not valid with -plaintext option. Must also provide -key option.`))
	key = flags.String("key", "", prettify(`
		File containing client private key, to present to the server. Not valid
		with -plaintext option. Must also provide -cert option.`))
	expandHeaders = flags.Bool("expand-headers", false, prettify(`
		If set, headers may use '${NAME}' syntax to reference environment
		variables. These will be replaced at runtime with the values of the
		environment variables.`))
	authority = flags.String("authority", "", prettify(`
		The authoritative name of the remote server. This value is passed as the
		value of the ":authority" pseudo-header in the HTTP/2 protocol. When TLS
		is used, this will also be used as the server name when verifying the
		server's certificate.`))
	serverName = flags.String("servername", "", prettify(`
		Override server name when validating TLS certificate. This flag is
		ignored if -plaintext or -insecure is used. Prefer -authority.`))
	connectTimeout = flags.Float64("connect-timeout", 0, prettify(`
		The maximum time, in seconds, to wait for each schema discovery attempt
		(reflection) to complete. Defaults to 10 seconds.`))
	_ = flags.Bool("connect-fail-fast", true, prettify(`
		Accepted for compatibility. The connection is established lazily and
		schema discovery is retried until the server is reachable.`))
	keepaliveTime = flags.Float64("keepalive-time", 0, prettify(`
		If present, the maximum idle time in seconds, after which a keepalive
		probe is sent.`))
	maxTime = flags.Float64("max-time", 0, prettify(`
		The maximum total time, in seconds, that an RPC invocation may take.`))
	maxMsgSz = flags.Int("max-msg-sz", 0, prettify(`
		The maximum encoded size of a message that grpcui will accept. If not
		specified, defaults to 4,194,304 (4 megabytes).`))
	emitDefaults = flags.Bool("emit-defaults", true, prettify(`
		Emit default values for JSON-encoded responses.`))
	verbose         = flags.Bool("v", false, "Enable verbose output.")
	veryVerbose     = flags.Bool("vv", false, "Enable very verbose output.")
	veryVeryVerbose = flags.Bool("vvv", false, "Enable the most verbose output.")
	openBrowser     = flags.Bool("open-browser", false, prettify(`
		When true, grpcui will try to open a browser pointed at the UI's URL.
		Defaults to true when stdin is a terminal.`))
	examplesFile = flags.String("examples", "", prettify(`
		Load examples from the given JSON file. The examples are shown in the
		UI and can be loaded into the request editor.`))
	port = flags.Int("port", defaultPort(), prettify(`
		The port on which the web UI is exposed. Defaults to $PORT, else 8080.
		Use 0 for a random port.`))
	bind = flags.String("bind", "127.0.0.1", prettify(`
		The address on which the web UI is exposed. Use 0.0.0.0 to listen on
		all interfaces (the container image sets this).`))
	basePath = flags.String("base-path", "/", prettify(`
		The base URI path at which the UI is served, for use behind a reverse
		proxy that forwards a sub-path.`))

	addlHeaders  multiString
	rpcHeaders   multiString
	reflHeaders  multiString
	prsvHeaders  multiString
	defHeaders   multiString
	protoset     multiString
	protoFiles   multiString
	importPaths  multiString
	services     multiString
	methods      multiString
	reflection   = optionalBoolFlag{val: true}
	legacyAssets multiString
	legacyDebug  optionalBoolFlag
)

func init() {
	flags.Var(&addlHeaders, "H", prettify(`
		Additional headers in 'name: value' format. May specify more than one
		via multiple flags. These headers will also be included in reflection
		requests to a server. These headers are not shown in the UI but are
		sent with all RPCs.`))
	flags.Var(&rpcHeaders, "rpc-header", prettify(`
		Additional RPC headers in 'name: value' format. May specify more than
		one via multiple flags. These headers will *only* be used when invoking
		the requested RPC method. They are excluded from reflection requests.`))
	flags.Var(&reflHeaders, "reflect-header", prettify(`
		Additional reflection headers in 'name: value' format. May specify more
		than one via multiple flags. These headers will *only* be used during
		reflection requests and will be excluded when invoking RPCs.`))
	flags.Var(&prsvHeaders, "preserve-header", prettify(`
		Header names (no values) for request headers that should be preserved
		when making requests to the gRPC server. May specify more than one via
		multiple flags. The UI's own HTTP request headers with these names are
		forwarded as RPC metadata.`))
	flags.Var(&defHeaders, "default-header", prettify(`
		Default metadata in 'name: value' format, pre-filled in the UI's
		metadata table. May specify more than one via multiple flags.`))
	flags.Var(&protoset, "protoset", prettify(`
		The name of a file containing an encoded FileDescriptorSet. May specify
		more than one via multiple -protoset flags. It is an error to use both
		-protoset and -proto flags.`))
	flags.Var(&protoFiles, "proto", prettify(`
		The name of a proto source file. Imports will be resolved using the
		given -import-path flags. May specify more than one via multiple -proto
		flags. It is an error to use both -protoset and -proto flags.`))
	flags.Var(&importPaths, "import-path", prettify(`
		The path to a directory from which proto sources can be imported, for
		use with -proto flags. Multiple import paths can be configured by
		specifying multiple -import-path flags.`))
	flags.Var(&services, "service", prettify(`
		The fully-qualified name of a service to expose. May specify more than
		one via multiple flags. If unset, all services are exposed.`))
	flags.Var(&methods, "method", prettify(`
		The fully-qualified name of a method to expose, in 'Service/Method' or
		'Service.Method' form. May specify more than one via multiple flags.`))
	flags.Var(&reflection, "use-reflection", prettify(`
		When true, server reflection will be used to determine the RPC schema.
		Defaults to true unless a -proto or -protoset option is provided.`))
	for _, name := range []string{"extra-js", "extra-css", "also-serve"} {
		flags.Var(&legacyAssets, name, "Ignored: only supported by the legacy jQuery UI.")
	}
	flags.Var(&legacyDebug, "debug-client", "Ignored: only supported by the legacy jQuery UI.")
}

func main() {
	flags.Usage = usage
	if err := applyEnv(flags); err != nil {
		fail(err, "Invalid GRPCUI_* environment variable")
	}
	if term.IsTerminal(int(os.Stdin.Fd())) && os.Getenv("GRPCUI_OPEN_BROWSER") == "" {
		*openBrowser = true
	}
	_ = flags.Parse(os.Args[1:])
	explicit := map[string]bool{}
	flags.Visit(func(f *flag.Flag) { explicit[f.Name] = true })

	if *help {
		usage()
		os.Exit(0)
	}
	if *printVersion {
		fmt.Fprintf(os.Stderr, "%s %s\n", os.Args[0], version)
		os.Exit(0)
	}
	if len(legacyAssets) > 0 || legacyDebug.set {
		warn("-extra-js, -extra-css, -also-serve and -debug-client only apply to the legacy UI and are ignored.")
	}

	target := os.Getenv("GRPCUI_TARGET")
	switch {
	case flags.NArg() == 1:
		target = flags.Arg(0)
	case flags.NArg() > 1:
		fail(nil, "This program accepts at most one arg: the host:port of the gRPC server.")
	case target == "":
		fail(nil, "No target given: pass the host:port of the gRPC server as an argument or set GRPCUI_TARGET.")
	}
	target, err := normalizeTarget(target, explicit)
	if err != nil {
		fail(nil, "%v", err)
	}

	// Validate arguments (same rules as upstream grpcui).
	if *connectTimeout < 0 {
		fail(nil, "The -connect-timeout argument must not be negative.")
	}
	if *keepaliveTime < 0 {
		fail(nil, "The -keepalive-time argument must not be negative.")
	}
	if *maxTime < 0 {
		fail(nil, "The -max-time argument must not be negative.")
	}
	if *maxMsgSz < 0 {
		fail(nil, "The -max-msg-sz argument must not be negative.")
	}
	if *plaintext && *insecure {
		fail(nil, "The -plaintext and -insecure arguments are mutually exclusive.")
	}
	if *plaintext && *cert != "" {
		fail(nil, "The -plaintext and -cert arguments are mutually exclusive.")
	}
	if *plaintext && *key != "" {
		fail(nil, "The -plaintext and -key arguments are mutually exclusive.")
	}
	if (*key == "") != (*cert == "") {
		fail(nil, "The -cert and -key arguments must be used together and both be present.")
	}
	if *serverName != "" && *authority != "" && *serverName != *authority {
		fail(nil, "Cannot specify different values for -servername and -authority.")
	}
	if len(protoset) > 0 && len(reflHeaders) > 0 {
		warn("The -reflect-header argument is not used when -protoset files are used.")
	}
	if len(protoset) > 0 && len(protoFiles) > 0 {
		fail(nil, "Use either -protoset files or -proto files, but not both.")
	}
	if len(importPaths) > 0 && len(protoFiles) == 0 {
		warn("The -import-path argument is not used unless -proto files are used.")
	}
	// Protoset or proto files provided and -use-reflection unset
	if !reflection.set && (len(protoset) > 0 || len(protoFiles) > 0) {
		reflection.val = false
	}
	if !reflection.val && len(protoset) == 0 && len(protoFiles) == 0 {
		fail(nil, "No protoset files or proto files specified and -use-reflection set to false.")
	}
	if !strings.HasPrefix(*basePath, "/") {
		fail(nil, `The -base-path must begin with a slash ("/")`)
	}
	if _, err := computeSvcConfigs(services, methods); err != nil {
		fail(err, "Invalid services/methods indicated")
	}

	verbosity := 0
	switch {
	case *veryVeryVerbose:
		verbosity = 3
	case *veryVerbose:
		verbosity = 2
	case *verbose:
		verbosity = 1
	}
	configureGRPCLogging(verbosity)

	if *expandHeaders {
		for _, hdrs := range []*multiString{&addlHeaders, &rpcHeaders, &reflHeaders, &defHeaders} {
			expanded, err := grpcurl.ExpandHeaders(*hdrs)
			if err != nil {
				fail(err, "Failed to expand headers")
			}
			*hdrs = expanded
		}
	}

	var examples []byte
	if *examplesFile != "" {
		if examples, err = loadExamples(*examplesFile); err != nil {
			fail(err, "Failed to load examples from %q", *examplesFile)
		}
	}

	cc, err := newClient(target)
	if err != nil {
		fail(err, "Failed to create client for target %q", target)
	}
	defer cc.Close()

	discoverTimeout := 10 * time.Second
	if *connectTimeout > 0 {
		discoverTimeout = floatSecondsToDuration(*connectTimeout)
	}
	gw := newGateway(gatewayConfig{
		target:          target,
		conn:            cc,
		discover:        discoverer(cc),
		discoverTimeout: discoverTimeout,
		defaultMetadata: defHeaders,
		extraMetadata:   append(append([]string{}, addlHeaders...), rpcHeaders...),
		preserveHeaders: prsvHeaders,
		emitDefaults:    *emitDefaults,
		verbosity:       verbosity,
		maxTime:         floatSecondsToDuration(*maxTime),
		examples:        examples,
		basePath:        *basePath,
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go gw.discoverUntilReady(ctx)

	var handler http.Handler = gw.Handler()
	if verbosity > 0 {
		handler = logRequests(handler)
	}
	if *basePath != "/" {
		withoutSlash := strings.TrimSuffix(*basePath, "/")
		mux := http.NewServeMux()
		// the mux will correctly redirect the bare path (without trailing slash)
		mux.Handle(withoutSlash+"/", http.StripPrefix(withoutSlash, handler))
		handler = mux
	}

	listener, err := net.Listen("tcp", net.JoinHostPort(*bind, strconv.Itoa(*port)))
	if err != nil {
		fail(err, "Failed to listen on port %d", *port)
	}
	uiPath := strings.TrimSuffix(*basePath, "/") + "/"
	uiURL := fmt.Sprintf("http://%s%s", listener.Addr().String(), uiPath)
	log.Printf("gRPC Web UI for %s available at %s", target, uiURL)

	if *openBrowser {
		go func() {
			if err := browser.OpenURL(uiURL); err != nil {
				warn("Failed to open browser: %v", err)
			}
		}()
	}

	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail(err, "Failed to serve web UI")
	}
}

// normalizeTarget accepts "host:port" or a URL such as the ones .NET Aspire
// endpoint references produce ("http://api:8080"). An http:// scheme implies
// -plaintext unless TLS options were set explicitly.
func normalizeTarget(target string, explicit map[string]bool) (string, error) {
	scheme, rest, found := strings.Cut(target, "://")
	if !found || (scheme != "http" && scheme != "https") {
		return target, nil
	}
	u, err := url.Parse(target)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("invalid target URL %q", target)
	}
	if u.Path != "" && u.Path != "/" {
		warn("Ignoring path %q in target %q; gRPC targets are host:port.", u.Path, rest)
	}
	host := u.Host
	if u.Port() == "" {
		if scheme == "http" {
			host = net.JoinHostPort(u.Hostname(), "80")
		} else {
			host = net.JoinHostPort(u.Hostname(), "443")
		}
	}
	switch {
	case scheme == "https" && *plaintext:
		return "", fmt.Errorf("target %q uses https:// but -plaintext was given", target)
	case scheme == "http" && !explicit["plaintext"] && !*insecure && *cacert == "" && *cert == "":
		*plaintext = true
	}
	return host, nil
}

// applyEnv sets flags from GRPCUI_<NAME> environment variables. It runs before
// command-line parsing, so explicit flags still win (repeatable flags such as
// -H accumulate both; separate multiple env values with newlines).
func applyEnv(fs *flag.FlagSet) error {
	var errs []error
	fs.VisitAll(func(f *flag.Flag) {
		name := "GRPCUI_" + strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))
		val, ok := os.LookupEnv(name)
		if !ok || val == "" {
			return
		}
		values := []string{val}
		if _, repeatable := f.Value.(*multiString); repeatable {
			values = strings.Split(strings.ReplaceAll(val, "\r\n", "\n"), "\n")
		}
		for _, v := range values {
			if v = strings.TrimSpace(v); v == "" {
				continue
			}
			if err := fs.Set(f.Name, v); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", name, err))
			}
		}
	})
	return errors.Join(errs...)
}

func defaultPort() int {
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil {
		return p
	}
	return 8080
}

func loadExamples(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := validateExamples(data); err != nil {
		return nil, err
	}
	return data, nil
}

func floatSecondsToDuration(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

func usage() {
	fmt.Fprintf(os.Stderr, `Usage:
	%s [flags] [address]

Starts a web server that hosts a web UI for sending RPCs to the given address.

The address will typically be in the form "host:port". It may also be an
http:// or https:// URL (http implies -plaintext). If omitted, GRPCUI_TARGET is
used. For Unix variants, if a -unix=true flag is present, then the address must
be the path to the domain socket.

Every flag may also be set via an environment variable named GRPCUI_<FLAG>,
e.g. GRPCUI_PLAINTEXT=true or GRPCUI_RPC_HEADER="authorization: Bearer x".

Available flags:
`, os.Args[0])
	flags.PrintDefaults()
}

func prettify(docString string) string {
	parts := strings.Split(docString, "\n")
	j := 0
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		parts[j] = part
		j++
	}
	return strings.Join(parts[:j], "\n")
}

func warn(msg string, args ...any) {
	fmt.Fprintf(os.Stderr, "Warning: "+msg+"\n", args...)
}

func fail(err error, msg string, args ...any) {
	if err != nil {
		msg += ": %v"
		args = append(args, err)
	}
	fmt.Fprintf(os.Stderr, msg+"\n", args...)
	if err != nil {
		os.Exit(1)
	}
	// nil error means it was a CLI usage issue
	fmt.Fprintf(os.Stderr, "Try '%s -help' for more details.\n", os.Args[0])
	os.Exit(2)
}

type multiString []string

func (s *multiString) String() string {
	return strings.Join(*s, ",")
}

func (s *multiString) Set(value string) error {
	*s = append(*s, value)
	return nil
}

type optionalBoolFlag struct {
	set, val bool
}

func (f *optionalBoolFlag) String() string {
	if !f.set {
		return "unset"
	}
	return strconv.FormatBool(f.val)
}

func (f *optionalBoolFlag) Set(s string) error {
	v, err := strconv.ParseBool(s)
	if err != nil {
		return err
	}
	f.set = true
	f.val = v
	return nil
}

func (f *optionalBoolFlag) IsBoolFlag() bool {
	return true
}
