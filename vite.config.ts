import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The viewer is a static SPA. In production the emulator serves dist/web
// itself; in development Vite serves it and forwards the API and the event
// stream to the emulator (`npm run dev` starts both).
const emulator = process.env.EMULATOR_URL ?? "http://127.0.0.1:9180";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": emulator,
      "/events": emulator,
    },
  },
});
