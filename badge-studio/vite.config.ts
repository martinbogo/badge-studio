import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Which host the editor is built against. The unused implementation is not
// bundled, so the desktop build carries no font table and the web build
// carries no Tauri client.
// @ts-expect-error process is a nodejs global
const target = process.env.BADGE_TARGET === "web" ? "web" : "tauri";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@platform-impl": fileURLToPath(
        new URL(`./src/platform/${target}.ts`, import.meta.url)
      ),
    },
  },


  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // The web build imports the generated glyph table, which lives beside the
    // Rust one at the repository root rather than inside this package.
    fs: { allow: [".."] },
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
