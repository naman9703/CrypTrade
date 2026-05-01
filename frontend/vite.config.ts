import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Match `PORT=` from `backend/.env` when the dev server’s process env doesn’t already carry PORT. */
function readBackendPortFromEnvFile(): number {
  const envPath = path.resolve(__dirname, "../backend/.env");
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^PORT\s*=\s*(\d+)\s*$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* no backend/.env */
  }
  return 8000;
}

/**
 * Resolve backend URL for the dev proxy.
 * Important: if you start the API with `PORT=8020` in the shell (or from the repo root), Node uses that
 * port even when backend/.env says 8000. The Vite process inherits the same PORT, so we must honor
 * `process.env.PORT` here or login/`/api` calls fail with "Failed to fetch".
 */
function resolveDevApiProxyTarget(mode: string): string {
  const env = loadEnv(mode, __dirname, "VITE_");
  const explicitTarget = (env.VITE_DEV_API_TARGET || process.env.VITE_DEV_API_TARGET || "").trim().replace(/\/$/, "");
  if (explicitTarget) return explicitTarget;

  const backendPort = Number(
    env.VITE_DEV_API_PORT ||
      process.env.VITE_DEV_API_PORT ||
      process.env.BACKEND_PORT ||
      process.env.PORT ||
      readBackendPortFromEnvFile() ||
      8000,
  );
  const port = Number.isFinite(backendPort) && backendPort > 0 ? backendPort : 8000;
  return `http://127.0.0.1:${port}`;
}

export default defineConfig(({ mode }) => {
  const proxyTarget = resolveDevApiProxyTarget(mode);
  console.info(`[vite] proxy /api and /ws → ${proxyTarget}`);

  return {
    plugins: [react()],
    publicDir: path.resolve(__dirname, "../public"),
    server: {
      port: 5173,
      proxy: {
        "/api": { target: proxyTarget, changeOrigin: true },
        "/ws": { target: proxyTarget, ws: true, changeOrigin: true },
      },
    },
  };
});
