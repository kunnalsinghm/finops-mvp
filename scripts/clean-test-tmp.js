// scripts/clean-test-tmp.js - delete scratch SQLite files left in test/ by
// earlier (crashed, interrupted or Windows-locked) runs. Runs as `pretest`.
// Tests name their database after the process id; a stale file whose id is
// reused makes hardcoded fixtures collide (UNIQUE constraint failed).
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "test");
let removed = 0;
for (const name of fs.readdirSync(dir)) {
  if (!/^\.tmp-.*\.db(-wal|-shm)?$/.test(name)) continue;
  try {
    fs.unlinkSync(path.join(dir, name));
    removed++;
  } catch {
    /* in use by a run that is still going; leave it */
  }
}
if (removed) console.log(`clean-test-tmp: removed ${removed} stale test database file(s)`);
