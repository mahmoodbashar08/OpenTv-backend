/**
 * Workers KV, spoken by a table in the same SQLite file.
 *
 * KV holds two kinds of thing here and neither wants a second server: the
 * session epoch (read on every authenticated request, written when somebody
 * revokes) and the rate limiters' counters. Both are small, both are per
 * instance, and both are already next to the data they describe.
 *
 * EXPIRY IS CHECKED ON READ, not swept. A cron that deletes expired rows would
 * be a second moving part for a table that holds a few hundred keys; a `WHERE
 * expires_at > ?` costs nothing on an index. Rows do accumulate — one per rate
 * limit window — so the read also deletes what it finds dead, which keeps the
 * table proportional to traffic rather than to uptime.
 *
 * THE TYPE ARGUMENT MATTERS, and this is the bug the test double had first:
 * real KV parses when asked for 'json' and returns a string otherwise. A shim
 * that always returns the string makes every `get(key, 'json')` read as a miss,
 * which silently disables every rate limiter while appearing to work.
 */
import type Database from 'better-sqlite3';

export function sqliteKv(db: Database.Database): KVNamespace {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at);
  `);

  const read = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
  const write = db.prepare(
    'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
  );
  const drop = db.prepare('DELETE FROM kv WHERE key = ?');

  return {
    async get(key: string, type?: string) {
      const row = read.get(key) as { value: string; expires_at: number | null } | undefined;
      if (!row) return null;
      if (row.expires_at != null && row.expires_at <= Date.now()) {
        drop.run(key);
        return null;
      }
      if (type !== 'json') return row.value;
      try {
        return JSON.parse(row.value);
      } catch {
        // Unparseable is a miss, not a crash: KV holds cache, and a corrupt
        // entry should cost a recompute rather than a request.
        return null;
      }
    },

    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const ttl = opts?.expirationTtl;
      write.run(key, value, ttl ? Date.now() + ttl * 1000 : null);
    },

    async delete(key: string) {
      drop.run(key);
    },
  } as unknown as KVNamespace;
}
