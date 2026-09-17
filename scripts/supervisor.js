// scripts/supervisor.js - keeps server/index.js running, restarting it if
// it crashes. Usage: npm run serve

const { spawn } = require("child_process");
const path = require("path");

const SERVER_PATH = path.join(__dirname, "..", "server", "index.js");
const MAX_BACKOFF_MS = 30_000;
const STABLE_AFTER_MS = 60_000;

let backoffMs = 1000;

function startServer() {
  console.log(`[supervisor] Starting server (pid will be assigned)...`);
  const startedAt = Date.now();

  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    const ranForMs = Date.now() - startedAt;
    console.log(`[supervisor] Server exited (code=${code}, signal=${signal}) after ${Math.round(ranForMs / 1000)}s`);

    if (ranForMs > STABLE_AFTER_MS) {
      backoffMs = 1000;
    } else {
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }

    console.log(`[supervisor] Restarting in ${backoffMs / 1000}s...`);
    setTimeout(startServer, backoffMs);
  });

  child.on("error", (err) => {
    console.error(`[supervisor] Failed to start server:`, err.message);
  });
}

console.log("[supervisor] Watching server/index.js - Ctrl+C to stop everything.");
startServer();

process.on("SIGINT", () => {
  console.log("\n[supervisor] Shutting down.");
  process.exit(0);
});
