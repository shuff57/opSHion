// /api/classdata/*  -- anonymous class data for the statistics Investigate simulations.
// Plan: projects/Introduction to Stats/factory/plans/classdata-ch5.md  Migration: migrations/0016_class_data.sql  Test: functions/api/classdata.test.mjs
//
//   POST   /api/classdata/class    {}                                  -> { code, teacherKey }
//   POST   /api/classdata/value    { code, topic, value, device }      -> { ok, n }          (upsert per device, topic, class)
//   GET    /api/classdata/values?code=&topic=   [X-Teacher-Key]        -> { code, topic, n, values, updated[, ids] }
//   DELETE /api/classdata/value    { code, teacherKey, id }            -> { ok }
// Tallies (2026-11-13, migration 0017): a chance-process Investigate pools REAL trials; one device sends a count per outcome.
//   POST   /api/classdata/tally    { code, topic, counts, device }     -> { ok, total, devices }   (upsert per device; all zeros removes it)
//   GET    /api/classdata/tallies?code=&topic=  [X-Teacher-Key]       -> { code, topic, outcomes, counts, total, devices, updated[, rows] }
//   DELETE /api/classdata/tally    { code, teacherKey, id }            -> { ok }
// Records (chapters 1 and 2, 2026-11-14, migration 0018; notes: projects/Introduction to Stats/factory/plans/classdata-ch12-api.md):
//   POST   /api/classdata/record   { code, topic, device, values: { field: number, ... } }  -> { ok, n[, group] }   (merge per device)
//   POST   /api/classdata/assign   { code, topic, device }             -> { ok, group, n }   (randomised topics: 0 = A, 1 = B; never changes)
//   GET    /api/classdata/values?code=&topic=&field=                   -> { code, topic, field, n, values, updated[, ids] }   (one field)
//   GET    /api/classdata/values?codes=A,B&topic=[&field=]             -> { codes, topic[, field], n, values, per, updated }  (pooled, no ids)
//   GET    /api/classdata/records?code=&topic=  [X-Teacher-Key]        -> { code, topic, fields, n, rows, updated[, ids] }
//   DELETE /api/classdata/record   { code, teacherKey, id }            -> { ok }             (removes every field of one record)
// Rate limits: one unit per write (a whole record is one unit), counted per IP (a loose backstop: a school network shares one IP) AND
// per class code (what bounds one class), both daily.
//
// Numbers only: no names, no free text, no accounts. Only hashes are stored: the teacher key (SHA-256), and the device id (SHA-256 of
// "<code>:<device>"). IPs are used only inside a hashed rate-limit key and are never stored or logged next to a value.
// Same origin only: no CORS headers are ever sent, and a write whose Origin header names another site is refused. Every response is no-store.
import { CODE_ALPHABET, CODE_RE, getTopic, getTallyTopic, getRecordTopic, getField, storageKey, toStored, fromStored } from '../../_lib/classdata_topics.js';

const CLASSES_PER_IP_DAY = 100;       // a school network shares one IP: six teachers with five periods each is 30 codes
const VALUES_PER_IP_DAY = 5000;       // writes per IP: a loose backstop now that each class has its own count (was 200, 2026-11-14)
const WRITES_PER_CLASS_DAY = 2000;    // writes per class code: a class of 40 re-entering every field of every activity stays far under it
const MAX_RECORDS_PER_TOPIC = 2000;   // per class and record topic, as MAX_VALUES_PER_TOPIC
const MAX_POOLED_CODES = 12;
const MAX_VALUES_PER_TOPIC = 2000;   // per class and topic: bounds what a script minting device ids can store
const TALLIES_PER_IP_DAY = 3000;    // a tally is re-sent as real trials are entered (the page waits a moment after each entry)
const MAX_TALLIES_PER_TOPIC = 500;   // devices per class and tally topic
const RETENTION_DAYS = 400;
const MAX_BODY = 2048;

const json = (obj, status = 200, extra) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) },
});
const err = (message, status, extra) => json({ error: message }, status, extra);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

