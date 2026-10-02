import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Columns2, Loader2, Moon, RefreshCw, Rows2, ServerCrash, Sun } from "lucide-react";
import {
  HttpError,
  fetchExamples,
  fetchSchema,
  fetchServices,
  invoke,
  reloadServices,
  unavailableReason,
} from "./api/client";
import type { Example, Schema, ServicesResponse } from "./api/types";
import { MethodHeader } from "./components/MethodHeader";
import { RequestPanel, type PayloadMode } from "./components/RequestPanel";
import { ResponsePanel, type ResponseState } from "./components/ResponsePanel";
import { Sidebar } from "./components/Sidebar";
import { Split } from "./components/Split";
import { IconButton } from "./components/ui";
import {
  activeMetadata,
  loadWorkspace,
  newRow,
  saveWorkspace,
  withBlankRow,
  type MetadataRow,
} from "./lib/drafts";
import { parseGoStatus, sampleRequest } from "./lib/proto";
import { setTheme, useTheme } from "./lib/theme";

export default function App() {
  const [data, setData] = useState<ServicesResponse>();
  const [error, setError] = useState<string>();
  // Set while the gateway is still discovering the target's schema (503).
  const [connecting, setConnecting] = useState<{ target?: string; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      fetchServices()
        .then((d) => !cancelled && setData(d))
        .catch((e: Error) => {
          if (cancelled) return;
          const reason = unavailableReason(e);
          if (reason) {
            setConnecting(reason);
            timer = setTimeout(load, 2000);
          } else {
            setError(e.message);
          }
        });
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (error) {
    return (
      <Centered>
        <ServerCrash className="size-8 text-red-400" />
        <p className="text-zinc-300">Couldn't reach the gRPC UI gateway</p>
        <code className="font-mono text-xs text-zinc-500">{error}</code>
      </Centered>
    );
  }
  if (!data) {
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-sky-500" />
        {connecting && (
          <>
            <p className="text-zinc-300">
              Connecting to <span className="font-mono">{connecting.target}</span>…
            </p>
            {connecting.error && (
              <code className="max-w-xl text-center font-mono text-xs text-zinc-500">{connecting.error}</code>
            )}
          </>
        )}
      </Centered>
    );
  }
  return <Workspace key={data.target} data={data} onReloaded={setData} />;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3">{children}</div>;
}

interface SchemaEntry {
  schema?: Schema;
  error?: string;
}

