import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_class_data.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; }, async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } });
  return { prepare: sql => stmt(sql), async batch(list) { const out = []; db.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }, close: () => db.close() };
}