function randomCode() {
  let out = '';
  const limit = 256 - (256 % CODE_ALPHABET.length);   // reject the top bytes so every character is equally likely
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(12))) {
      if (b < limit && out.length < 6) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}
function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');   // 32 chars, URL safe
}
const sameText = (a, b) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const normCode = raw => (typeof raw === 'string' ? raw.trim().toUpperCase() : '');
const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: err('Request body too large.', 413) };
  let body;
  try { body = JSON.parse(text || '{}'); } catch { return { error: err('Invalid JSON body.', 400) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: err('Body must be a JSON object.', 400) };
  return { body };
}

// Per-IP daily counter in the shared ai_chat_usage table. The IP only ever appears hashed. Returns false when over the limit.
async function charge(env, request, kind, limit) {
  const ip = (request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return null;   // no identifiable requester: refuse rather than lump everyone in one bucket
  const key = `cd:${kind}:${(await sha256('classdata|' + ip)).slice(0, 32)}`;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO ai_chat_usage (client_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(client_id, day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`,
  ).bind(key, day, limit).first();
  return !!row;
}
// Per class code daily counter, same table. The code is hashed too, so the usage table never lists class codes.
async function chargeClass(env, code, limit) {
  const key = `cd:k:${(await sha256('classdata|class|' + code)).slice(0, 32)}`;
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `INSERT INTO ai_chat_usage (client_id, day, count) VALUES (?, ?, 1)
     ON CONFLICT(client_id, day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`,
  ).bind(key, day, limit).first();
  return !!row;
}
const CLASS_FULL_TODAY = 'This class has sent its daily limit of answers. Try again tomorrow (resets at midnight UTC).';
const limitOf = (raw, d) => { const n = parseInt(raw || '', 10); return Number.isFinite(n) && n >= 1 ? n : d; };

async function findClass(env, code) {
  return env.DB.prepare('SELECT code, teacher_key_hash FROM classes WHERE code = ?').bind(code).first();
}
async function keyMatches(cls, key) {
  return typeof key === 'string' && KEY_RE.test(key) && sameText(await sha256(key), cls.teacher_key_hash);
}

async function createClass(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  void body;
  const ok = await charge(env, request, 'c', limitOf(env.CLASSDATA_CLASS_DAILY_LIMIT, CLASSES_PER_IP_DAY));
  if (ok === null) return err('Cannot identify requester.', 503);
  if (!ok) return err('This network has made its daily limit of class codes. Try again tomorrow (resets at midnight UTC).', 429);

  // Lazy retention sweep: values first, then the classes they belonged to.
  const cutoff = `-${RETENTION_DAYS} days`;
  // Tallies first, on their own: the class_tallies table (0017) may not exist yet, and its absence must not stop class codes.
  try {
    await env.DB.prepare(`DELETE FROM class_tallies WHERE code IN (SELECT code FROM classes WHERE created_at < datetime('now', ?))`).bind(cutoff).run();
  } catch { /* 0017 not applied: nothing to sweep */ }
  // Records first, on their own: the class_records table (0018) may not exist yet, and its absence must not stop class codes.
  try {
    await env.DB.prepare(`DELETE FROM class_records WHERE code IN (SELECT code FROM classes WHERE created_at < datetime('now', ?))`).bind(cutoff).run();
  } catch { /* 0018 not applied: nothing to sweep */ }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM class_values WHERE code IN (SELECT code FROM classes WHERE created_at < datetime('now', ?))`).bind(cutoff),
    env.DB.prepare(`DELETE FROM classes WHERE created_at < datetime('now', ?)`).bind(cutoff),
  ]);

  const teacherKey = randomKey();
  const hash = await sha256(teacherKey);
  for (let tries = 0; tries < 8; tries++) {
    const code = randomCode();
    const res = await env.DB.prepare('INSERT OR IGNORE INTO classes (code, teacher_key_hash) VALUES (?, ?)').bind(code, hash).run();
    if (res && res.meta && res.meta.changes > 0) return json({ code, teacherKey }, 201);
  }
  return err('Could not make a class code. Try again.', 503);
}

async function putValue(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  const topic = getTopic(body.topic);
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown topic.', 400);
  if (!Number.isInteger(body.value) || body.value < topic.min || body.value > topic.max) {
    return err(`Value must be a whole number from ${topic.min} to ${topic.max} (${topic.unit}).`, 400);
  }
  if (typeof body.device !== 'string' || !DEVICE_RE.test(body.device)) return err('Device id must be 16 to 64 letters, digits, - or _.', 400);

  // Charged before the class lookup, so guessing codes costs the same as posting.
  const ok = await charge(env, request, 'v', limitOf(env.CLASSDATA_VALUE_DAILY_LIMIT, VALUES_PER_IP_DAY));
  if (ok === null) return err('Cannot identify requester.', 503);
  if (!ok) return err('This network has sent its daily limit of values. Try again tomorrow (resets at midnight UTC).', 429);

  if (!(await findClass(env, code))) return err('No class with that code.', 404);
  if (!(await chargeClass(env, code, limitOf(env.CLASSDATA_CLASS_WRITE_DAILY_LIMIT, WRITES_PER_CLASS_DAY)))) return err(CLASS_FULL_TODAY, 429);
  const deviceHash = await sha256(`${code}:${body.device}`);
  const existing = await env.DB.prepare('SELECT id FROM class_values WHERE code = ? AND topic = ? AND device_hash = ?').bind(code, topic.id, deviceHash).first();
  if (!existing) {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_values WHERE code = ? AND topic = ?').bind(code, topic.id).first();
    if (c && c.n >= MAX_VALUES_PER_TOPIC) return err('This class is full for that topic.', 409);
  }
  await env.DB.prepare(
    `INSERT INTO class_values (code, topic, value, device_hash) VALUES (?, ?, ?, ?)
     ON CONFLICT(code, topic, device_hash) DO UPDATE SET value = excluded.value, created_at = datetime('now')`,
  ).bind(code, topic.id, body.value, deviceHash).run();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_values WHERE code = ? AND topic = ?').bind(code, topic.id).first();
  return json({ ok: true, n: n ? n.n : 0 });
}

async function getValues(url, request, env) {
  if (url.searchParams.has('codes')) return getPooledValues(url, env);
  if (getRecordTopic(url.searchParams.get('topic'))) return getFieldValues(url, request, env);
  if (url.searchParams.has('field')) return err('That topic has no fields.', 400);
  const code = normCode(url.searchParams.get('code'));
  const topic = getTopic(url.searchParams.get('topic'));
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown topic.', 400);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  const teacherKey = request.headers.get('X-Teacher-Key');
  const isTeacher = teacherKey !== null && teacherKey !== '';
  if (isTeacher && !(await keyMatches(cls, teacherKey.trim()))) return err('Wrong teacher key.', 403);
  const rows = await env.DB.prepare(
    'SELECT id, value, created_at FROM class_values WHERE code = ? AND topic = ? ORDER BY value, id LIMIT ?',
  ).bind(code, topic.id, MAX_VALUES_PER_TOPIC).all();
  const list = (rows && rows.results) || [];
  const out = { code, topic: topic.id, n: list.length, values: list.map(r => r.value), updated: list.reduce((m, r) => (r.created_at > m ? r.created_at : m), '') || null };
  if (isTeacher) out.ids = list.map(r => r.id);
  return json(out);
}

async function deleteValue(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!Number.isInteger(body.id) || body.id < 1) return err('id must be a positive integer.', 400);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  if (!(await keyMatches(cls, body.teacherKey))) return err('Wrong teacher key.', 403);
  const res = await env.DB.prepare('DELETE FROM class_values WHERE id = ? AND code = ?').bind(body.id, code).run();
  if (!res || !res.meta || res.meta.changes < 1) return err('No such value in this class.', 404);
  return json({ ok: true });
}

