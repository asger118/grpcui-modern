import { useEffect, useMemo, useState } from "react";
import { Braces, FileCode2, ListTree, RotateCcw, WandSparkles } from "lucide-react";
import type { MethodInfo, Schema, ServiceInfo } from "../api/types";
import { activeMetadata, type MetadataRow } from "../lib/drafts";
import { registerRequestSchema } from "../lib/monaco";
import { PROTO_LANGUAGE } from "../lib/protoLanguage";
import { CodeEditor } from "./CodeEditor";
import { FormEditor } from "./FormEditor";
import { MetadataEditor } from "./MetadataEditor";
import { GhostButton, Segmented, Tabs } from "./ui";

export type PayloadMode = "form" | "json";

interface Props {
  service: ServiceInfo;
  method: MethodInfo;
  types: Record<string, string> | undefined;
  schema: Schema | undefined;
  schemaError: string | undefined;
  body: string;
  onBodyChange: (body: string) => void;
  onResetBody: () => void;
  mode: PayloadMode;
  onModeChange: (mode: PayloadMode) => void;
  metadata: MetadataRow[];
  onMetadataChange: (rows: MetadataRow[]) => void;
  onInvoke: () => void;
}

type Tab = "payload" | "metadata" | "definition";

export function RequestPanel(props: Props) {
  const [tab, setTab] = useState<Tab>("payload");
  const { mode, onModeChange, body, onBodyChange } = props;

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(body) as unknown };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [body]);

  // Enum values, field names and docs as completions/hovers in JSON mode
  const requestPath = `request/${props.method.fullName}.json`;
  useEffect(() => {
    if (props.schema) registerRequestSchema(requestPath, props.schema);
  }, [requestPath, props.schema]);

  const format = () => {
    if (parsed.ok) onBodyChange(JSON.stringify(parsed.value, null, 2));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "payload", label: "Payload" },
          { id: "metadata", label: "Metadata", count: activeMetadata(props.metadata).length },
          { id: "definition", label: "Definition" },
        ]}
      >
        {tab === "payload" && (
          <>
            {mode === "json" && (
              <GhostButton onClick={format} disabled={!parsed.ok} title="Format JSON">
                <WandSparkles className="size-3.5" />
              </GhostButton>
            )}
            <GhostButton onClick={props.onResetBody} disabled={!props.schema} title="Reset to sample">
              <RotateCcw className="size-3.5" />
            </GhostButton>
            <Segmented
              value={mode}
              onChange={onModeChange}
              options={[
                { id: "form", label: <><ListTree className="size-3" /> Form</> },
                { id: "json", label: <><Braces className="size-3" /> JSON</> },
              ]}
            />
          </>
        )}
      </Tabs>

      <div className="min-h-0 flex-1">
        {tab === "payload" && <Payload {...props} parsed={parsed} />}
        {tab === "metadata" && (
          <MetadataEditor rows={props.metadata} onChange={props.onMetadataChange} />
        )}
        {tab === "definition" && (
          <CodeEditor
            language={PROTO_LANGUAGE}
            readOnly
            path={`definition/${props.method.fullName}.proto`}
            value={definition(props.service, props.method, props.types)}
          />
        )}
      </div>
    </div>
  );
}

function Payload({
  schema,
  schemaError,
  method,
  mode,
  onModeChange,
  body,
  onBodyChange,
  onInvoke,
  parsed,
}: Props & { parsed: { ok: true; value: unknown } | { ok: false; error: string } }) {
  if (schemaError) {
    return <p className="p-4 text-xs text-red-400">Failed to load schema: {schemaError}</p>;
  }
  if (!schema) {
    return <p className="p-4 text-xs text-zinc-600">Loading schema…</p>;
  }

  if (mode === "json") {
    return (
      <CodeEditor
        value={body}
        onChange={onBodyChange}
        onInvoke={onInvoke}
        path={`request/${method.fullName}.json`}
      />
    );
  }

  if (!parsed.ok) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-xs text-zinc-400">
        <p className="flex items-center gap-1.5 text-amber-400">
          <FileCode2 className="size-3.5" /> The JSON payload is invalid, so the form can't be shown.
        </p>
        <code className="font-mono text-zinc-500">{parsed.error}</code>
        <GhostButton onClick={() => onModeChange("json")}>Fix in JSON mode</GhostButton>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-2">
      <FormEditor
        key={method.fullName}
        schema={schema}
        value={parsed.value}
        onChange={(v) => onBodyChange(JSON.stringify(v ?? {}, null, 2))}
      />
    </div>
  );
}

/** The service's rpc declaration followed by the messages and enums it uses. */
function definition(service: ServiceInfo, method: MethodInfo, types: Record<string, string> = {}) {
  const parts = [`${service.description}\n${method.description}\n}`];
  for (const name of method.types ?? []) {
    const src = types[name];
    if (!src) continue;
    const roles = [name === method.requestType && "request", name === method.responseType && "response"];
    const role = roles.filter(Boolean).join(", ");
    parts.push(`// ${name}${role && ` (${role})`}\n${src}`);
  }
  return parts.join("\n\n") + "\n";
}
