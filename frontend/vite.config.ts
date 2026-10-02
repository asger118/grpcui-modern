import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The Go gateway serves the SPA, possibly under a -base-path, so all asset
// and API URLs are relative. In dev, API calls are proxied to a local gateway.
const gateway = process.env.GRPCUI_GATEWAY ?? "http://localhost:8080";

// The UI only edits JSON (plus protobuf/others via lightweight tokenizers), but
// the full monaco-editor entry also wires up the TypeScript, CSS and HTML
// language services, whose workers add ~9 MB to the embedded binary. Replace
// those registrations with empty modules; syntax highlighting is unaffected.
const unusedLanguageServices =
  /monaco-editor[\\/]esm[\\/]vs[\\/]languages[\\/]features[\\/](typescript|css|html)[\\/]register\.js$/;

function trimMonaco(): Plugin {
  return {
    name: "trim-monaco-language-services",
    enforce: "pre",
    load(id) {
      return unusedLanguageServices.test(id) ? "export {};" : null;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [trimMonaco(), react(), tailwindcss()],
  server: {
    proxy: {
      "/api": gateway,
      "/healthz": gateway,
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
  },
});