// ---------- tallies ----------
function tallyOut(topic, rows) {
  const counts = topic.outcomes.map(() => 0);
  let total = 0, updated = '';
  for (const r of rows) {
    let c;
    try { c = JSON.parse(r.counts); } catch { continue; }
    if (!Array.isArray(c) || c.length !== counts.length) continue;   // a row written under another outcome list is skipped, never mis-added
    for (let i = 0; i < counts.length; i++) counts[i] += Number.isInteger(c[i]) && c[i] >= 0 ? c[i] : 0;
    total += r.total;
    if (r.updated_at > updated) updated = r.updated_at;
  }
  return { counts, total, devices: rows.length, updated: updated || null };
}

async function putTally(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  const topic = getTallyTopic(body.topic);
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown tally topic.', 400);
  const c = body.counts, k = topic.outcomes.length;
  if (!Array.isArray(c) || c.length !== k || !c.every(v => Number.isInteger(v) && v >= 0)) {
    return err(`counts must be ${k} whole numbers (0 or more), one for each of: ${topic.outcomes.join(', ')}.`, 400);
  }
  const total = c.reduce((a, b) => a + b, 0);
  if (total > topic.maxTotal) return err(`One device can send at most ${topic.maxTotal} ${topic.noun === 'toss' ? 'tosses' : topic.noun + 's'}.`, 400);
  if (typeof body.device !== 'string' || !DEVICE_RE.test(body.device)) return err('Device id must be 16 to 64 letters, digits, - or _.', 400);

  const ok = await charge(env, request, 't', limitOf(env.CLASSDATA_TALLY_DAILY_LIMIT, TALLIES_PER_IP_DAY));
  if (ok === null) return err('Cannot identify requester.', 503);
  if (!ok) return err('This network has sent its daily limit of tallies. Try again tomorrow (resets at midnight UTC).', 429);

  if (!(await findClass(env, code))) return err('No class with that code.', 404);
  const deviceHash = await sha256(`${code}:${body.device}`);
  if (total === 0) {
    await env.DB.prepare('DELETE FROM class_tallies WHERE code = ? AND topic = ? AND device_hash = ?').bind(code, topic.id, deviceHash).run();
  } else {
    const existing = await env.DB.prepare('SELECT id FROM class_tallies WHERE code = ? AND topic = ? AND device_hash = ?').bind(code, topic.id, deviceHash).first();
    if (!existing) {
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_tallies WHERE code = ? AND topic = ?').bind(code, topic.id).first();
      if (n && n.n >= MAX_TALLIES_PER_TOPIC) return err('This class is full for that topic.', 409);
    }
    await env.DB.prepare(
      `INSERT INTO class_tallies (code, topic, counts, total, device_hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(code, topic, device_hash) DO UPDATE SET counts = excluded.counts, total = excluded.total, updated_at = datetime('now')`,
    ).bind(code, topic.id, JSON.stringify(c), total, deviceHash).run();
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_tallies WHERE code = ? AND topic = ?').bind(code, topic.id).first();
  return json({ ok: true, total, devices: n ? n.n : 0 });
}

async function getTallies(url, request, env) {
  const code = normCode(url.searchParams.get('code'));
  const topic = getTallyTopic(url.searchParams.get('topic'));
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown tally topic.', 400);
  // The table is read BEFORE the class is looked up, so a page's probe (a made-up code) gets 404 only when the tally table exists:
  // without migration 0017 it gets the JSON 500 and says "Class data is not connected yet".
  const res = await env.DB.prepare(
    'SELECT id, counts, total, updated_at FROM class_tallies WHERE code = ? AND topic = ? ORDER BY id LIMIT ?',
  ).bind(code, topic.id, MAX_TALLIES_PER_TOPIC).all();
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  const teacherKey = request.headers.get('X-Teacher-Key');
  const isTeacher = teacherKey !== null && teacherKey !== '';
  if (isTeacher && !(await keyMatches(cls, teacherKey.trim()))) return err('Wrong teacher key.', 403);
  const rows = (res && res.results) || [];
  const out = { code, topic: topic.id, outcomes: topic.outcomes.slice(), ...tallyOut(topic, rows) };
  if (isTeacher) out.rows = rows.map(r => ({ id: r.id, total: r.total, counts: JSON.parse(r.counts) }));
  return json(out);
}

async function deleteTally(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!Number.isInteger(body.id) || body.id < 1) return err('id must be a positive integer.', 400);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  if (!(await keyMatches(cls, body.teacherKey))) return err('Wrong teacher key.', 403);
  const res = await env.DB.prepare('DELETE FROM class_tallies WHERE id = ? AND code = ?').bind(body.id, code).run();
  if (!res || !res.meta || res.meta.changes < 1) return err('No such tally in this class.', 404);
  return json({ ok: true });
}

