import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: `${root}index.html`,
        gift: `${root}gift.html`,
      },
    },
  },
  server: {
    proxy: {
      // vite dev 에서 API는 로컬 wrangler dev(8787)로 넘긴다.
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
