# grpcui-modern — Backend ⇄ Frontend API Contract

All endpoints live under `api/` and are requested with **relative URLs** (no
leading slash) so the UI keeps working behind a reverse proxy / `-base-path`.
TypeScript mirrors of every shape live in `frontend/src/api/types.ts`.

| Method | Path                         | Source                                    | Status   |
|--------|------------------------------|-------------------------------------------|----------|
| GET    | `api/services`               | new — replaces `WebFormContentsWithOptions` template data | **new**  |
| GET    | `api/metadata?method={fqn}`  | `grpcui.RPCMetadataHandler`               | reused   |
| GET    | `api/metadata?method=*`      | `grpcui.RPCMetadataHandler` (all types, for `Any`) | reused |
| POST   | `api/invoke/{fqn}`           | `grpcui.RPCInvokeHandlerWithOptions` + CSRF wrapper | reused |
| GET    | `api/examples`               | `standalone` examples                     | reused   |
| POST   | `api/reload`                 | new — re-run schema discovery             | **new**  |
| GET    | `healthz`                    | new — readiness for Aspire / Docker       | **new**  |
| GET    | `/*`                         | embedded SPA (`go:embed`), fallback to `index.html` | new |

`{fqn}` is always the fully-qualified method name, e.g. `acme.orders.v1.OrderService.GetOrder`.

---

## 1. `GET api/services` (new)

Replaces the data previously baked into the HTML template (`Services`,
`Methods`, `SvcDescs`, `MtdDescs`, `Target`, `DefaultMetadata`). Built once at
startup from the same `[]*desc.MethodDescriptor`. Services and methods are sorted.

```json
{
  "target": "orders-api:5001",
  "defaultMetadata": [ { "name": "authorization", "value": "Bearer ..." } ],
  "services": [
    {
      "name": "acme.orders.v1.OrderService",
      "package": "acme.orders.v1",
      "shortName": "OrderService",
      "description": "// Manages orders.\nservice OrderService {",
      "methods": [
        {
          "name": "GetOrder",
          "fullName": "acme.orders.v1.OrderService.GetOrder",
          "requestType": "acme.orders.v1.GetOrderRequest",
          "responseType": "acme.orders.v1.Order",
          "clientStreaming": false,
          "serverStreaming": false,
          "description": "   rpc GetOrder ( .acme.orders.v1.GetOrderRequest ) returns ( .acme.orders.v1.Order );",
          "types": [ "acme.orders.v1.GetOrderRequest", "acme.orders.v1.Order", "acme.orders.v1.Status" ]
        }
      ]
    }
  ],
  "types": {
    "acme.orders.v1.Status": "enum Status {
   STATUS_UNSPECIFIED = 0;
   SHIPPED = 1;
}"
  }
}
```

`description` is the proto-source snippet (with comments) produced by `protoprint`, same as today.

`methods[].types` lists the request type, the response type, and every message or enum they
reference (transitively, breadth-first), as keys into the top-level `types` map of proto source.
The Definition tab renders these after the rpc. Nested types are printed inside their outermost listed
parent and are not listed separately. `google.protobuf.*` types are omitted.

**Before discovery has succeeded** (the target is not up yet, or reflection
fails), this and the other `api/*` schema/invoke endpoints return
`503` with a JSON body. The gateway keeps retrying (1s → 15s backoff); the UI
polls and shows the last error:

```json
{ "status": "connecting", "target": "orders-api:5001", "error": "rpc error: code = Unavailable desc = ..." }
```

## 2. `GET api/metadata?method={fqn}` (unchanged wire format)

Returns the request schema, used by Form mode and to generate the sample JSON.
`method=*` returns every known message/enum (`requestType` empty), used for
`google.protobuf.Any` type pickers.

```json
{
  "requestType": "acme.orders.v1.GetOrderRequest",
  "requestStream": false,
  "messageTypes": {
    "acme.orders.v1.GetOrderRequest": [
      { "name": "orderId", "protoName": "order_id", "type": "string",
        "oneOfFields": null, "isMessage": false, "isEnum": false,
        "isArray": false, "isMap": false, "isRequired": false,
        "defaultVal": "", "description": "string order_id = 1;" },
      { "name": "lookup", "type": "oneof", "oneOfFields": [ /* FieldDef[] */ ], ... }
    ]
  },
  "enumTypes": {
    "acme.orders.v1.Status": [ { "num": 0, "name": "STATUS_UNSPECIFIED" } ]
  }
}
```

Field semantics the form generator must honour:

- `type` is a scalar name (`string`, `int64`, `bool`, `bytes`, …), the
  fully-qualified name of a message/enum, or `"oneof"`.
- `type: "oneof"` → a group; choices are in `oneOfFields`; at most one may be set.
  Its `name` is the oneof name and **is not** a JSON key.
- `isMap: true` → `type` is the synthetic `…Entry` message, which has `key` and
  `value` fields. In JSON it's an object (`{ "k": v }`).
- `isArray: true` → JSON array of `type`.
- Recursive messages are possible (the schema is a graph). Expand them lazily, don't recurse eagerly.
- 64-bit ints are **strings** in JSON. `bytes` are **base64** strings.
- Well-known types need dedicated widgets/JSON forms: `Timestamp` (RFC 3339
  string), `Duration` (`"1.5s"`), wrappers (`StringValue` etc. → bare scalar),
  `Struct`/`Value`/`ListValue` (free JSON), `Any` (`{"@type": "type.googleapis.com/x.Y", ...}`), `FieldMask` (`"a.b,c"`), `Empty` (`{}`).
