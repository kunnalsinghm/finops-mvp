// test/noConflictMarkers.test.js - no committed file may contain an unresolved
// merge-conflict block.
//
// Why this exists: README.md shipped with a literal `<<<<<<< ours` /
// `=======` / `>>>>>>> theirs` block (commit 98d27e8) and stayed on main for
// weeks, because nothing reads the README. It is the kind of mistake a test
// catches for free.
//
// A file counts as conflicted only if it has BOTH an opening `<<<<<<< ` line
// and a closing `>>>>>>> ` line. A lone `=======` is deliberately not enough:
// it is a legitimate Markdown heading underline.
//
// The marker strings are built by concatenation so this file does not itself
// contain a line that starts with one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const OPEN = "<".repeat(7) + " ";
const CLOSE = ">".repeat(7) + " ";
const SKIP_DIRS = new Set(["node_modules", ".git", "data", "logs", "backups", "backups-postgres"]);
const TEXT_EXT = new Set([".md", ".js", ".json", ".yml", ".yaml", ".html", ".css", ".txt", ".example", ".sql", ".ps1"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (TEXT_EXT.has(path.extname(entry.name)) || entry.name === "Dockerfile") {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Pure, so it can be tested against fixtures without touching the repo.
function hasConflictBlock(text) {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.startsWith(OPEN));
  if (open === -1) return false;
  return lines.some((l, i) => i > open && l.startsWith(CLOSE));
}

test("hasConflictBlock: detects a real block, ignores a lone heading underline", () => {
  const block = ["text", OPEN + "ours", "a", "=".repeat(7), "b", CLOSE + "theirs", "more"].join("\n");
  assert.equal(hasConflictBlock(block), true);
  assert.equal(hasConflictBlock(["Title", "=".repeat(7), "body"].join("\n")), false, "setext heading");
  assert.equal(hasConflictBlock([OPEN + "ours", "no closing marker"].join("\n")), false, "needs both ends");
  assert.equal(hasConflictBlock(["x", CLOSE + "theirs", OPEN + "ours"].join("\n")), false, "close before open");
  assert.equal(hasConflictBlock(block.replace(/\n/g, "\r\n")), true, "CRLF files too");
});

test("no tracked text file contains an unresolved merge-conflict block", () => {
  const files = walk(ROOT);
  assert.ok(files.length > 50, `walker found only ${files.length} files - it is not looking at the repo`);
  const conflicted = files.filter((f) => hasConflictBlock(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(conflicted, [], "resolve these files: they contain a merge-conflict block");
});
