import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const apiTarget = process.env.TOKEN_FLOW_API_TARGET ?? "http://127.0.0.1:19527";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/dashboard": apiTarget,
      "/events": apiTarget,
      "/records": apiTarget,
      "/viewer": apiTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
