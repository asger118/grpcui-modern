import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";

export const inputClass =
  "h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-[13px] text-zinc-100 " +
  "placeholder:text-zinc-600 outline-none transition-colors " +
  "hover:border-zinc-700 focus:border-sky-600 focus:ring-1 focus:ring-sky-600/40";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input spellCheck={false} {...props} className={cn(inputClass, className)} />;
}

export function IconButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors",
        "hover:bg-zinc-800 hover:text-zinc-200 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    />
  );
}

export function GhostButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-zinc-400 transition-colors",
        "hover:bg-zinc-800 hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    />
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
  children,
}: {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-1 border-b border-zinc-800 px-3", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            "relative -mb-px flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium transition-colors",
            active === t.id
              ? "border-sky-500 text-zinc-100"
              : "border-transparent text-zinc-500 hover:text-zinc-300",
          )}
        >
          {t.label}
          {!!t.count && (
            <span className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">{t.count}</span>
          )}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: ReactNode; disabled?: boolean }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={cn(
            "flex h-6 items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors disabled:opacity-40",
            value === o.id ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Accordion({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-zinc-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-1.5 px-3 text-xs font-medium text-zinc-400 hover:text-zinc-200"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {title}
        {count !== undefined && (
          <span className="rounded bg-zinc-800 px-1.5 py-px text-[10px] text-zinc-400">{count}</span>
        )}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function StreamTag({ client, server }: { client: boolean; server: boolean }) {
  if (!client && !server) return null;
  const label = client && server ? "bidi" : client ? "client" : "server";
  return (
    <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1 font-mono text-[9px] uppercase leading-4 text-violet-300">
      {label}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-white/20 bg-white/10 px-1 font-sans text-[10px] font-medium">
      {children}
    </kbd>
  );
}
