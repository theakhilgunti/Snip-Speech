import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "safari15",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        preview: resolve(__dirname, "preview.html"),
      },
    },
  },
});
