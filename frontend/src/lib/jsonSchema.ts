// JSON Schema for a method's request, so the JSON editor can suggest field
// names and enum values, show field docs on hover, and flag type mismatches.
import type * as Monaco from "monaco-editor";
import type { FieldDef, Schema } from "../api/types";
import { isInt64, isScalar, wellKnown } from "./proto";

export type JSONSchema = Monaco.json.JSONSchema;

const ref = (type: string): JSONSchema => ({ $ref: `#/definitions/${type}` });

function scalarSchema(type: string): JSONSchema {
  if (type === "bool") return { type: "boolean" };
  if (type === "string") return { type: "string" };
  if (type === "bytes") return { type: "string", description: "base64" };
  if (isInt64(type)) return { type: ["string", "integer"], description: `${type} (string in JSON)` };
  if (type === "float" || type === "double") {
    return { anyOf: [{ type: "number" }, { enum: ["NaN", "Infinity", "-Infinity"] }] };
  }
  return { type: "integer" };
}

function wellKnownSchema(type: string): JSONSchema | undefined {
  const wk = wellKnown(type);
  switch (wk?.kind) {
    case undefined:
      return undefined;
    case "timestamp":
      return { type: "string", format: "date-time", description: "RFC 3339, e.g. 2026-01-01T00:00:00Z" };
    case "duration":
      return { type: "string", pattern: "^-?\\d+(\\.\\d+)?s$", description: 'Seconds with an "s" suffix, e.g. "1.5s"' };
    case "fieldmask":
      return { type: "string", description: 'Comma-separated paths, e.g. "a.b,c"' };
    case "empty":
      return { type: "object", additionalProperties: false };
    case "wrapper":
      return scalarSchema(wk.scalar);
    case "json":
      if (type === "google.protobuf.Struct") return { type: "object" };
      if (type === "google.protobuf.ListValue") return { type: "array" };
      if (type === "google.protobuf.Any") {
        return {
          type: "object",
          required: ["@type"],
          properties: { "@type": { type: "string", description: "type.googleapis.com/<full.type.Name>" } },
        };
      }
      return {}; // Value: any JSON
  }
}

function valueSchema(f: FieldDef): JSONSchema {
  if (f.isEnum || f.isMessage) return ref(f.type);
  return isScalar(f.type) ? scalarSchema(f.type) : {};
}

function fieldSchema(schema: Schema, f: FieldDef): JSONSchema {
  let s: JSONSchema;
  if (f.isMap) {
    const value = schema.messageTypes[f.type]?.find((x) => x.name === "value");
    s = { type: "object", additionalProperties: value ? valueSchema(value) : {} };
  } else if (f.isArray) {
    s = { type: "array", items: valueSchema(f) };
  } else {
    s = valueSchema(f);
  }
  // allOf keeps the description next to a $ref, which would otherwise hide it
  return { allOf: [s], description: f.description };
}

function messageSchema(schema: Schema, fields: FieldDef[]): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const add = (f: FieldDef, oneof?: string) => {
    const s = fieldSchema(schema, f);
    if (oneof) s.description = `${f.description}\n\n(oneof ${oneof}: set at most one)`;
    properties[f.name] = s;
    // The server accepts proto names too; allow them without suggesting both.
    if (f.protoName !== f.name) properties[f.protoName] = { ...s, doNotSuggest: true };
  };
  for (const f of fields) {
    if (f.type === "oneof") f.oneOfFields?.forEach((c) => add(c, f.name));
    else add(f);
  }
  return { type: "object", properties, additionalProperties: false };
}

export function requestJsonSchema(schema: Schema): JSONSchema {
  const definitions: Record<string, JSONSchema> = {};
  for (const [name, values] of Object.entries(schema.enumTypes)) {
    definitions[name] = {
      anyOf: [
        { enum: values.map((v) => v.name), enumDescriptions: values.map((v) => `${name} = ${v.num}`) },
        { type: "integer", enum: values.map((v) => v.num), doNotSuggest: true },
      ],
    };
  }
  for (const [name, fields] of Object.entries(schema.messageTypes)) {
    definitions[name] = wellKnownSchema(name) ?? messageSchema(schema, fields);
  }
  // Well-known types aren't always listed in messageTypes (e.g. as the request itself).
  if (!definitions[schema.requestType]) {
    definitions[schema.requestType] = wellKnownSchema(schema.requestType) ?? {};
  }
  const root = ref(schema.requestType);
  return { definitions, ...(schema.requestStream ? { type: "array", items: root } : root) };
}
