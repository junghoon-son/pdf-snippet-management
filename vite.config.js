import { defineConfig, loadEnv } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Dev-only middleware that runs the authenticated AI proxy locally, so
// `bun run dev` exercises the exact same handler the Vercel function uses
// (api/_reader-handler.js). Reads secrets from .env.local via loadEnv.
function aiProxyDevPlugin(env) {
  return {
    name: "ai-proxy-dev",
    configureServer(server) {
      server.middlewares.use("/api/ai/reader", async (req, res, next) => {
        if (req.method !== "POST") return next();
        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const auth = req.headers.authorization || "";
          const { handleReader } = await import("./api/_reader-handler.js");
          const result = await handleReader({
            token: auth.startsWith("Bearer ") ? auth.slice(7) : "",
            body: raw ? JSON.parse(raw) : {},
            secretKey: env.CLERK_SECRET_KEY,
            geminiKey: env.GEMINI_API_KEY,
            model: env.GEMINI_MODEL,
          });
          res.statusCode = result.status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result.json));
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "dev proxy error: " + (err?.message || "unknown") }));
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  clearScreen: false,
  plugins: [aiProxyDevPlugin(loadEnv(mode, process.cwd(), ""))],
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
