import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      // vite dev 에서 API는 로컬 wrangler dev(8787)로 넘긴다.
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
