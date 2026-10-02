import { useState, type ReactNode } from "react";
import { ChevronRight, Clock, Plus, Trash2, X } from "lucide-react";
import type { FieldDef, ScalarType, Schema } from "../api/types";
import { cn } from "../lib/cn";
import {
  elementOf,
  getField,
  isInt64,
  isNumeric,
  isObject,
  mapEntry,
  requestField,
  sampleRequest,
  sampleValue,
  scalarDefault,
  setField,
  wellKnown,
  type JsonObject,
} from "../lib/proto";
import { GhostButton, IconButton, Input, inputClass } from "./ui";

type OnChange = (value: unknown) => void;

interface FormEditorProps {
  schema: Schema;
  value: unknown;
  onChange: OnChange;
}

/** Root form: one request message, or a list of them for client streams. */
export function FormEditor({ schema, value, onChange }: FormEditorProps) {
  if (!schema.requestStream) {
    return <RequestMessage schema={schema} value={value} onChange={onChange} />;
  }

  const items = Array.isArray(value) ? value : [];
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-md border border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
            <span className="text-xs font-medium text-zinc-400">Message #{i + 1}</span>
            <IconButton
              className="size-6"
              aria-label="Remove message"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </div>
          <div className="p-3">
            <RequestMessage
              schema={schema}
              value={item}
              onChange={(v) => onChange(items.map((x, j) => (j === i ? v : x)))}
            />
          </div>
        </div>
      ))}
      <GhostButton onClick={() => onChange([...items, ...(sampleRequest(schema) as unknown[])])}>
        <Plus className="size-3.5" /> Add stream message
      </GhostButton>
    </div>
  );
}

/** One request message; well-known request types get their dedicated widget. */
function RequestMessage({ schema, value, onChange }: { schema: Schema; value: unknown; onChange: OnChange }) {
  const wk = wellKnown(schema.requestType);
  if (wk && wk.kind !== "empty") {
    const field = requestField(schema);
    return (
      <FieldRow field={field}>
        <SingleInput schema={schema} field={field} value={value} onChange={onChange} />
      </FieldRow>
    );
  }
  return (
    <MessageFields
      schema={schema}
      typeName={schema.requestType}
      value={isObject(value) ? value : {}}
      onChange={onChange}
    />
  );
}

// ---- Messages ----

function MessageFields({
  schema,
  typeName,
  value,
  onChange,
}: {
  schema: Schema;
  typeName: string;
  value: JsonObject;
  onChange: OnChange;
}) {
  const fields = schema.messageTypes[typeName] ?? [];
  if (fields.length === 0) {
    return <p className="text-xs text-zinc-600 italic">No fields</p>;
  }
  return (
    <div className="divide-y divide-zinc-800/70">
      {fields.map((f) =>
        f.type === "oneof" ? (
          <OneOfRow key={f.name} schema={schema} field={f} value={value} onChange={onChange} />
        ) : (
          <FieldRow key={f.name} field={f}>
            <ValueInput
              schema={schema}
              field={f}
              value={getField(value, f)}
              onChange={(v) => onChange(setField(value, f, v))}
            />
          </FieldRow>
        ),
      )}
    </div>
  );
}

function typeLabel(f: FieldDef) {
  const short = f.type.includes(".") ? f.type.slice(f.type.lastIndexOf(".") + 1) : f.type;
  if (f.isMap) return "map";
  return f.isArray ? `${short}[]` : short;
}

