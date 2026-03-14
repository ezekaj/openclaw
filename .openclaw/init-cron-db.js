const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const dbPath = path.join(os.homedir(), '.openclaw/cron/store.db');
console.log('Initializing cron store DB:', dbPath);

const db = new DatabaseSync(dbPath);

// Create schema
db.exec(`
  CREATE TABLE IF NOT EXISTS cron_schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cron_expr TEXT,
    enabled INTEGER DEFAULT 1,
    last_run_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cron_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    error TEXT
  )
`);

// Insert the LinkedIn jobs from jobs.json
const jobsPath = path.join(os.homedir(), '.openclaw/cron/jobs.json');
const jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));

let jobCount = 0;
for (const job of jobsData.jobs || []) {
  if (job.enabled && job.schedule?.kind === 'cron') {
    const safeName = job.name.replace(/'/g, "''");
    const expr = job.schedule.expr;
    db.exec(`
      INSERT OR REPLACE INTO cron_schedules (id, name, cron_expr, enabled)
      VALUES ('${job.id}', '${safeName}', '${expr}', 1)
    `);
    console.log('✓ Added cron job:', job.name, '(' + expr + ')');
    jobCount++;
  }
}

const result = db.prepare('SELECT COUNT(*) as count FROM cron_schedules').get();
console.log(`\nCron store initialized with ${result.count} jobs`);
db.close();
console.log('Done!');