- Use `name` (lowerCamel JSON name) as the key in generated JSON. The server
  accepts `protoName` too, but **responses come back with `protoName`**
  (`OrigName: true`). Don't assume request and response keys match.

Errors: `405` for a non-GET request, `422 text/plain` for an unknown method.

## 3. `POST api/invoke/{fqn}` (unchanged wire format)

**Request headers (strict):**
- `Content-Type: application/json`. Must be exactly this value; `;charset=utf-8` returns 415.
- `x-grpcui-csrf-token: <value of _grpcui_csrf_token cookie>`. The cookie is set
  (non-HttpOnly) on the first response from any endpoint, so call
  `api/services` before invoking.

**Request body:**
```json
{
  "timeout_seconds": 10,
  "metadata": [ { "name": "authorization", "value": "Bearer abc" } ],
  "data": [ { "orderId": "42" } ]
}
```
- `data` is **always an array**. Unary or server-streaming methods take exactly one element.
  Client- and bidi-streaming methods take N elements, sent in order, then the stream is half-closed.
- `timeout_seconds` ≤ 0 or omitted means no deadline.
- Server-side `-rpc-header` / `-H` / `-preserve-header` values override matching keys in `metadata`.

**Response, HTTP 200** (returned for every completed RPC, **including gRPC errors**):
```json
{
  "headers":  [ { "name": "content-type", "value": "application/grpc" } ],
  "responses": [ { "message": { "order_id": "42", "status": "SHIPPED" }, "isError": false } ],
  "requests": { "total": 1, "sent": 1 },
  "trailers": [ { "name": "x-request-id", "value": "..." } ],
  "error": null
}
```
When the RPC fails, `error` is populated and `responses` may be `null` or partial:
```json
"error": {
  "code": 5, "name": "NotFound", "message": "order 42 not found",
  "details": [ { "message": { "@type": "type.googleapis.com/google.rpc.ErrorInfo", ... }, "isError": false } ]
}
```
- `error == null` means status `0 OK`. The UI builds the OK badge itself.
- `name` uses Go's `codes.Code.String()` format (`NotFound`, `DeadlineExceeded`), not `NOT_FOUND`.
- `responses[i].isError: true` → `message` is a JSON *string* with a marshal error, not a proto message.
- Metadata keys ending in `-bin` have base64 values.
- `requests.sent < requests.total` → server closed the stream early. Show a warning.
- Server-streaming results are **buffered** until the RPC completes. They are not streamed live (known limitation of the reused handler).

**Transport failures, `text/plain` body:**

| HTTP | Meaning |
|------|---------|
| 400  | request body is not valid JSON |
| 401  | CSRF token missing/mismatch |
| 404  | unknown method |
| 415  | wrong `Content-Type` |
| 499  | failed reading request body |
| 500  | `Unexpected error: …`. Includes a `data[i]` that doesn't match the message type on unary calls (`… code = InvalidArgument desc = …`; streaming calls report this as a gRPC error instead) and descriptor failures. The UI extracts `code = X desc = Y` when present. |

**Timing (new, additive):** the Go wrapper buffers the handler output and sets
`Server-Timing: grpc;dur=<ms>` (time spent in the gRPC call, excluding browser
↔ gateway overhead). The UI shows this value and falls back to client-measured
`performance.now()` deltas.

## 4. `GET api/examples` (unchanged)

`Example[]` from `-examples file.json`; `[]` when none. Note the field is
`timeout_secs` here but `timeout_seconds` in invoke requests, an upstream inconsistency.

```json
[ { "name": "Get order 42", "description": "", "service": "acme.orders.v1.OrderService",
    "method": "GetOrder",
    "request": { "timeout_secs": 5, "metadata": [], "data": { "orderId": "42" } } } ]
```

## 5. `POST api/reload` (new)

Re-runs schema discovery (e.g. after the target was redeployed with new
protos) and returns the new `api/services` body. Requires the CSRF header.
On failure it returns `502` with the same JSON shape as the 503 above, and the
previously discovered schema stays in use.

## 6. `GET healthz` (new)

`200 ok` once schema discovery has succeeded, `503` before. Used for Aspire `WithHttpHealthCheck("/healthz")`.

---

## Backend

`api.go` (gateway, handlers), `connect.go` (client, discovery), `web.go`
(`//go:embed all:frontend/dist`, SPA serving), `main.go` (flags). The
upstream handlers come from `./grpcui-old` via a `replace` directive.

Configuration:

- All upstream `grpcui` flags are kept (`-plaintext`, `-insecure`, `-cacert`,
  `-H`, `-rpc-header`, `-use-reflection`, `-protoset`, `-examples`, …). The
  legacy-UI-only `-extra-js`, `-extra-css`, `-also-serve` and `-debug-client`
  are accepted and ignored.
- Any flag can be set as `GRPCUI_<FLAG>` (`GRPCUI_PLAINTEXT=true`,
  `GRPCUI_RPC_HEADER="authorization: Bearer x"`; newline-separate repeated
  values). Command-line flags win.
- Target: positional argument or `GRPCUI_TARGET`. `host:port`, or an
  `http://` / `https://` URL as produced by Aspire endpoint references
  (`http://` implies `-plaintext`).
- `-port` defaults to `$PORT`, else 8080. `-bind` defaults to `127.0.0.1`
  (the container sets `GRPCUI_BIND=0.0.0.0`).
- The gRPC connection is lazy and reconnects with a 5s max backoff, so the
  UI can start before its target.
