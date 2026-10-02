import { Trash2 } from "lucide-react";
import { withBlankRow, type MetadataRow } from "../lib/drafts";
import { cn } from "../lib/cn";
import { IconButton } from "./ui";

interface Props {
  rows: MetadataRow[];
  onChange: (rows: MetadataRow[]) => void;
}

const cell =
  "h-8 w-full bg-transparent px-2.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:bg-zinc-900";

export function MetadataEditor({ rows, onChange }: Props) {
  const update = (id: string, patch: Partial<MetadataRow>) =>
    onChange(withBlankRow(rows.map((r) => (r.id === id ? { ...r, ...patch } : r))));
  const remove = (id: string) => onChange(withBlankRow(rows.filter((r) => r.id !== id)));

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="overflow-hidden rounded-md border border-zinc-800">
        <div className="grid grid-cols-[2rem_1fr_1.5fr_2rem] border-b border-zinc-800 bg-zinc-900/60 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          <div />
          <div className="px-2.5 py-1.5">Key</div>
          <div className="border-l border-zinc-800 px-2.5 py-1.5">Value</div>
          <div />
        </div>
        {rows.map((r, i) => {
          const isBlank = i === rows.length - 1 && !r.name && !r.value;
          return (
            <div
              key={r.id}
              className={cn(
                "group grid grid-cols-[2rem_1fr_1.5fr_2rem] items-center border-b border-zinc-800/70 last:border-b-0",
                !r.enabled && "opacity-50",
              )}
            >
              <div className="flex justify-center">
                {!isBlank && (
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => update(r.id, { enabled: e.target.checked })}
                    className="size-3.5 accent-sky-500"
                    aria-label="Enabled"
                  />
                )}
              </div>
              <input
                value={r.name}
                onChange={(e) => update(r.id, { name: e.target.value })}
                placeholder="authorization"
                spellCheck={false}
                className={cell}
              />
              <input
                value={r.value}
                onChange={(e) => update(r.id, { value: e.target.value })}
                placeholder="Bearer …"
                spellCheck={false}
                className={cn(cell, "border-l border-zinc-800")}
              />
              <div className="flex justify-center">
                {!isBlank && (
                  <IconButton
                    onClick={() => remove(r.id)}
                    className="size-6 opacity-0 group-hover:opacity-100"
                    aria-label="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Shared across all methods. Keys ending in <code className="font-mono">-bin</code> expect
        base64 values. Server-side <code className="font-mono">-rpc-header</code> values take precedence.
      </p>
    </div>
  );
}
