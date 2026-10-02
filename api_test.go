package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jhump/protoreflect/desc"
	"google.golang.org/grpc"
	insecurecreds "google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	grpcreflection "google.golang.org/grpc/reflection"
)

// startTarget runs an in-process gRPC server exposing the health service
// (unary Check, server-streaming Watch) with reflection.
func startTarget(t *testing.T) *grpc.ClientConn {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	hs := health.NewServer()
	hs.SetServingStatus("orders", healthpb.HealthCheckResponse_SERVING)
	healthpb.RegisterHealthServer(srv, hs)
	grpcreflection.Register(srv)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	cc, err := grpc.NewClient("passthrough:///"+lis.Addr().String(),
		grpc.WithTransportCredentials(insecurecreds.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cc.Close() })
	return cc
}

type testClient struct {
	t    *testing.T
	base string
	http *http.Client
}

func newTestClient(t *testing.T, h http.Handler) *testClient {
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	return &testClient{t: t, base: srv.URL, http: &http.Client{Jar: jar}}
}

func (c *testClient) do(method, path, body string, csrf bool) (*http.Response, string) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if csrf {
		for _, ck := range c.http.Jar.Cookies(req.URL) {
			if ck.Name == csrfCookieName {
				req.Header.Set(csrfHeaderName, ck.Value)
			}
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, string(data)
}

func newTestGateway(cc *grpc.ClientConn, discover discoverFunc) *gateway {
	return newGateway(gatewayConfig{
		target:          "test-target:1234",
		conn:            cc,
		discover:        discover,
		discoverTimeout: 5 * time.Second,
		defaultMetadata: []string{"authorization: Bearer abc"},
		emitDefaults:    true,
		basePath:        "/",
	})
}

func TestGatewayEndToEnd(t *testing.T) {
	cc := startTarget(t)
	gw := newTestGateway(cc, discoverer(cc))
	c := newTestClient(t, gw.Handler())

	// Before discovery: 503 with a JSON status, and not healthy.
	resp, body := c.do("GET", "/api/services", "", false)
	if resp.StatusCode != http.StatusServiceUnavailable || !strings.Contains(body, `"connecting"`) {
		t.Fatalf("services before discovery: %d %s", resp.StatusCode, body)
	}
	if resp, _ := c.do("GET", "/healthz", "", false); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("healthz before discovery: %d", resp.StatusCode)
	}

	gw.discoverUntilReady(context.Background())

	if resp, body := c.do("GET", "/healthz", "", false); resp.StatusCode != http.StatusOK || body != "ok" {
		t.Fatalf("healthz: %d %s", resp.StatusCode, body)
	}

	// Services: reflection service hidden, health service with both methods.
	resp, body = c.do("GET", "/api/services", "", false)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("services: %d %s", resp.StatusCode, body)
	}
	var services servicesResponse
	if err := json.Unmarshal([]byte(body), &services); err != nil {
		t.Fatal(err)
	}
	if services.Target != "test-target:1234" || len(services.DefaultMetadata) != 1 ||
		services.DefaultMetadata[0] != (metadataPair{"authorization", "Bearer abc"}) {
		t.Fatalf("unexpected services header fields: %+v", services)
	}
	if len(services.Services) != 1 || services.Services[0].Name != "grpc.health.v1.Health" {
		t.Fatalf("unexpected services: %s", body)
	}
	svc := services.Services[0]
	if svc.Package != "grpc.health.v1" || svc.ShortName != "Health" || !strings.Contains(svc.Description, "service Health {") {
		t.Fatalf("unexpected service info: %+v", svc)
	}
	var watch *methodInfo
	for i := range svc.Methods {
		if svc.Methods[i].Name == "Watch" {
			watch = &svc.Methods[i]
		}
	}
	if watch == nil || !watch.ServerStreaming || watch.ClientStreaming ||
		watch.RequestType != "grpc.health.v1.HealthCheckRequest" || !strings.Contains(watch.Description, "rpc Watch") {
		t.Fatalf("unexpected Watch method: %+v", watch)
	}

	// Metadata (unchanged upstream format).
	resp, body = c.do("GET", "/api/metadata?method=grpc.health.v1.Health.Check", "", false)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"requestType": "grpc.health.v1.HealthCheckRequest"`) {
		t.Fatalf("metadata: %d %s", resp.StatusCode, body)
	}

	// Invoke without CSRF token is rejected.
	invokeBody := `{"metadata":[{"name":"x-test","value":"1"}],"data":[{"service":"orders"}]}`
	if resp, _ := c.do("POST", "/api/invoke/grpc.health.v1.Health.Check", invokeBody, false); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invoke without csrf: %d", resp.StatusCode)
	}

	// Successful unary call, with Server-Timing.
	resp, body = c.do("POST", "/api/invoke/grpc.health.v1.Health.Check", invokeBody, true)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"SERVING"`) || !strings.Contains(body, `"error": null`) {
		t.Fatalf("invoke: %d %s", resp.StatusCode, body)
	}
	if st := resp.Header.Get("Server-Timing"); !strings.HasPrefix(st, "grpc;dur=") {
		t.Fatalf("missing Server-Timing header, got %q", st)
	}

	// gRPC error is still HTTP 200 with error populated.
	resp, body = c.do("POST", "/api/invoke/grpc.health.v1.Health.Check", `{"data":[{"service":"nope"}]}`, true)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"code": 5`) || !strings.Contains(body, `"name": "NotFound"`) {
		t.Fatalf("invoke error: %d %s", resp.StatusCode, body)
	}

	// Reload requires CSRF and returns the services list.
	if resp, _ := c.do("POST", "/api/reload", "", false); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("reload without csrf: %d", resp.StatusCode)
	}
	if resp, body := c.do("POST", "/api/reload", "", true); resp.StatusCode != http.StatusOK || !strings.Contains(body, "grpc.health.v1.Health") {
		t.Fatalf("reload: %d %s", resp.StatusCode, body)
	}

	// Examples default to an empty array; unknown API paths are 404s.
	if _, body := c.do("GET", "/api/examples", "", false); body != "[]" {
		t.Fatalf("examples: %s", body)
	}
	if resp, _ := c.do("GET", "/api/nope", "", false); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api path: %d", resp.StatusCode)
	}
}

func TestDiscoveryRetriesUntilReady(t *testing.T) {
	cc := startTarget(t)
	attempts := 0
	real := discoverer(cc)
	gw := newTestGateway(cc, func(ctx context.Context) ([]*desc.MethodDescriptor, []*desc.FileDescriptor, error) {
		attempts++
		if attempts < 2 {
			return nil, nil, errors.New("rpc error: code = Unavailable desc = connection refused")
		}
		return real(ctx)
	})
	c := newTestClient(t, gw.Handler())

	_ = gw.refresh(context.Background()) // first attempt fails
	if _, body := c.do("GET", "/api/services", "", false); !strings.Contains(body, "connection refused") {
		t.Fatalf("expected last error in 503 body, got %s", body)
	}
	gw.discoverUntilReady(context.Background())
	if resp, _ := c.do("GET", "/api/services", "", false); resp.StatusCode != http.StatusOK {
		t.Fatalf("services after retry: %d", resp.StatusCode)
	}
}

func TestSPA(t *testing.T) {
	c := newTestClient(t, newTestGateway(nil, nil).Handler())

	resp, body := c.do("GET", "/", "", false)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `<div id="root">`) {
		t.Fatalf("index: %d", resp.StatusCode)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("index Cache-Control = %q", cc)
	}
	// every response sets the CSRF cookie (path "/") when missing
	var found bool
	for _, ck := range resp.Cookies() {
		found = found || (ck.Name == csrfCookieName && ck.Path == "/")
	}
	if !found {
		t.Fatal("CSRF cookie not set")
	}
	if resp, _ := c.do("GET", "/some/route", "", false); resp.StatusCode != http.StatusOK {
		t.Fatalf("SPA fallback: %d", resp.StatusCode)
	}
	if resp, _ := c.do("GET", "/missing.js", "", false); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing asset: %d", resp.StatusCode)
	}
}

func TestNormalizeTarget(t *testing.T) {
	cases := []struct {
		in, want      string
		wantPlaintext bool
	}{
		{"api:5000", "api:5000", false},
		{"http://api:8080", "api:8080", true},
		{"http://localhost", "localhost:80", true},
		{"https://api:7001/", "api:7001", false},
	}
	for _, tc := range cases {
		*plaintext = false
		got, err := normalizeTarget(tc.in, map[string]bool{})
		if err != nil || got != tc.want || *plaintext != tc.wantPlaintext {
			t.Errorf("normalizeTarget(%q) = %q, plaintext=%v, err=%v", tc.in, got, *plaintext, err)
		}
	}
	*plaintext = true
	if _, err := normalizeTarget("https://api:7001", map[string]bool{"plaintext": true}); err == nil {
		t.Error("expected https:// with -plaintext to fail")
	}
	*plaintext = false
}

func TestApplyEnv(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	plain := fs.Bool("plaintext", false, "")
	var hdrs multiString
	fs.Var(&hdrs, "rpc-header", "")
	t.Setenv("GRPCUI_PLAINTEXT", "true")
	t.Setenv("GRPCUI_RPC_HEADER", "a: 1\nb: 2")
	if err := applyEnv(fs); err != nil {
		t.Fatal(err)
	}
	if !*plain || len(hdrs) != 2 || hdrs[1] != "b: 2" {
		t.Fatalf("plaintext=%v headers=%v", *plain, hdrs)
	}
}
