// Wire types for the Go gateway. See docs/API.md for semantics.

// ---- GET api/services ----

export interface MetadataPair {
  name: string;
  value: string;
}

export interface MethodInfo {
  name: string;
  fullName: string;
  requestType: string;
  responseType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  description: string;
  /** Request, response and referenced types; keys into ServicesResponse.types. */
  types?: string[];
}

export interface ServiceInfo {
  name: string;
  package: string;
  shortName: string;
  description: string;
  methods: MethodInfo[];
}

export interface ServicesResponse {
  target: string;
  defaultMetadata: MetadataPair[] | null;
  services: ServiceInfo[];
  /** Fully-qualified message/enum name → proto source. */
  types?: Record<string, string>;
}

// ---- GET api/metadata?method= ----

export type ScalarType =
  | "string"
  | "bytes"
  | "int32"
  | "int64"
  | "sint32"
  | "sint64"
  | "uint32"
  | "uint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "float"
  | "double"
  | "bool";

/** Scalar name, "oneof", or a fully-qualified message/enum name. */
export type FieldType = ScalarType | "oneof" | (string & {});

export interface FieldDef {
  name: string;
  protoName: string;
  type: FieldType;
  oneOfFields: FieldDef[] | null;
  isMessage: boolean;
  isEnum: boolean;
  isArray: boolean;
  isMap: boolean;
  isRequired: boolean;
  defaultVal: unknown;
  description: string;
}

export interface EnumValueDef {
  num: number;
  name: string;
}

export interface Schema {
  requestType: string;
  requestStream: boolean;
  messageTypes: Record<string, FieldDef[]>;
  enumTypes: Record<string, EnumValueDef[]>;
}

// ---- POST api/invoke/{fqn} ----

export interface InvokeRequest {
  timeout_seconds?: number;
  metadata: MetadataPair[];
  data: unknown[];
}

export interface ResponseElement {
  /** A proto message as JSON, or a string when isError is true. */
  message: unknown;
  isError: boolean;
}

export interface RpcError {
  code: number;
  name: string;
  message: string;
  details: ResponseElement[] | null;
}

export interface InvokeResult {
  headers: MetadataPair[] | null;
  responses: ResponseElement[] | null;
  requests: { total: number; sent: number } | null;
  trailers: MetadataPair[] | null;
  error: RpcError | null;
}

// ---- GET api/examples ----

export interface Example {
  name: string;
  description: string;
  service: string;
  method: string;
  request: {
    timeout_secs?: number;
    metadata: MetadataPair[] | null;
    data: unknown;
  };
}
