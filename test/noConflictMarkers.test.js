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

// Reads each listed file and returns those with a conflict block.
//
// The listing comes from walking the working tree, not from git, so it can
// include a file that another test is creating and deleting at that moment
// (gitops.test.js writes a temporary finops.yaml in the repo root). A file that
// is gone by the time we read it cannot hold a conflict block, so it is
// skipped. Any OTHER read error (permissions, a directory named like a file) is
// real and must still fail the test.
function findConflicted(files) {
  const conflicted = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (hasConflictBlock(text)) conflicted.push(f);
  }
  return conflicted;
}

test("findConflicted: a file that vanishes between listing and reading is skipped, not an error", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "finops-conflict-"));
  try {
    const clean = path.join(dir, "clean.md");
    const bad = path.join(dir, "bad.md");
    const gone = path.join(dir, "gone.md"); // listed, then deleted by another process
    fs.writeFileSync(clean, "all fine\n");
    fs.writeFileSync(bad, [OPEN + "ours", "a", "=".repeat(7), "b", CLOSE + "theirs"].join("\n"));
    assert.deepEqual(findConflicted([clean, gone, bad]), [bad], "the real conflict is still found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findConflicted: a real read error is NOT swallowed", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "finops-conflict-"));
  try {
    const dirNamedLikeAFile = path.join(dir, "folder.md");
    fs.mkdirSync(dirNamedLikeAFile);
    assert.throws(() => findConflicted([dirNamedLikeAFile]), /EISDIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no tracked text file contains an unresolved merge-conflict block", () => {
  const files = walk(ROOT);
  assert.ok(files.length > 50, `walker found only ${files.length} files - it is not looking at the repo`);
  const conflicted = findConflicted(files).map((f) => path.relative(ROOT, f));
  assert.deepEqual(conflicted, [], "resolve these files: they contain a merge-conflict block");
});
