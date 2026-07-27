import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Three entries build to one static root:
//   /        -> index.html      (lightweight landing, no Vue runtime)
//   /app/    -> app/index.html  (workspace SPA)
//   /admin/  -> admin/index.html(admin SPA)
// The Node server serves the output from dist/public and rewrites
// /app/* and /admin/* refreshes back to their entry HTML files.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3013",
        changeOrigin: false,
      },
      // Legacy shared images stay in <repo>/public/assets and are served by
      // the Node server; proxy them during dev.
      "/assets": {
        target: "http://127.0.0.1:3013",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2020",
    manifest: true,
    rollupOptions: {
      input: {
        landing: fileURLToPath(new URL("./index.html", import.meta.url)),
        app: fileURLToPath(new URL("./app/index.html", import.meta.url)),
        admin: fileURLToPath(new URL("./admin/index.html", import.meta.url)),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