function FieldRow({ field, children }: { field: FieldDef; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-3 py-2">
      <div className="min-w-0 pt-1.5" title={field.description}>
        <div className="truncate font-mono text-xs text-zinc-200">
          {field.name}
          {field.isRequired && <span className="text-red-400">*</span>}
        </div>
        <div className="truncate font-mono text-[10px] text-zinc-500">{typeLabel(field)}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OneOfRow({
  schema,
  field,
  value,
  onChange,
}: {
  schema: Schema;
  field: FieldDef;
  value: JsonObject;
  onChange: OnChange;
}) {
  const choices = field.oneOfFields ?? [];
  const selected = choices.find((c) => getField(value, c) !== undefined);

  const select = (name: string) => {
    let next = value;
    for (const c of choices) next = setField(next, c, undefined);
    const choice = choices.find((c) => c.name === name);
    if (choice) {
      const v = sampleValue(schema, choice);
      next = setField(next, choice, v === undefined ? {} : v);
    }
    onChange(next);
  };

  return (
    <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-3 py-2">
      <div className="pt-1.5">
        <div className="font-mono text-xs text-zinc-200">{field.name}</div>
        <div className="font-mono text-[10px] text-amber-500/80">oneof</div>
      </div>
      <div className="min-w-0 space-y-2">
        <select
          value={selected?.name ?? ""}
          onChange={(e) => select(e.target.value)}
          className={inputClass}
        >
          <option value="">(none)</option>
          {choices.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} : {typeLabel(c)}
            </option>
          ))}
        </select>
        {selected && (
          <div className="border-l-2 border-amber-500/30 pl-3">
            <FieldRow field={selected}>
              <ValueInput
                schema={schema}
                field={selected}
                value={getField(value, selected)}
                onChange={(v) => onChange(setField(value, selected, v))}
              />
            </FieldRow>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Values ----

interface ValueProps {
  schema: Schema;
  field: FieldDef;
  value: unknown;
  onChange: OnChange;
}

function ValueInput(props: ValueProps) {
  if (props.field.isMap) return <MapInput {...props} />;
  if (props.field.isArray) return <ArrayInput {...props} />;
  return <SingleInput {...props} />;
}

/** Array items and map values must never be undefined (that becomes null). */
function orDefault(schema: Schema, f: FieldDef, v: unknown) {
  return v !== undefined ? v : (sampleValue(schema, f) ?? (f.isMessage ? {} : ""));
}

function ArrayInput({ schema, field, value, onChange }: ValueProps) {
  const items = Array.isArray(value) ? value : [];
  const el = elementOf(field);
  const set = (next: unknown[]) => onChange(next.length ? next : undefined);

  return (
    <div className="space-y-1.5">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className="w-5 shrink-0 pt-2 text-right font-mono text-[10px] text-zinc-600">{i}</span>
          <div className="min-w-0 flex-1">
            <SingleInput
              schema={schema}
              field={el}
              value={item}
              onChange={(v) => set(items.map((x, j) => (j === i ? orDefault(schema, el, v) : x)))}
            />
          </div>
          <IconButton aria-label="Remove item" onClick={() => set(items.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <GhostButton onClick={() => set([...items, orDefault(schema, el, undefined)])}>
        <Plus className="size-3.5" /> Add item
      </GhostButton>
    </div>
  );
}

function MapInput({ schema, field, value, onChange }: ValueProps) {
  const obj = isObject(value) ? value : {};
  const entries = Object.entries(obj);
  const { key: keyField, value: valueField } = mapEntry(schema, field);
  if (!valueField) return <span className="text-xs text-red-400">Unknown map entry type</span>;

  const set = (next: [string, unknown][]) =>
    onChange(next.length ? Object.fromEntries(next) : undefined);
  const freshKey = () => {
    let k = "key";
    for (let n = 1; k in obj; n++) k = `key${n}`;
    return k;
  };

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-start gap-1.5">
          <Input
            value={k}
            onChange={(e) => set(entries.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
            placeholder={keyField?.type ?? "key"}
            className="w-40 shrink-0 font-mono"
          />
          <div className="min-w-0 flex-1">
            <SingleInput
              schema={schema}
              field={valueField}
              value={v}
              onChange={(nv) =>
                set(entries.map((x, j) => (j === i ? [k, orDefault(schema, valueField, nv)] : x)))
              }
            />
          </div>
          <IconButton aria-label="Remove entry" onClick={() => set(entries.filter((_, j) => j !== i))}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <GhostButton onClick={() => set([...entries, [freshKey(), orDefault(schema, valueField, undefined)]])}>
        <Plus className="size-3.5" /> Add entry
      </GhostButton>
    </div>
  );
}

function SingleInput({ schema, field, value, onChange }: ValueProps) {
  if (field.isEnum) {
    const values = schema.enumTypes[field.type] ?? [];
    return (
      <select
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        className={cn(inputClass, "font-mono")}
      >
        <option value="">(default)</option>
        {values.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name} = {v.num}
          </option>
        ))}
      </select>
    );
  }

  if (field.isMessage) {
    const wk = wellKnown(field.type);
    if (wk) {
      switch (wk.kind) {
        case "timestamp":
          return (
            <div className="flex gap-1.5">
              <TextInput value={value} onChange={onChange} placeholder="2026-01-01T00:00:00Z" />
              <GhostButton onClick={() => onChange(new Date().toISOString())} title="Now">
                <Clock className="size-3.5" />
              </GhostButton>
            </div>
          );
        case "duration":
          return <TextInput value={value} onChange={onChange} placeholder="1.5s" />;
        case "fieldmask":
          return <TextInput value={value} onChange={onChange} placeholder="path.one,path_two" />;
        case "empty":
          return <Toggle value={value !== undefined} onChange={(on) => onChange(on ? {} : undefined)} />;
        case "wrapper":
          return <ScalarInput type={wk.scalar} value={value} onChange={onChange} nullable />;
        case "json":
          return <JsonInput value={value} onChange={onChange} placeholder={wk.hint} />;
      }
    }
    return <NestedMessage schema={schema} field={field} value={value} onChange={onChange} />;
  }

  return <ScalarInput type={field.type as ScalarType} value={value} onChange={onChange} />;
}

function NestedMessage({ schema, field, value, onChange }: ValueProps) {
  const [open, setOpen] = useState(true);
  const shortType = field.type.slice(field.type.lastIndexOf(".") + 1);

  if (!isObject(value)) {
    return (
      <GhostButton className="border border-dashed border-zinc-800" onClick={() => onChange({})}>
        <Plus className="size-3.5" /> Set {shortType}
      </GhostButton>
    );
  }
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/30">
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex flex-1 items-center gap-1 text-left font-mono text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          {field.type}
        </button>
        <IconButton className="size-6" aria-label="Unset" title="Unset" onClick={() => onChange(undefined)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
      {open && (
        <div className="border-t border-zinc-800 px-3">
          <MessageFields schema={schema} typeName={field.type} value={value} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

// ---- Leaf inputs ----

function TextInput({
  value,
  onChange,
  placeholder,
}: {
  value: unknown;
  onChange: OnChange;
  placeholder?: string;
}) {
  return (
    <Input
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      placeholder={placeholder}
      className="font-mono"
    />
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={cn(
        "relative mt-1 h-5 w-9 rounded-full transition-colors",
        value ? "bg-sky-600" : "bg-zinc-700",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform",
          value && "translate-x-4",
        )}
      />
    </button>
  );
}

function ScalarInput({
  type,
  value,
  onChange,
  nullable,
}: {
  type: ScalarType;
  value: unknown;
  onChange: OnChange;
  nullable?: boolean;
}) {
  if (type === "bool") {
    const toggle = <Toggle value={value === true} onChange={onChange} />;
    if (!nullable) return toggle;
    return value === undefined ? (
      <GhostButton onClick={() => onChange(false)}>
        <Plus className="size-3.5" /> Set
      </GhostButton>
    ) : (
      <div className="flex items-center gap-2">
        {toggle}
        <IconButton className="size-6" aria-label="Unset" onClick={() => onChange(undefined)}>
          <X className="size-3.5" />
        </IconButton>
      </div>
    );
  }
  if (isNumeric(type)) {
    return <NumberInput type={type} value={value} onChange={onChange} />;
  }
  return (
    <TextInput
      value={value}
      onChange={(v) => onChange(v === undefined && !nullable ? undefined : v)}
      placeholder={type === "bytes" ? "base64" : nullable ? "null" : ""}
    />
  );
}

function NumberInput({ type, value, onChange }: { type: ScalarType; value: unknown; onChange: OnChange }) {
  const fmt = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  // Keep the raw text locally so partial input like "-" or "1." survives
  // re-rendering; re-sync when the value changes from outside.
  const [draft, setDraft] = useState({ text: fmt(value), value });
  if (draft.value !== value) setDraft({ text: fmt(value), value });

  const parse = (text: string): unknown => {
    const t = text.trim();
    if (t === "") return undefined;
    if (isInt64(type)) return /^-?\d+$/.test(t) ? t : text;
    const n = Number(t);
    // non-numeric text is passed through so the server reports the problem
    // (and so "NaN"/"Infinity" work for floats)
    return Number.isFinite(n) && /^-?[\d.]+(e-?\d+)?$/i.test(t) ? n : text;
  };

  const t = draft.text.trim();
  const invalid =
    t !== "" &&
    (isInt64(type)
      ? !/^-?\d+$/.test(t)
      : typeof parse(t) === "string" && !["NaN", "Infinity", "-Infinity"].includes(t));

  return (
    <Input
      value={draft.text}
      inputMode="decimal"
      placeholder={String(scalarDefault(type))}
      onChange={(e) => {
        const v = parse(e.target.value);
        setDraft({ text: e.target.value, value: v });
        onChange(v);
      }}
      className={cn("font-mono", invalid && "border-red-500/60 focus:border-red-500")}
    />
  );
}

function JsonInput({ value, onChange, placeholder }: { value: unknown; onChange: OnChange; placeholder: string }) {
  const fmt = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
  const [draft, setDraft] = useState({ text: fmt(value), value, error: false });
  // The form value is re-parsed from JSON text on every render, so compare
  // structurally; a reference check would reformat the text on each keystroke.
  if (!draft.error && JSON.stringify(draft.value) !== JSON.stringify(value)) {
    setDraft({ text: fmt(value), value, error: false });
  }

  return (
    <textarea
      value={draft.text}
      spellCheck={false}
      placeholder={placeholder}
      rows={Math.min(8, Math.max(2, draft.text.split("\n").length))}
      onChange={(e) => {
        const text = e.target.value;
        if (text.trim() === "") {
          setDraft({ text, value: undefined, error: false });
          onChange(undefined);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          setDraft({ text, value: parsed, error: false });
          onChange(parsed);
        } catch {
          setDraft({ ...draft, text, error: true });
        }
      }}
      className={cn(
        inputClass,
        "h-auto resize-y py-1.5 font-mono",
        draft.error && "border-red-500/60 focus:border-red-500",
      )}
    />
  );
}
