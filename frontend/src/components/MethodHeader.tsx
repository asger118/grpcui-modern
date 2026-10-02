import { ChevronRight, Loader2, Play, Square, Timer } from "lucide-react";
import type { Example, MethodInfo, ServiceInfo } from "../api/types";
import { cn } from "../lib/cn";
import { Kbd, StreamTag, inputClass } from "./ui";

interface Props {
  service: ServiceInfo;
  method: MethodInfo;
  loading: boolean;
  canInvoke: boolean;
  timeoutSeconds: string;
  onTimeoutChange: (v: string) => void;
  examples: Example[];
  onLoadExample: (e: Example) => void;
  onInvoke: () => void;
  onCancel: () => void;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

export function MethodHeader({
  service,
  method,
  loading,
  canInvoke,
  timeoutSeconds,
  onTimeoutChange,
  examples,
  onLoadExample,
  onInvoke,
  onCancel,
}: Props) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 truncate font-mono text-[11px] text-zinc-500">
          {service.package && (
            <>
              <span className="truncate">{service.package}</span>
              <ChevronRight className="size-3 shrink-0" />
            </>
          )}
          <span className="truncate">{service.shortName}</span>
        </div>
        <div className="flex items-center gap-2">
          <h1 className="truncate font-mono text-base font-semibold text-zinc-100">{method.name}</h1>
          <StreamTag client={method.clientStreaming} server={method.serverStreaming} />
          <span className="hidden truncate font-mono text-[11px] text-zinc-600 xl:inline">
            ({method.requestType.split(".").pop()}) → {method.responseType.split(".").pop()}
          </span>
        </div>
      </div>

      {examples.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const ex = examples[Number(e.target.value)];
            if (ex) onLoadExample(ex);
          }}
          className={cn(inputClass, "w-40 text-xs")}
        >
          <option value="">Load example…</option>
          {examples.map((ex, i) => (
            <option key={i} value={i} title={ex.description}>
              {ex.name}
            </option>
          ))}
        </select>
      )}

      <label className="flex items-center gap-1.5" title="Deadline in seconds (empty = none)">
        <Timer className="size-3.5 text-zinc-500" />
        <input
          value={timeoutSeconds}
          onChange={(e) => onTimeoutChange(e.target.value)}
          inputMode="decimal"
          placeholder="timeout"
          className={cn(inputClass, "w-20 font-mono text-xs")}
        />
      </label>

      {loading ? (
        <button
          type="button"
          onClick={onCancel}
          className="flex h-8 items-center gap-2 rounded-md bg-zinc-800 px-3.5 text-[13px] font-semibold text-zinc-100 hover:bg-zinc-700"
        >
          <Loader2 className="size-3.5 animate-spin" />
          Cancel
          <Square className="size-3 fill-current" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onInvoke}
          disabled={!canInvoke}
          className="flex h-8 items-center gap-2 rounded-md bg-sky-600 px-3.5 text-[13px] font-semibold text-white shadow-sm shadow-sky-900/50 transition-colors hover:bg-sky-500 disabled:opacity-50"
        >
          <Play className="size-3.5 fill-current" />
          Invoke
          <span className="flex gap-0.5 opacity-80">
            <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </button>
      )}
    </header>
  );
}