// ---------- records (0018) ----------
const coin = () => crypto.getRandomValues(new Uint8Array(1))[0] & 1;
const keysOf = topic => topic.fields.map(f => storageKey(topic, f));
const marks = n => Array(n).fill('?').join(', ');

// Read class_records BEFORE the class is looked up, so without migration 0018 a page's probe gets the JSON 500 (and says "Class data is
// not connected yet") instead of a 404 that would make it offer a class it cannot write to.
async function recordsTableReady(env, code) {
  await env.DB.prepare('SELECT id FROM class_records WHERE code = ? LIMIT 1').bind(code).first();
}
async function findRecord(env, code, topic, deviceHash) {
  return env.DB.prepare('SELECT id, grp FROM class_records WHERE code = ? AND topic = ? AND device_hash = ?').bind(code, topic.id, deviceHash).first();
}
async function countRecords(env, code, topic) {
  const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_records WHERE code = ? AND topic = ?').bind(code, topic.id).first();
  return c ? c.n : 0;
}
// Make the device's record if it has none. A randomised topic gets its group here, in ONE statement (so two arrivals cannot both read
// the same block): the next seq of the class and topic; an even seq takes a fair coin, an odd seq takes the group its block partner did
// not. Returns { id, grp } or { full: true }.
async function ensureRecord(env, code, topic, deviceHash) {
  const have = await findRecord(env, code, topic, deviceHash);
  if (have) return have;
  if ((await countRecords(env, code, topic)) >= MAX_RECORDS_PER_TOPIC) return { full: true };
  if (topic.randomize) {
    await env.DB.prepare(
      `INSERT INTO class_records (code, topic, device_hash, seq, grp)
       SELECT ?1, ?2, ?3, s.n, CASE WHEN s.n % 2 = 1
         THEN 1 - COALESCE((SELECT grp FROM class_records WHERE code = ?1 AND topic = ?2 AND seq = s.n - 1), ?4)
         ELSE ?4 END
       FROM (SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM class_records WHERE code = ?1 AND topic = ?2) AS s WHERE true
       ON CONFLICT (code, topic, device_hash) DO NOTHING`,
    ).bind(code, topic.id, deviceHash, coin()).run();
  } else {
    await env.DB.prepare('INSERT INTO class_records (code, topic, device_hash) VALUES (?, ?, ?) ON CONFLICT (code, topic, device_hash) DO NOTHING')
      .bind(code, topic.id, deviceHash).run();
  }
  return findRecord(env, code, topic, deviceHash);
}

