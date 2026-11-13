import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The shared interface files live one folder up, in intern/interface (written by Engine 1)
  // While developing, /say goes to the website's own small server (npm run serve) if it is running
  server: { fs: { allow: [".."] }, proxy: { "/say": "http://localhost:8787" } },
});
