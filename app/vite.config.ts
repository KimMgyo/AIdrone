import { readFile } from "node:fs/promises";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/**
 * The dev server hands the browser the repository's own H.264 capture, so the
 * mock backend feeds the real renderer real pictures. It is not copied into
 * `public/`: a 3 MB binary duplicated into the app directory would then have
 * to be kept in step with the one the Rust tests decode.
 */
function sampleStream(): Plugin {
  return {
    name: "aidrone-dev-sample-stream",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev/sample.h264", (_request, response) => {
        readFile(new URL("../sample.h264", import.meta.url)).then(
          (bytes) => {
            response.setHeader("Content-Type", "video/h264");
            response.end(bytes);
          },
          (error: unknown) => {
            response.statusCode = 404;
            response.end(String(error));
          },
        );
      });
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [tailwindcss(), sampleStream()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
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
