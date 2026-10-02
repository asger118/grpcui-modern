import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { monaco } from "../lib/monaco";
import { monacoTheme, useTheme } from "../lib/theme";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  /** "json", or PROTO_LANGUAGE for the Definition tab. */
  language?: string;
  readOnly?: boolean;
  /** Model URI; gives each method its own undo history. */
  path?: string;
  /** Bound to Ctrl/Cmd+Enter inside the editor. */
  onInvoke?: () => void;
}

export function CodeEditor({ value, onChange, language = "json", readOnly, path, onInvoke }: Props) {
  // Monaco keeps the action closure from mount; route through a ref so it
  // always calls the latest handler.
  const theme = useTheme();
  const invokeRef = useRef(onInvoke);
  useEffect(() => {
    invokeRef.current = onInvoke;
  }, [onInvoke]);

  const handleMount: OnMount = (editor) => {
    // addAction (not addCommand) so the binding is scoped to this editor
    editor.addAction({
      id: "grpcui.invoke",
      label: "Invoke RPC",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => invokeRef.current?.(),
    });
  };

  return (
    <Editor
      value={value}
      path={path}
      language={language}
      theme={monacoTheme(theme)}
      onChange={(v) => onChange?.(v ?? "")}
      onMount={handleMount}
      loading={<div className="p-3 text-xs text-zinc-600">Loading editor…</div>}
      options={{
        readOnly,
        domReadOnly: readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        padding: { top: 10, bottom: 10 },
        renderLineHighlight: readOnly ? "none" : "line",
        stickyScroll: { enabled: false },
        folding: true,
        wordWrap: readOnly ? "on" : "off",
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        // enum values are strings, so suggest inside string literals too
        quickSuggestions: { other: true, comments: false, strings: true },
      }}
    />
  );
}
