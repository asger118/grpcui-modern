import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Copy, Loader2, Radio } from "lucide-react";
import type { InvokeOutcome } from "../api/client";
import type { MetadataPair, ResponseElement } from "../api/types";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/cn";
import { codeName, codeSeverity } from "../lib/proto";
import { CodeEditor } from "./CodeEditor";
import { Accordion, GhostButton } from "./ui";

export type ResponseState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; outcome: InvokeOutcome }
  /** The gateway call itself failed (HTTP error, network, bad JSON). */
  | { kind: "failed"; label: string; code?: number; message: string; durationMs?: number };

export function StatusBadge({ code, label }: { code?: number; label?: string }) {
  const sev = code === undefined ? "error" : codeSeverity(code);
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-xs font-semibold",
        sev === "ok" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        sev === "warn" && "border-amber-500/30 bg-amber-500/10 text-amber-400",
        sev === "error" && "border-red-500/30 bg-red-500/10 text-red-400",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {label ?? `${code} ${codeName(code!)}`}
    </span>
  );
}

function messagesToJSON(items: ResponseElement[]): unknown {
  const values = items.map((r) => r.message);
  return values.length === 1 ? values[0] : values;
}

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function MetadataTable({ pairs }: { pairs: MetadataPair[] }) {
  if (pairs.length === 0) return <p className="text-xs text-zinc-600 italic">None</p>;
  return (
    <table className="w-full table-fixed font-mono text-xs">
      <tbody>
        {pairs.map((p, i) => (
          <tr key={i} className="border-b border-zinc-800/60 last:border-0">
            <td className="w-2/5 truncate py-1 pr-3 align-top text-zinc-400" title={p.name}>
              {p.name}
            </td>
            <td className="py-1 break-all text-zinc-200 select-text">{p.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResponsePanel({ state }: { state: ResponseState }) {
  const [copied, setCopied] = useState(false);

  if (state.kind === "idle") {
    return (
      <Empty>
        <Radio className="size-8 text-zinc-700" />
        <p>Send a request to see the response</p>
      </Empty>
    );
  }
  if (state.kind === "loading") {
    return (
      <Empty>
        <Loader2 className="size-6 animate-spin text-sky-500" />
        <p>Waiting for response…</p>
      </Empty>
    );
  }

  let badge: ReactNode;
  let body: string;
  let error: { title: string; message: string } | undefined;
  let headers: MetadataPair[] = [];
  let trailers: MetadataPair[] = [];
  let durationMs: number | undefined;
  let durationTitle = "";
  let warning: string | undefined;
  let messageCount = 0;

  if (state.kind === "failed") {
    badge = <StatusBadge code={state.code} label={state.code === undefined ? state.label : undefined} />;
    error = { title: state.label, message: state.message };
    body = "";
    durationMs = state.durationMs;
  } else {
    const { result, durationMs: ms, durationSource } = state.outcome;
    const responses = result.responses ?? [];
    headers = result.headers ?? [];
    trailers = result.trailers ?? [];
    durationMs = ms;
    durationTitle =
      durationSource === "server" ? "Time spent in the gRPC call (gateway)" : "Browser round-trip time";
    messageCount = responses.length;
    badge = <StatusBadge code={result.error?.code ?? 0} />;

    if (result.error) {
      error = { title: codeName(result.error.code), message: result.error.message };
    }
    // Prefer response messages; on error with none, show the error details.
    const details = result.error?.details ?? [];
    body =
      responses.length > 0
        ? JSON.stringify(messagesToJSON(responses), null, 2)
        : details.length > 0
          ? JSON.stringify(messagesToJSON(details), null, 2)
          : result.error
            ? ""
            : "{}";
    if (result.requests && result.requests.sent < result.requests.total) {
      warning = `Only ${result.requests.sent} of ${result.requests.total} request messages were sent before the server closed the stream.`;
    }
  }

  const copy = async () => {
    if (await copyText(body)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
        {badge}
        {durationMs !== undefined && (
          <span className="font-mono text-xs text-zinc-400" title={durationTitle}>
            {durationMs < 10 ? durationMs.toFixed(1) : Math.round(durationMs)} ms
          </span>
        )}
        {body && <span className="font-mono text-xs text-zinc-500">{formatBytes(new Blob([body]).size)}</span>}
        {messageCount > 1 && <span className="text-xs text-zinc-500">{messageCount} messages</span>}
        <div className="ml-auto">
          <GhostButton onClick={copy} disabled={!body}>
            {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </GhostButton>
        </div>
      </div>

      {error && (
        <div className="shrink-0 border-b border-zinc-800 bg-red-500/5 px-3 py-2">
          <div className="text-xs font-semibold text-red-400">{error.title}</div>
          <pre className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap text-red-300/90 select-text">
            {error.message}
          </pre>
        </div>
      )}
      {warning && (
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="size-3.5 shrink-0" /> {warning}
        </div>
      )}

      {state.kind === "done" && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto">
          <Accordion title="Response Headers" count={headers.length}>
            <MetadataTable pairs={headers} />
          </Accordion>
          <Accordion title="Trailers" count={trailers.length}>
            <MetadataTable pairs={trailers} />
          </Accordion>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {body && <CodeEditor value={body} readOnly path="response.json" />}
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-zinc-600">
      {children}
    </div>
  );
}
