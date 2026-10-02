import type { FieldDef, ScalarType, Schema } from "../api/types";

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---- Well-known types ----

const WRAPPERS: Record<string, ScalarType> = {
  "google.protobuf.DoubleValue": "double",
  "google.protobuf.FloatValue": "float",
  "google.protobuf.Int64Value": "int64",
  "google.protobuf.UInt64Value": "uint64",
  "google.protobuf.Int32Value": "int32",
  "google.protobuf.UInt32Value": "uint32",
  "google.protobuf.BoolValue": "bool",
  "google.protobuf.StringValue": "string",
  "google.protobuf.BytesValue": "bytes",
};

export type WellKnownKind =
  | { kind: "timestamp" }
  | { kind: "duration" }
  | { kind: "fieldmask" }
  | { kind: "empty" }
  | { kind: "json"; hint: string; sample: unknown } // Struct, Value, ListValue, Any
  | { kind: "wrapper"; scalar: ScalarType };

export function wellKnown(type: string): WellKnownKind | undefined {
  switch (type) {
    case "google.protobuf.Timestamp":
      return { kind: "timestamp" };
    case "google.protobuf.Duration":
      return { kind: "duration" };
    case "google.protobuf.FieldMask":
      return { kind: "fieldmask" };
    case "google.protobuf.Empty":
      return { kind: "empty" };
    case "google.protobuf.Struct":
      return { kind: "json", hint: '{ "key": "value" }', sample: {} };
    case "google.protobuf.ListValue":
      return { kind: "json", hint: "[ 1, \"two\" ]", sample: [] };
    case "google.protobuf.Value":
      return { kind: "json", hint: "any JSON value", sample: {} };
    case "google.protobuf.Any":
      return {
        kind: "json",
        hint: '{ "@type": "type.googleapis.com/pkg.Type", ... }',
        // well-known types packed in Any carry their JSON form in "value"
        sample: { "@type": "type.googleapis.com/google.protobuf.Empty", value: {} },
      };
  }
  const scalar = WRAPPERS[type];
  return scalar ? { kind: "wrapper", scalar } : undefined;
}

// ---- Scalars ----

const INT64_TYPES = new Set(["int64", "sint64", "uint64", "fixed64", "sfixed64"]);
const NUMBER_TYPES = new Set([
  "int32", "sint32", "uint32", "fixed32", "sfixed32", "float", "double",
]);

export function isScalar(type: string): type is ScalarType {
  return type === "string" || type === "bytes" || type === "bool" ||
    INT64_TYPES.has(type) || NUMBER_TYPES.has(type);
}

/** 64-bit integers are encoded as JSON strings. */
export function isInt64(type: string) {
  return INT64_TYPES.has(type);
}

export function isNumeric(type: string) {
  return NUMBER_TYPES.has(type) || INT64_TYPES.has(type);
}

export function scalarDefault(type: ScalarType): unknown {
  if (type === "bool") return false;
  if (type === "string" || type === "bytes") return "";
  return isInt64(type) ? "0" : 0;
}

// ---- Field access (requests may use either the JSON or the proto name) ----

export function getField(obj: JsonObject, f: FieldDef): unknown {
  return obj[f.name] !== undefined ? obj[f.name] : obj[f.protoName];
}

export function setField(obj: JsonObject, f: FieldDef, value: unknown): JsonObject {
  const next = { ...obj };
  if (f.protoName !== f.name) delete next[f.protoName];
  if (value === undefined) delete next[f.name];
  else next[f.name] = value;
  return next;
}

/** The field with repeated/map-ness stripped, for rendering array items. */
export function elementOf(f: FieldDef): FieldDef {
  return { ...f, isArray: false, isMap: false };
}

/** Key and value field definitions of a map field's synthetic entry message. */
export function mapEntry(schema: Schema, f: FieldDef) {
  const fields = schema.messageTypes[f.type] ?? [];
  return {
    key: fields.find((x) => x.name === "key"),
    value: fields.find((x) => x.name === "value"),
  };
}

// ---- Sample generation ----

