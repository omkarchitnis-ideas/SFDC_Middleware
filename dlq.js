/**
 * Enterprise Dead Letter Queue (DLQ) & Resilient Replay Engine
 * Provides guaranteed zero-data-loss durability for PostgreSQL replication.
 * 
 * If a database connection to sicsappsina6:5433 drops, failed sync records are
 * safely enqueued to local SQLite storage and automatically replayed with
 * exponential backoff upon reconnection.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DLQ_DB_PATH = process.env.DLQ_DB_PATH || path.join(__dirname, 'sync_dlq.db');
const db = new sqlite3.Database(DLQ_DB_PATH);

// Promise wrappers
const runSql = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const getSql = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const allSql = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

let initialized = false;

async function initDlq() {
  if (initialized) return;
  await runSql(`
    CREATE TABLE IF NOT EXISTS dlq_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_table TEXT NOT NULL,
      payload TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_dlq_next_retry ON dlq_records(next_retry_at)`);
  initialized = true;
}

/**
 * Enqueues a failed batch into the DLQ.
 * @param {string} targetTable - e.g. 'tasks', 'cases', 'accounts'
 * @param {Array} records - the records array that failed to sync
 * @param {Error|string} error - failure reason
 */
async function enqueue(targetTable, records, error) {
  if (!Array.isArray(records) || records.length === 0) return;
  await initDlq();
  const errMsg = error ? (error.message || String(error)) : 'Unknown error';
  const payloadStr = JSON.stringify(records);
  
  await runSql(
    `INSERT INTO dlq_records (target_table, payload, record_count, error_message, next_retry_at) 
     VALUES (?, ?, ?, ?, datetime('now', '+30 seconds'))`,
    [targetTable, payloadStr, records.length, errMsg]
  );

  console.warn(`[DLQ] ⚠️ Enqueued ${records.length} '${targetTable}' records into Dead Letter Queue (Reason: ${errMsg})`);
}

/**
 * Replays all pending DLQ items using provided handler processors.
 * @param {Object} processors - Map of table name to async function (e.g. { tasks: pgDb.upsertTasksBatch, cases: pgDb.upsertCasesBatch })
 */
async function replayDlq(processors) {
  await initDlq();
  const pending = await allSql(
    `SELECT id, target_table, payload, record_count, retry_count 
     FROM dlq_records 
     WHERE next_retry_at <= datetime('now') 
     ORDER BY id ASC 
     LIMIT 20`
  );

  if (pending.length === 0) return { replayed: 0, pending: 0 };

  let replayedCount = 0;
  for (const item of pending) {
    const handler = processors[item.target_table];
    if (!handler) {
      console.warn(`[DLQ] No handler registered for table '${item.target_table}'. Skipping id ${item.id}.`);
      continue;
    }

    try {
      const records = JSON.parse(item.payload);
      await handler(records);
      await runSql(`DELETE FROM dlq_records WHERE id = ?`, [item.id]);
      replayedCount += item.record_count;
      console.log(`[DLQ] ✅ Successfully replayed ${item.record_count} '${item.target_table}' records from DLQ.`);
    } catch (replayErr) {
      const nextDelaySec = Math.min(30 * Math.pow(2, item.retry_count + 1), 900); // Exponential backoff up to 15 mins
      await runSql(
        `UPDATE dlq_records 
         SET retry_count = retry_count + 1,
             error_message = ?,
             next_retry_at = datetime('now', '+' || ? || ' seconds')
         WHERE id = ?`,
        [replayErr.message, nextDelaySec, item.id]
      );
      console.warn(`[DLQ] ❌ Replay failed for id ${item.id} (${item.target_table}): ${replayErr.message}. Next retry in ${nextDelaySec}s.`);
    }
  }

  const remaining = await getSql(`SELECT count(*) as c FROM dlq_records`);
  return { replayed: replayedCount, pending: remaining ? remaining.c : 0 };
}

/**
 * Returns DLQ metrics for monitoring and healthchecks.
 */
async function getDlqStats() {
  await initDlq();
  const row = await getSql(`
    SELECT 
      count(*) as total_queued,
      COALESCE(sum(record_count), 0) as total_records,
      min(created_at) as oldest_queued_at
    FROM dlq_records
  `);
  return row;
}

let dlqInterval = null;

function startDlqReplayWorker(processors, intervalMs = 30000) {
  if (dlqInterval) return;
  initDlq();
  dlqInterval = setInterval(async () => {
    try {
      await replayDlq(processors);
    } catch (e) {
      console.warn('[DLQ Worker] Periodic replay error:', e.message);
    }
  }, intervalMs);
  console.log(`[DLQ Engine] Resilient Replay Worker active (Polling every ${intervalMs / 1000}s)`);
}

module.exports = {
  enqueue,
  replayDlq,
  getDlqStats,
  startDlqReplayWorker
};
