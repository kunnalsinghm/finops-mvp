// test/dbCloseReleasesFile.test.js - tearing a test down with legacyDb.close()
// must release EVERY handle on the SQLite file, so the file can be deleted.
//
// Why: server/db.js and server/storage/sqlite.js each open their own handle on
// the same file. Test teardown called only db.js's close(), leaving storage's
// handle open. Linux lets you unlink an open file; Windows does not (EBUSY),
// and the teardown's `try { unlinkSync } catch {}` swallowed that. Result on
// Windows: one stale .tmp-<test>-<pid>.db per test file per run, and when a
// process id was reused, hardcoded keys already existed -> UNIQUE failures.
//
// The check runs in a child process (so it cannot disturb this one). On Linux
// it looks for a still-open descriptor on the file via /proc; elsewhere it
// tries the unlink itself. Either way "still held" is the failure.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

const CHILD = `
const fs = require("fs");
const dbPath = process.env.FINOPS_DB_PATH;
const legacyDb = require("./server/db");
require("./server/storage"); // opens the second handle, as every test does
legacyDb.close();
let held = false;
try {
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    try { if (fs.readlinkSync("/proc/self/fd/" + fd) === dbPath) held = true; } catch {}
  }
} catch { /* no /proc: fall back to the unlink below */ }
let unlinked = false;
try { fs.unlinkSync(dbPath); unlinked = true; } catch {}
console.log(JSON.stringify({ held, unlinked }));
`;

test("legacyDb.close() releases every handle on the database file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finops-close-"));
  const dbPath = path.join(dir, "t.db");
  try {
    const r = spawnSync(process.execPath, ["-e", CHILD], {
      cwd: ROOT,
      env: { ...process.env, FINOPS_DB_PATH: dbPath, FINOPS_DB_DRIVER: "sqlite" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `child failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.held, false, "a handle on the db file is still open after legacyDb.close()");
    assert.equal(out.unlinked, true, "the db file could not be deleted after legacyDb.close()");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