// The checks every record write shares, in the order putValue uses: shape first (a malformed request spends nothing), then the
// per-IP charge, the class, the table, the per-class charge.
function recordShapeError(body, topic, code) {
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown topic.', 400);
  if (typeof body.device !== 'string' || !DEVICE_RE.test(body.device)) return err('Device id must be 16 to 64 letters, digits, - or _.', 400);
  return null;
}
async function recordWriteCharge(request, env, code) {
  const ok = await charge(env, request, 'v', limitOf(env.CLASSDATA_VALUE_DAILY_LIMIT, VALUES_PER_IP_DAY));
  if (ok === null) return err('Cannot identify requester.', 503);
  if (!ok) return err('This network has sent its daily limit of values. Try again tomorrow (resets at midnight UTC).', 429);
  await recordsTableReady(env, code);
  if (!(await findClass(env, code))) return err('No class with that code.', 404);
  if (!(await chargeClass(env, code, limitOf(env.CLASSDATA_CLASS_WRITE_DAILY_LIMIT, WRITES_PER_CLASS_DAY)))) return err(CLASS_FULL_TODAY, 429);
  return null;
}

async function putRecord(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  const topic = getRecordTopic(body.topic);
  const bad = recordShapeError(body, topic, code);
  if (bad) return bad;
  const v = body.values;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).length) return err('values must be an object of field: number.', 400);
  const stored = [];
  for (const id of Object.keys(v)) {
    const f = getField(topic, id);
    if (!f) return err(id === 'group' ? 'The group is set by the server (POST /api/classdata/assign).' : `Unknown field ${id} for ${topic.id}.`, 400);
    const r = toStored(f, v[id]);
    if (r.error) return err(r.error, 400);
    stored.push({ f, key: storageKey(topic, f), value: r.value });
  }

  const stop = await recordWriteCharge(request, env, code);
  if (stop) return stop;
  const deviceHash = await sha256(`${code}:${body.device}`);
  if (stored.some(s => s.f.afterAssign)) {
    const have = await findRecord(env, code, topic, deviceHash);
    if (!have || have.grp === null || have.grp === undefined) return err('Get your question first: the group comes before the answer.', 409);
  }
  for (const s of stored) {   // the per-key cap holds for a new device, not for one replacing its own value
    const ex = await env.DB.prepare('SELECT id FROM class_values WHERE code = ? AND topic = ? AND device_hash = ?').bind(code, s.key, deviceHash).first();
    if (!ex) {
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM class_values WHERE code = ? AND topic = ?').bind(code, s.key).first();
      if (c && c.n >= MAX_VALUES_PER_TOPIC) return err('This class is full for that topic.', 409);
    }
  }
  const rec = await ensureRecord(env, code, topic, deviceHash);
  if (!rec || rec.full) return err('This class is full for that topic.', 409);
  await env.DB.batch([
    ...stored.map(s => env.DB.prepare(
      `INSERT INTO class_values (code, topic, value, device_hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(code, topic, device_hash) DO UPDATE SET value = excluded.value, created_at = datetime('now')`,
    ).bind(code, s.key, s.value, deviceHash)),
    env.DB.prepare(`UPDATE class_records SET updated_at = datetime('now') WHERE id = ?`).bind(rec.id),
  ]);
  const out = { ok: true, n: await countRecords(env, code, topic) };
  if (topic.randomize) out.group = rec.grp;
  return json(out);
}

