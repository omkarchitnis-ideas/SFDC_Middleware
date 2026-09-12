const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const APP_DB_FILE = process.env.APP_DB_FILE || 'app.db';
const dbDir = path.dirname(APP_DB_FILE);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(APP_DB_FILE);
db.pragma('journal_mode = DELETE');
db.pragma('busy_timeout = 10000');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_value TEXT UNIQUE NOT NULL,
    user_name TEXT NOT NULL,
    role TEXT DEFAULT 'user', -- 'admin' or 'user'
    scopes TEXT DEFAULT 'SELECT', -- 'SELECT', 'INSERT', 'UPDATE', 'DELETE', or 'ALL'
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT,
    key_value TEXT,
    endpoint TEXT,
    soql TEXT,
    status_code INTEGER,
    row_count INTEGER,
    execution_time_ms INTEGER,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migration: Ensure scopes column exists in api_keys table
try {
  db.exec(`ALTER TABLE api_keys ADD COLUMN scopes TEXT DEFAULT 'SELECT'`);
} catch (e) {
  // Column already exists
}

// Ensure Master Admin keys have 'ALL' scope
db.prepare(`UPDATE api_keys SET scopes = 'ALL' WHERE role = 'admin' AND (scopes IS NULL OR scopes = 'SELECT')`).run();

// Seed initial Master Admin key if none exists
const keyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys').get().count;
if (keyCount === 0) {
  const masterKey = 'admin_' + crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO api_keys (key_value, user_name, role) VALUES (?, ?, 'admin')
  `).run(masterKey, 'Master Admin');
  console.log('====================================================');
  console.log('INITIAL MASTER ADMIN KEY GENERATED:');
  console.log(masterKey);
  console.log('====================================================');
}

module.exports = db;