function sampleWellKnown(wk: WellKnownKind): unknown {
  switch (wk.kind) {
    case "timestamp":
      return new Date().toISOString();
    case "duration":
      return "1s";
    case "fieldmask":
      return "";
    case "empty":
      return {};
    case "wrapper":
      return scalarDefault(wk.scalar);
    case "json":
      return wk.sample;
  }
}

/** A valid sample for a single (non-repeated) value of the field's type. */
export function sampleValue(
  schema: Schema,
  f: FieldDef,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (f.isEnum) return schema.enumTypes[f.type]?.[0]?.name ?? 0;
  if (f.isMessage) {
    const wk = wellKnown(f.type);
    // Optional Any fields are left out: a placeholder @type would be noise.
    if (wk) return f.type === "google.protobuf.Any" && !f.isRequired ? undefined : sampleWellKnown(wk);
    if (seen.has(f.type)) return undefined; // recursive type
    return sampleMessage(schema, f.type, seen);
  }
  if (f.defaultVal !== null && f.defaultVal !== undefined) return f.defaultVal;
  return isScalar(f.type) ? scalarDefault(f.type) : undefined;
}

export function sampleMessage(
  schema: Schema,
  typeName: string,
  seen: ReadonlySet<string> = new Set(),
): JsonObject {
  const inner = new Set(seen).add(typeName);
  const out: JsonObject = {};
  for (const f of schema.messageTypes[typeName] ?? []) {
    if (f.type === "oneof") {
      const choice = f.oneOfFields?.[0];
      const v = choice && sampleValue(schema, choice, inner);
      if (choice && v !== undefined) out[choice.name] = v;
      continue;
    }
    if (f.isMap) {
      out[f.name] = {};
      continue;
    }
    const v = sampleValue(schema, f, inner);
    if (v === undefined) continue;
    out[f.name] = f.isArray ? [v] : v;
  }
  return out;
}

/** Sample request JSON: one message, or an array of one for client streams. */
export function sampleRequest(schema: Schema): unknown {
  // Well-known request types (e.g. rpc Foo(google.protobuf.Timestamp)) use
  // their special JSON form at the top level too.
  const wk = wellKnown(schema.requestType);
  const msg = wk ? sampleWellKnown(wk) : sampleMessage(schema, schema.requestType);
  return schema.requestStream ? [msg] : msg;
}

/** A synthetic field standing for the whole request, for well-known request types. */
export function requestField(schema: Schema): FieldDef {
  return {
    name: "request",
    protoName: "request",
    type: schema.requestType,
    oneOfFields: null,
    isMessage: true,
    isEnum: false,
    isArray: false,
    isMap: false,
    isRequired: false,
    defaultVal: null,
    description: `${schema.requestType} (top-level request)`,
  };
}

// ---- gRPC status codes ----

const CODE_NAMES = [
  "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED",
  "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED",
  "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
];

export function codeName(code: number) {
  return CODE_NAMES[code] ?? `CODE_${code}`;
}

// Go's codes.Code.String() names, as used in "rpc error: code = X desc = Y".
const GO_CODE_NAMES = [
  "OK", "Canceled", "Unknown", "InvalidArgument", "DeadlineExceeded",
  "NotFound", "AlreadyExists", "PermissionDenied", "ResourceExhausted",
  "FailedPrecondition", "Aborted", "OutOfRange", "Unimplemented",
  "Internal", "Unavailable", "DataLoss", "Unauthenticated",
];

/** Extracts a gRPC status from a Go error string, if it contains one. */
export function parseGoStatus(text: string): { code: number; message: string } | undefined {
  const m = text.match(/code = (\w+) desc = ([\s\S]*)/);
  const code = m ? GO_CODE_NAMES.indexOf(m[1]) : -1;
  return m && code >= 0 ? { code, message: m[2].trim() } : undefined;
}

/** Server-side faults are red; caller-side / expected conditions are amber. */
export function codeSeverity(code: number): "ok" | "warn" | "error" {
  if (code === 0) return "ok";
  return [2, 12, 13, 14, 15].includes(code) ? "error" : "warn";
}
