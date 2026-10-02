import type {
  Example,
  InvokeRequest,
  InvokeResult,
  Schema,
  ServicesResponse,
} from "./types";

const CSRF_COOKIE = "_grpcui_csrf_token";
const CSRF_HEADER = "x-grpcui-csrf-token";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(body.trim() || `HTTP ${status}`);
    this.status = status;
  }
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<T>;
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function csrfHeaders(): Record<string, string> {
  return { [CSRF_HEADER]: readCookie(CSRF_COOKIE) ?? "" };
}

export function fetchServices() {
  return getJSON<ServicesResponse>("api/services");
}

/** Re-runs schema discovery on the gateway (e.g. after the target restarted). */
export async function reloadServices(): Promise<ServicesResponse> {
  const res = await fetch("api/reload", {
    method: "POST",
    credentials: "same-origin",
    headers: csrfHeaders(),
  });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  return res.json() as Promise<ServicesResponse>;
}

/**
 * The gateway answers 503 until it has discovered the target's schema (and
 * 502 when a reload fails), with a JSON body describing the last error.
 */
export function unavailableReason(e: unknown): { target?: string; error?: string } | undefined {
  if (!(e instanceof HttpError) || (e.status !== 503 && e.status !== 502)) return undefined;
  try {
    return JSON.parse(e.message) as { target?: string; error?: string };
  } catch {
    return { error: e.message };
  }
}

export function fetchSchema(method: string) {
  return getJSON<Schema>(`api/metadata?method=${encodeURIComponent(method)}`);
}

export function fetchExamples() {
  return getJSON<Example[]>("api/examples");
}

export interface InvokeOutcome {
  result: InvokeResult;
  /** Time spent in the gRPC call as reported by the gateway, else round-trip. */
  durationMs: number;
  durationSource: "server" | "client";
}

/** Parses `Server-Timing: grpc;dur=12.3`. */
function serverDuration(res: Response): number | undefined {
  const header = res.headers.get("Server-Timing");
  const match = header?.match(/(?:^|,)\s*grpc\s*;[^,]*dur=([\d.]+)/);
  return match ? Number(match[1]) : undefined;
}

export async function invoke(
  method: string,
  body: InvokeRequest,
  signal?: AbortSignal,
): Promise<InvokeOutcome> {
  const started = performance.now();
  const res = await fetch(`api/invoke/${method}`, {
    method: "POST",
    credentials: "same-origin",
    // The Go handler requires exactly "application/json" (no charset).
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  const clientMs = performance.now() - started;
  if (!res.ok) throw new HttpError(res.status, await res.text());

  const result = (await res.json()) as InvokeResult;
  const serverMs = serverDuration(res);
  return serverMs === undefined
    ? { result, durationMs: clientMs, durationSource: "client" }
    : { result, durationMs: serverMs, durationSource: "server" };
}
