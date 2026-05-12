import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ command }) => ({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  optimizeDeps: {
    include: ["mammoth"],
  },
  // Strip console.* and debugger statements from the production bundle
  // (the .dmg) so we don't ship developer console noise. Dev mode keeps
  // them — `command` is "serve" during `vite dev`, "build" for `vite build`.
  esbuild: command === "build"
    ? { drop: ["console", "debugger"] }
    : {},
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/pdfjs-dist")) return "vendor-pdfjs";
          if (id.includes("node_modules/cytoscape")) return "vendor-cytoscape";
          if (id.includes("node_modules/mammoth")) return "vendor-mammoth";
          if (id.includes("node_modules/marked")) return "vendor-marked";
          if (id.includes("node_modules/d3-")) return "vendor-d3";
          if (id.includes("node_modules/")) return "vendor-misc";
        },
      },
    },
  },
}));
