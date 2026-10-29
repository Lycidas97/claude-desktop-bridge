import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, readdir, readFile } from "node:fs/promises";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "local-pdf-assets",
    async configureServer(server) {
      const files = new Map<string, string>();
      for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
        const source = resolve(root, "../../node_modules/pdfjs-dist", directory);
        for (const name of await readdir(source)) files.set(`/pdfjs/${directory}/${name}`, resolve(source, name));
      }
      server.middlewares.use((req, res, next) => {
        const file = files.get(req.url?.split("?")[0] ?? "");
        if (!file) { next(); return; }
        void readFile(file).then((data) => {
          res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
          res.end(data);
        }).catch(next);
      });
    },
    async writeBundle() {
      for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
        await cp(resolve(root, "../../node_modules/pdfjs-dist", directory), resolve(root, "dist/pdfjs", directory), { recursive: true });
      }
    },
  }],
  resolve: {
    alias: {
      "@bridge/protocol": resolve(root, "../../packages/protocol/src/index.ts"),
    },
  },
  server: { port: 5188, strictPort: true },
  preview: { port: 4188, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: true,
    // Keep fonts as real files: inlined data: fonts violate the strict
    // font-src 'self' CSP in index.html and get blocked in packaged builds.
    assetsInlineLimit: (filePath) => (/\.woff2?$/i.test(filePath) ? false : undefined),
  },
});
