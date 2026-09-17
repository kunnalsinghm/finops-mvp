// logger.js - minimal structured logging with daily file rotation.

const fs = require("fs");
const path = require("path");

const LOG_DIR = process.env.FINOPS_LOG_DIR || path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function logFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${day}.log`);
}

function write(level, message, meta) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {}),
  });
  try {
    fs.appendFileSync(logFilePath(), line + "\n");
  } catch {
    // if disk write fails, don't crash the app over logging
  }
  const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  consoleFn(`[${level.toUpperCase()}] ${message}`, meta || "");
}

module.exports = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
};