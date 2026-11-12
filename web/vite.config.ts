import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The shared interface files live one folder up, in intern/interface (written by Engine 1)
  server: { fs: { allow: [".."] } },
});
