// Highlighting for the Definition tab's generated proto source. Monaco's
// built-in protobuf grammar expects a full file (starting with `syntax = ...`)
// and colours user-defined types like plain identifiers. This one tells apart
// protobuf keywords, built-in types (scalars and google.protobuf.*), the
// service's own types, field names and enum values.
import type * as Monaco from "monaco-editor";

export const PROTO_LANGUAGE = "grpcui-proto";

const keywords = [
  "syntax", "package", "import", "option", "message", "enum", "service", "rpc",
  "returns", "stream", "repeated", "optional", "required", "oneof", "map",
  "reserved", "extensions", "extend", "group", "to", "max", "true", "false",
];

const scalars = [
  "double", "float", "int32", "int64", "uint32", "uint64", "sint32", "sint64",
  "fixed32", "fixed64", "sfixed32", "sfixed64", "bool", "string", "bytes",
];

// Shared by the field-type and fallback rules.
const classify = {
  cases: {
    "@keywords": "keyword",
    "@scalars": "type.builtin",
    "\\.?google\\.protobuf\\.\\w+": "type.builtin",
    "[A-Z][A-Z0-9_]*": "constant", // ENUM_VALUE
    "\\.?(?:\\w+\\.)*[A-Z]\\w*": "type.user", // Message, pkg.Message
    "@default": "variable",
  },
};

const grammar: Monaco.languages.IMonarchLanguage = {
  tokenPostfix: ".proto",
  keywords,
  scalars,
  qualified: /\.?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/,
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/\b(message|enum|service|group|extend)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "type.declaration"]],
      [/\b(oneof)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "variable"]],
      [/\b(rpc)(\s+)([A-Za-z_]\w*)/, ["keyword", "", "function"]],
      // "<type> <field> = N": the type in field position, whatever its casing
      [/(@qualified)(\s+)([A-Za-z_]\w*)(?=\s*=)/, [
        { cases: { ...classify.cases, "[A-Z][A-Z0-9_]*": "type.user", "@default": "type.user" } },
        "",
        "variable",
      ]],
      [/@qualified/, classify],
      [/0[xX][0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/[{}()[\]<>]/, "@brackets"],
      [/[=;,.]/, "delimiter"],
    ],
    comment: [
      [/[^*/]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[*/]/, "comment"],
    ],
  },
};

export function registerProtoLanguage(monaco: typeof Monaco) {
  monaco.languages.register({ id: PROTO_LANGUAGE });
  monaco.languages.setLanguageConfiguration(PROTO_LANGUAGE, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  });
  monaco.languages.setMonarchTokensProvider(PROTO_LANGUAGE, grammar);
}

/** Token colours, VS Code's Dark+/Light+ palette. */
export const protoTokenRules = {
  dark: [
    { token: "keyword.proto", foreground: "c586c0" },
    { token: "type.builtin.proto", foreground: "569cd6" },
    { token: "type.user.proto", foreground: "4ec9b0" },
    { token: "type.declaration.proto", foreground: "4ec9b0", fontStyle: "bold" },
    { token: "function.proto", foreground: "dcdcaa", fontStyle: "bold" },
    { token: "variable.proto", foreground: "9cdcfe" },
    { token: "constant.proto", foreground: "4fc1ff" },
    { token: "number.proto", foreground: "b5cea8" },
    { token: "string.proto", foreground: "ce9178" },
    { token: "comment.proto", foreground: "6a9955", fontStyle: "italic" },
    { token: "delimiter.proto", foreground: "808080" },
  ],
  light: [
    { token: "keyword.proto", foreground: "af00db" },
    { token: "type.builtin.proto", foreground: "0000ff" },
    { token: "type.user.proto", foreground: "267f99" },
    { token: "type.declaration.proto", foreground: "267f99", fontStyle: "bold" },
    { token: "function.proto", foreground: "795e26", fontStyle: "bold" },
    { token: "variable.proto", foreground: "001080" },
    { token: "constant.proto", foreground: "0070c1" },
    { token: "number.proto", foreground: "098658" },
    { token: "string.proto", foreground: "a31515" },
    { token: "comment.proto", foreground: "008000", fontStyle: "italic" },
    { token: "delimiter.proto", foreground: "777777" },
  ],
} satisfies Record<string, Monaco.editor.ITokenThemeRule[]>;