async function assignGroup(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  const topic = getRecordTopic(body.topic);
  const bad = recordShapeError(body, topic, code);
  if (bad) return bad;
  if (!topic.randomize) return err('That topic has no groups.', 400);
  const stop = await recordWriteCharge(request, env, code);
  if (stop) return stop;
  const rec = await ensureRecord(env, code, topic, await sha256(`${code}:${body.device}`));
  if (!rec || rec.full) return err('This class is full for that topic.', 409);
  return json({ ok: true, group: rec.grp, n: await countRecords(env, code, topic) });
}

// One field of a record topic, sorted: the same shape as a chapter 5 topic's values.
async function getFieldValues(url, request, env) {
  const code = normCode(url.searchParams.get('code'));
  const topic = getRecordTopic(url.searchParams.get('topic'));
  const f = getField(topic, url.searchParams.get('field'));
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!f) return err(`field must be one of: ${topic.fields.map(x => x.id).join(', ')}.`, 400);
  await recordsTableReady(env, code);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  const teacherKey = request.headers.get('X-Teacher-Key');
  const isTeacher = teacherKey !== null && teacherKey !== '';
  if (isTeacher && !(await keyMatches(cls, teacherKey.trim()))) return err('Wrong teacher key.', 403);
  const rows = await env.DB.prepare(
    'SELECT id, value, created_at FROM class_values WHERE code = ? AND topic = ? ORDER BY value, id LIMIT ?',
  ).bind(code, storageKey(topic, f), MAX_VALUES_PER_TOPIC).all();
  const list = (rows && rows.results) || [];
  const out = { code, topic: topic.id, field: f.id, n: list.length, values: list.map(r => fromStored(f, r.value)),
    updated: list.reduce((m, r) => (r.created_at > m ? r.created_at : m), '') || null };
  if (isTeacher) out.ids = list.map(r => r.id);
  return json(out);
}