function Workspace({
  data,
  onReloaded,
}: {
  data: ServicesResponse;
  onReloaded: (data: ServicesResponse) => void;
}) {
  const { target, services } = data;

  const methods = useMemo(
    () => new Map(services.flatMap((s) => s.methods.map((m) => [m.fullName, { service: s, method: m }]))),
    [services],
  );

  const [selected, setSelected] = useState<string | undefined>(() => {
    const fromHash = decodeURIComponent(location.hash.slice(1));
    return methods.has(fromHash) ? fromHash : services[0]?.methods[0]?.fullName;
  });
  const [ws, setWs] = useState(() => loadWorkspace(target, data.defaultMetadata ?? []));
  const [schemas, setSchemas] = useState<Record<string, SchemaEntry>>({});
  const [responses, setResponses] = useState<Record<string, ResponseState>>({});
  const [examples, setExamples] = useState<Example[]>([]);
  const [mode, setMode] = useState<PayloadMode>(
    () => (localStorage.getItem("grpcui:mode") as PayloadMode | null) ?? "json",
  );
  const [layout, setLayout] = useState<"row" | "column">(
    () => (localStorage.getItem("grpcui:layout") as "row" | "column" | null) ?? "row",
  );
  const abort = useRef<AbortController | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string>();

  // Schemas may have changed when services are reloaded; drop the cache.
  const [schemasFor, setSchemasFor] = useState(services);
  if (schemasFor !== services) {
    setSchemasFor(services);
    setSchemas({});
  }

  const reload = async () => {
    setReloading(true);
    setReloadError(undefined);
    try {
      onReloaded(await reloadServices());
    } catch (e) {
      setReloadError(unavailableReason(e)?.error ?? (e as Error).message);
    } finally {
      setReloading(false);
    }
  };

  useEffect(() => saveWorkspace(target, ws), [target, ws]);
  useEffect(() => localStorage.setItem("grpcui:mode", mode), [mode]);
  useEffect(() => localStorage.setItem("grpcui:layout", layout), [layout]);

  useEffect(() => {
    fetchExamples()
      .then(setExamples)
      .catch(() => {}); // examples are optional
  }, []);

  useEffect(() => {
    if (!selected || schemas[selected]) return;
    const fqn = selected;
    fetchSchema(fqn)
      .then((schema) => setSchemas((p) => ({ ...p, [fqn]: { schema } })))
      .catch((e: Error) => setSchemas((p) => ({ ...p, [fqn]: { error: e.message } })));
  }, [selected, schemas]);

  const current = selected ? methods.get(selected) : undefined;
  const schema = selected ? schemas[selected]?.schema : undefined;
  const response: ResponseState = (selected && responses[selected]) || { kind: "idle" };
  const loading = response.kind === "loading";

  // Generated once per schema: it contains "now" timestamps, and a value that
  // changed on every render would keep resetting the editor.
  const sample = useMemo(() => (schema ? JSON.stringify(sampleRequest(schema), null, 2) : ""), [schema]);
  const body = (selected && ws.bodies[selected]) ?? sample;

  const methodExamples = useMemo(
    () =>
      current
        ? examples.filter((e) => e.service === current.service.name && e.method === current.method.name)
        : [],
    [examples, current],
  );

  const select = (fqn: string) => {
    setSelected(fqn);
    history.replaceState(null, "", `#${fqn}`);
  };

  const setBody = (text: string) => {
    if (!selected) return;
    setWs((w) => ({ ...w, bodies: { ...w.bodies, [selected]: text } }));
  };

  const resetBody = () => {
    if (!selected) return;
    setWs((w) => {
      const bodies = { ...w.bodies };
      delete bodies[selected];
      return { ...w, bodies };
    });
  };

  const setMetadata = (rows: MetadataRow[]) => setWs((w) => ({ ...w, metadata: rows }));

  const loadExample = (ex: Example) => {
    if (!selected) return;
    setWs((w) => {
      let rows = w.metadata.filter((r) => r.name || r.value);
      for (const pair of ex.request.metadata ?? []) {
        const existing = rows.find((r) => r.name.toLowerCase() === pair.name.toLowerCase());
        rows = existing
          ? rows.map((r) => (r === existing ? { ...r, value: pair.value, enabled: true } : r))
          : [...rows, newRow(pair)];
      }
      return {
        metadata: withBlankRow(rows),
        timeoutSeconds: ex.request.timeout_secs ? String(ex.request.timeout_secs) : w.timeoutSeconds,
        bodies: { ...w.bodies, [selected]: JSON.stringify(ex.request.data ?? {}, null, 2) },
      };
    });
  };

  const runInvoke = useCallback(async () => {
    if (!selected || !schema || loading) return;
    const fqn = selected;
    const setResult = (r: ResponseState) => setResponses((p) => ({ ...p, [fqn]: r }));

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      setResult({ kind: "failed", label: "Invalid JSON", message: (e as Error).message });
      return;
    }
    // Client streams take an array of messages; everything else takes one.
    const messages = schema.requestStream && Array.isArray(payload) ? payload : [payload];
    const timeout = Number(ws.timeoutSeconds);

    const ctrl = new AbortController();
    abort.current = ctrl;
    setResult({ kind: "loading" });
    try {
      const outcome = await invoke(
        fqn,
        {
          timeout_seconds: timeout > 0 ? timeout : undefined,
          metadata: activeMetadata(ws.metadata),
          data: messages,
        },
        ctrl.signal,
      );
      setResult({ kind: "done", outcome });
    } catch (e) {
      if (e instanceof HttpError) {
        // connection-level failures arrive as "rpc error: code = X desc = Y"
        const status = parseGoStatus(e.message);
        setResult({
          kind: "failed",
          label: `HTTP ${e.status}`,
          code: status?.code,
          message: status?.message ?? e.message,
        });
      } else if ((e as Error).name === "AbortError") {
        setResult({ kind: "failed", label: "Cancelled", code: 1, message: "Request cancelled by user." });
      } else {
        setResult({ kind: "failed", label: "Network error", message: (e as Error).message });
      }
    } finally {
      if (abort.current === ctrl) abort.current = null;
    }
  }, [selected, schema, loading, body, ws.timeoutSeconds, ws.metadata]);

  // Global Ctrl/Cmd+Enter. Monaco handles the shortcut itself (and stops
  // propagation) when an editor has focus.
  const invokeRef = useRef(runInvoke);
  useEffect(() => {
    invokeRef.current = runInvoke;
  }, [runInvoke]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
        e.preventDefault();
        void invokeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="grid h-full grid-cols-[17rem_1fr]">
      <Sidebar
        target={target}
        services={services}
        selected={selected}
        onSelect={(m) => select(m.fullName)}
        notice={reloadError && `Reload failed: ${reloadError}`}
        footer={
          <>
            <IconButton onClick={() => void reload()} disabled={reloading} title="Reload services from target">
              <RefreshCw className={reloading ? "size-3.5 animate-spin" : "size-3.5"} />
            </IconButton>
            <IconButton
              onClick={() => setLayout(layout === "row" ? "column" : "row")}
              title={layout === "row" ? "Stack response below" : "Response on the right"}
            >
              {layout === "row" ? <Rows2 className="size-3.5" /> : <Columns2 className="size-3.5" />}
            </IconButton>
            <ThemeToggle />
          </>
        }
      />

      <main className="flex min-h-0 min-w-0 flex-col">
        {!current ? (
          <Centered>
            <p className="text-zinc-500">
              {services.length === 0
                ? "No services found. Is server reflection enabled on the target?"
                : "Select a method"}
            </p>
          </Centered>
        ) : (
          <>
            <MethodHeader
              service={current.service}
              method={current.method}
              loading={loading}
              canInvoke={!!schema}
              timeoutSeconds={ws.timeoutSeconds}
              onTimeoutChange={(v) => setWs((w) => ({ ...w, timeoutSeconds: v }))}
              examples={methodExamples}
              onLoadExample={loadExample}
              onInvoke={() => void runInvoke()}
              onCancel={() => abort.current?.abort()}
            />
            <div className="min-h-0 flex-1">
              <Split
                key={layout}
                direction={layout}
                first={
                  <RequestPanel
                    service={current.service}
                    method={current.method}
                    types={data.types}
                    schema={schema}
                    schemaError={selected ? schemas[selected]?.error : undefined}
                    body={body}
                    onBodyChange={setBody}
                    onResetBody={resetBody}
                    mode={mode}
                    onModeChange={setMode}
                    metadata={ws.metadata}
                    onMetadataChange={setMetadata}
                    onInvoke={() => void runInvoke()}
                  />
                }
                second={<ResponsePanel key={selected} state={response} />}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconButton onClick={() => setTheme(next)} title={`Switch to ${next} mode`}>
      {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
    </IconButton>
  );
}
