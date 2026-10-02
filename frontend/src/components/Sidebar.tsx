import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Search, Server, X } from "lucide-react";
import type { MethodInfo, ServiceInfo } from "../api/types";
import { cn } from "../lib/cn";
import { IconButton, StreamTag } from "./ui";

interface Props {
  target: string;
  services: ServiceInfo[];
  selected?: string;
  onSelect: (method: MethodInfo) => void;
  footer?: ReactNode;
  notice?: string;
}

export function Sidebar({ target, services, selected, onSelect, footer, notice }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return services;
    return services.flatMap((svc) => {
      if (svc.name.toLowerCase().includes(q)) return [svc];
      const methods = svc.methods.filter((m) => m.name.toLowerCase().includes(q));
      return methods.length ? [{ ...svc, methods }] : [];
    });
  }, [services, query]);

  const toggle = (name: string) => {
    const next = new Set(collapsed);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setCollapsed(next);
  };

  const methodCount = services.reduce((n, s) => n + s.methods.length, 0);

  return (
    <aside className="flex h-full flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
        <div className="flex size-7 items-center justify-center rounded-md bg-sky-500/15 text-sky-400">
          <Server className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Target</div>
          <div className="truncate font-mono text-xs text-zinc-200" title={target}>
            {target}
          </div>
        </div>
      </div>

      <div className="p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Filter services & methods"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pr-7 pl-8 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
          />
          {query && (
            <IconButton
              className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2"
              onClick={() => setQuery("")}
              aria-label="Clear filter"
            >
              <X className="size-3" />
            </IconButton>
          )}
        </div>
      </div>

      {notice && (
        <p className="mx-2 mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] break-words text-red-300">
          {notice}
        </p>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-zinc-600">No matches</p>
        )}
        {filtered.map((svc) => {
          // while filtering, always show matches expanded
          const open = !!query.trim() || !collapsed.has(svc.name);
          return (
            <div key={svc.name} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggle(svc.name)}
                title={svc.name}
                className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left hover:bg-zinc-800/60"
              >
                <ChevronRight
                  className={cn("size-3.5 shrink-0 text-zinc-500 transition-transform", open && "rotate-90")}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-zinc-200">{svc.shortName}</div>
                  {svc.package && (
                    <div className="truncate font-mono text-[10px] text-zinc-500">{svc.package}</div>
                  )}
                </div>
              </button>
              {open && (
                <ul className="ml-3.5 border-l border-zinc-800 pl-1.5">
                  {svc.methods.map((m) => (
                    <li key={m.fullName}>
                      <button
                        type="button"
                        onClick={() => onSelect(m)}
                        title={m.fullName}
                        className={cn(
                          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors",
                          selected === m.fullName
                            ? "bg-sky-500/15 text-sky-200"
                            : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
                        )}
                      >
                        <span className="truncate font-mono text-xs">{m.name}</span>
                        <span className="ml-auto">
                          <StreamTag client={m.clientStreaming} server={m.serverStreaming} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>

      <div className="flex items-center border-t border-zinc-800 py-1 pr-1 pl-3 text-[11px] text-zinc-600">
        {services.length} services · {methodCount} methods
        <div className="ml-auto flex">{footer}</div>
      </div>
    </aside>
  );
}