// "All my classes" (2.2): the values of several class codes in one sorted list. Values only, never ids or records, so pooling shows
// nothing a reader of each code could not already read one code at a time.
async function getPooledValues(url, env) {
  const raw = (url.searchParams.get('codes') || '').split(',').map(normCode).filter(Boolean);
  const codes = [...new Set(raw)];
  if (!codes.length || codes.length > MAX_POOLED_CODES || !codes.every(c => CODE_RE.test(c))) {
    return err(`codes must be 1 to ${MAX_POOLED_CODES} class codes, separated by commas.`, 400);
  }
  const rt = getRecordTopic(url.searchParams.get('topic'));
  const lt = rt ? null : getTopic(url.searchParams.get('topic'));
  if (!rt && !lt) return err('Unknown topic.', 400);
  let f = null, key;
  if (rt) {
    f = getField(rt, url.searchParams.get('field'));
    if (!f) return err(`field must be one of: ${rt.fields.map(x => x.id).join(', ')}.`, 400);
    key = storageKey(rt, f);
    await recordsTableReady(env, codes[0]);
  } else {
    if (url.searchParams.has('field')) return err('That topic has no fields.', 400);
    key = lt.id;
  }
  const rows = await env.DB.prepare(`SELECT code FROM classes WHERE code IN (${marks(codes.length)})`).bind(...codes).all();
  const found = new Set(((rows && rows.results) || []).map(r => r.code));
  if (codes.some(c => !found.has(c))) return err('No class with one of those codes.', 404);
  const res = await env.DB.prepare(
    `SELECT code, value, created_at FROM class_values WHERE topic = ? AND code IN (${marks(codes.length)}) ORDER BY value LIMIT ?`,
  ).bind(key, ...codes, MAX_VALUES_PER_TOPIC * codes.length).all();
  const list = (res && res.results) || [];
  const per = Object.fromEntries(codes.map(c => [c, 0]));
  for (const r of list) per[r.code]++;
  const out = { codes, topic: (rt || lt).id };
  if (f) out.field = f.id;
  Object.assign(out, { n: list.length, values: list.map(r => (f ? fromStored(f, r.value) : r.value)), per,
    updated: list.reduce((m, r) => (r.created_at > m ? r.created_at : m), '') || null });
  return json(out);
}

// Whole records. Students may read only a `linked` topic, in shuffled order with no ids; the teacher reads any topic in arrival order
// with ids (to remove one). Columns: `group` first for a randomised topic (0 = A, 1 = B), then the topic's fields; a skipped field is null.
async function getRecords(url, request, env) {
  const code = normCode(url.searchParams.get('code'));
  const topic = getRecordTopic(url.searchParams.get('topic'));
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!topic) return err('Unknown topic.', 400);
  await recordsTableReady(env, code);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  const teacherKey = request.headers.get('X-Teacher-Key');
  const isTeacher = teacherKey !== null && teacherKey !== '';
  if (isTeacher && !(await keyMatches(cls, teacherKey.trim()))) return err('Wrong teacher key.', 403);
  if (!isTeacher && !topic.linked) return err('This topic is read one field at a time (GET /api/classdata/values with field=).', 403);
  const recs = ((await env.DB.prepare(
    'SELECT id, grp, updated_at FROM class_records WHERE code = ? AND topic = ? ORDER BY id LIMIT ?',
  ).bind(code, topic.id, MAX_RECORDS_PER_TOPIC).all()) || {}).results || [];
  const keys = keysOf(topic);
  const vals = ((await env.DB.prepare(
    `SELECT r.id AS rid, v.topic AS k, v.value AS value FROM class_records r
     JOIN class_values v ON v.code = r.code AND v.device_hash = r.device_hash AND v.topic IN (${marks(keys.length)})
     WHERE r.code = ? AND r.topic = ?`,
  ).bind(...keys, code, topic.id).all()) || {}).results || [];
  const byId = new Map(recs.map(r => [r.id, topic.fields.map(() => null)]));
  for (const x of vals) {
    const row = byId.get(x.rid), i = keys.indexOf(x.k);
    if (row && i >= 0) row[i] = fromStored(topic.fields[i], x.value);
  }
  let rows = recs.map(r => (topic.randomize ? [r.grp] : []).concat(byId.get(r.id)));
  const out = { code, topic: topic.id, fields: (topic.randomize ? ['group'] : []).concat(topic.fields.map(x => x.id)), n: rows.length };
  if (isTeacher) out.ids = recs.map(r => r.id);
  else {   // Fisher-Yates with the crypto source, so the order says nothing about who arrived when
    rows = rows.slice();
    const rnd = crypto.getRandomValues(new Uint32Array(rows.length));
    for (let i = rows.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  }
  out.rows = rows;
  out.updated = recs.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '') || null;
  return json(out);
}

