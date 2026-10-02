// Bundle Monaco locally instead of letting @monaco-editor/react fetch it from a
// CDN, so the UI works in air-gapped / offline containers.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import type { Schema } from "../api/types";
import { requestJsonSchema, type JSONSchema } from "./jsonSchema";
import { protoTokenRules, registerProtoLanguage } from "./protoLanguage";

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return label === "json" ? new JsonWorker() : new EditorWorker();
  },
};

monaco.editor.defineTheme("grpcui-dark", {
  base: "vs-dark",
  inherit: true,
  rules: protoTokenRules.dark,
  colors: {
    "editor.background": "#09090b",
    "editor.lineHighlightBackground": "#18181b",
    "editorLineNumber.foreground": "#52525b",
    "editorGutter.background": "#09090b",
  },
});

monaco.editor.defineTheme("grpcui-light", {
  base: "vs",
  inherit: true,
  rules: protoTokenRules.light,
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#f4f4f5",
    "editorLineNumber.foreground": "#a1a1aa",
    "editorGutter.background": "#ffffff",
  },
});

registerProtoLanguage(monaco);

loader.config({ monaco });

// The JSON language service holds one global schema list; keep every model's entry.
const registered = new Map<string, JSONSchema>();

/** Associates the request schema with the editor model at `path`. */
export function registerRequestSchema(path: string, schema: Schema) {
  const uri = monaco.Uri.parse(path).toString();
  registered.set(uri, requestJsonSchema(schema));
  monaco.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    enableSchemaRequest: false,
    schemas: [...registered].map(([fileMatch, schema]) => ({
      uri: `grpcui://schema/${fileMatch}`,
      fileMatch: [fileMatch],
      schema,
    })),
  });
}

export { monaco };
