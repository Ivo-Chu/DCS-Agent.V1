import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    emptyOutDir: false,
    lib: { entry: "src/dcs-glass.tsx", name: "DcsAgentGlassBundle", formats: ["iife"], fileName: () => "assets/dcs-glass.js" },
  },
});