async function deleteRecord(request, env) {
  const { body, error } = await readBody(request);
  if (error) return error;
  const code = normCode(body.code);
  if (!CODE_RE.test(code)) return err('Class code must be 6 characters.', 400);
  if (!Number.isInteger(body.id) || body.id < 1) return err('id must be a positive integer.', 400);
  const cls = await findClass(env, code);
  if (!cls) return err('No class with that code.', 404);
  if (!(await keyMatches(cls, body.teacherKey))) return err('Wrong teacher key.', 403);
  const rec = await env.DB.prepare('SELECT id, topic, device_hash FROM class_records WHERE id = ? AND code = ?').bind(body.id, code).first();
  if (!rec) return err('No such record in this class.', 404);
  const topic = getRecordTopic(rec.topic), keys = topic ? keysOf(topic) : [];
  await env.DB.batch([
    ...(keys.length ? [env.DB.prepare(`DELETE FROM class_values WHERE code = ? AND device_hash = ? AND topic IN (${marks(keys.length)})`)
      .bind(code, rec.device_hash, ...keys)] : []),
    env.DB.prepare('DELETE FROM class_records WHERE id = ? AND code = ?').bind(rec.id, code),
  ]);
  return json({ ok: true });
}

export async function handle(request, env) {
  if (!env || !env.DB) return err('Server is missing the DB binding.', 503);
  const url = new URL(request.url);
  const route = url.pathname.replace(/\/+$/, '').replace(/^\/api\/classdata\/?/, '');
  const method = request.method;

  if (method === 'POST' || method === 'DELETE') {
    // Same origin only. Browsers always send Origin on a cross-site write; a request with none (curl, a server) is not a browser CSRF.
    const origin = request.headers.get('Origin');
    if (origin !== null) {
      let ok = false;
      try { ok = new URL(origin).origin === url.origin; } catch { ok = false; }
      if (!ok) return err('Cross-origin requests are not allowed.', 403);
    }
  }

  try {
    if (route === 'class') return method === 'POST' ? await createClass(request, env) : err('Method not allowed.', 405, { Allow: 'POST' });
    if (route === 'value') {
      if (method === 'POST') return await putValue(request, env);
      if (method === 'DELETE') return await deleteValue(request, env);
      return err('Method not allowed.', 405, { Allow: 'POST, DELETE' });
    }
    if (route === 'values') return method === 'GET' ? await getValues(url, request, env) : err('Method not allowed.', 405, { Allow: 'GET' });
    if (route === 'tally') {
      if (method === 'POST') return await putTally(request, env);
      if (method === 'DELETE') return await deleteTally(request, env);
      return err('Method not allowed.', 405, { Allow: 'POST, DELETE' });
    }
    if (route === 'tallies') return method === 'GET' ? await getTallies(url, request, env) : err('Method not allowed.', 405, { Allow: 'GET' });
    if (route === 'record') {
      if (method === 'POST') return await putRecord(request, env);
      if (method === 'DELETE') return await deleteRecord(request, env);
      return err('Method not allowed.', 405, { Allow: 'POST, DELETE' });
    }
    if (route === 'records') return method === 'GET' ? await getRecords(url, request, env) : err('Method not allowed.', 405, { Allow: 'GET' });
    if (route === 'assign') return method === 'POST' ? await assignGroup(request, env) : err('Method not allowed.', 405, { Allow: 'POST' });
  } catch {
    return err('Class data is unavailable right now.', 500);   // nothing from the request is logged
  }
  return err('Not found.', 404);
}

export const onRequest = ({ request, env }) => handle(request, env);
