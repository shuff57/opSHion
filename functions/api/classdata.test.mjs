// Self-check for /api/classdata/*:   node functions/api/classdata.test.mjs
// Runs the REAL SQL: the migration file is executed in an in-memory node:sqlite database behind a small D1-shaped adapter
// (prepare/bind/first/all/run/batch), plus the ai_chat_usage table the rate limiter shares.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { onRequest, handle } = await import("./classdata/[[path]].js");
const { TOPICS, TALLY_TOPICS, getTopic, getTallyTopic, CODE_RE, RECORD_TOPICS, getRecordTopic, getField, storageKey, toStored, fromStored } = await import("../_lib/classdata_topics.js");

const migration = readFileSync(new URL("../../migrations/0016_class_data.sql", import.meta.url), "utf8");
const tallySql = readFileSync(new URL("../../migrations/0017_class_tallies.sql", import.meta.url), "utf8");
const usageSql = readFileSync(new URL("../../migrations/0001_ai_chat_usage.sql", import.meta.url), "utf8");
const recordsSql = readFileSync(new URL("../../migrations/0018_class_records.sql", import.meta.url), "utf8");

// records: false = a database where 0016 is applied but 0018 is not (the state between a deploy and the author's migration).
function d1({ tallies = true, records = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(usageSql); db.exec(migration); if (tallies) db.exec(tallySql); if (records) db.exec(recordsSql);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { db, prepare: sql => stmt(sql), async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; } };
}

const BASE = "https://x.test/api/classdata";
const dev = n => "device-" + String(n).padStart(10, "0");
const call = (env, method, path, { body, headers = {}, ip = "1.2.3.4", origin } = {}) => handle(new Request(BASE + path, {
  method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ip ? { "CF-Connecting-IP": ip } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
  body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
}), env);
const J = async r => r.json();
const mk = async (env, ip) => J(await call(env, "POST", "/class", { body: {}, ip }));
const put = (env, code, topic, value, n, extra = {}) => call(env, "POST", "/value", { body: { code, topic, value, device: dev(n) }, ...extra });

// registry
assert.deepEqual(Object.keys(TOPICS), ["pulse", "height", "commute", "s61-rent5", "s62-song", "s62-run4", "ready-minutes", "birth-day"]);
// chapter 6 data-set topics (Real/Sim redo 2026-11-13): a student's own result of one round
assert.deepEqual(["s61-rent5", "s62-song", "s62-run4"].map(k => [TOPICS[k].id, TOPICS[k].min, TOPICS[k].max, TOPICS[k].unit]),
  [["s61-rent5", 650, 3200, "dollars"], ["s62-song", 2, 9, "minutes"], ["s62-run4", 8, 36, "minutes"]]);
// chapter 7 class-data topics (2026-11-17): 7.1 minutes getting ready, 7.2 the day of the month a student was born
assert.deepEqual(["ready-minutes", "birth-day"].map(k => [TOPICS[k].id, TOPICS[k].min, TOPICS[k].max, TOPICS[k].unit]),
  [["ready-minutes", 0, 180, "minutes"], ["birth-day", 1, 31, "day of the month"]]);
for (const k of Object.keys(TOPICS)) assert.ok(Object.isFrozen(TOPICS[k]), k);
assert.deepEqual([TOPICS.pulse.min, TOPICS.pulse.max, TOPICS.height.min, TOPICS.height.max, TOPICS.commute.min, TOPICS.commute.max], [40, 140, 120, 220, 0, 180]);
assert.equal(getTopic("__proto__"), null); assert.equal(getTopic("toString"), null); assert.equal(getTopic(7), null);
assert.equal(typeof onRequest, "function");

// create a class: code format, key stored only as a hash, no-store, same-origin (no CORS header)
{ const env = { DB: d1() };
  const r = await call(env, "POST", "/class", { body: {} });
  assert.equal(r.status, 201); assert.equal(r.headers.get("Cache-Control"), "no-store"); assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const { code, teacherKey } = await J(r);
  assert.match(code, CODE_RE); assert.match(teacherKey, /^[A-Za-z0-9_-]{32}$/);
  const row = env.DB.db.prepare("SELECT * FROM classes").get();
  assert.equal(row.code, code); assert.match(row.teacher_key_hash, /^[0-9a-f]{64}$/); assert.notEqual(row.teacher_key_hash, teacherKey);
  assert.ok(!JSON.stringify(env.DB.db.prepare("SELECT * FROM ai_chat_usage").all()).includes("1.2.3.4"), "the IP only appears hashed");
}
// codes never contain I, L, O, 0 or 1 and do not repeat
{ const env = { DB: d1(), CLASSDATA_CLASS_DAILY_LIMIT: "500" }; const seen = new Set();
  for (let i = 0; i < 200; i++) { const { code } = await mk(env); assert.match(code, /^[A-HJKMN-Z2-9]{6}$/); seen.add(code); }
  assert.equal(seen.size, 200); }

// values: add, count, sorted read, upsert per device, case-insensitive code
{ const env = { DB: d1() }; const { code, teacherKey } = await mk(env);
  assert.deepEqual(await J(await put(env, code, "pulse", 72, 1)), { ok: true, n: 1 });
  assert.deepEqual(await J(await put(env, code, "pulse", 60, 2)), { ok: true, n: 2 });
  assert.deepEqual(await J(await put(env, code.toLowerCase(), "pulse", 90, 3)), { ok: true, n: 3 });
  assert.deepEqual(await J(await put(env, code, "pulse", 61, 2)), { ok: true, n: 3 }, "same device replaces, not adds");
  assert.deepEqual(await J(await put(env, code, "height", 170, 2)), { ok: true, n: 1 }, "another topic is its own list");
  const g = await call(env, "GET", `/values?code=${code}&topic=pulse`);
  assert.equal(g.status, 200); assert.equal(g.headers.get("Cache-Control"), "no-store");
  const body = await J(g);
  assert.deepEqual(body.values, [61, 72, 90]); assert.equal(body.n, 3); assert.equal(body.code, code); assert.equal(body.topic, "pulse");
  assert.equal(body.ids, undefined, "no ids without the teacher key"); assert.match(body.updated, /^\d{4}-\d\d-\d\d /);
  assert.deepEqual(await J(await call(env, "GET", `/values?code=${code}&topic=commute`)), { code, topic: "commute", n: 0, values: [], updated: null });
  // the device id is stored only as a hash, and the same device in another class is a different hash
  const hashes = env.DB.db.prepare("SELECT device_hash FROM class_values").all().map(r => r.device_hash);
  assert.ok(hashes.every(h => /^[0-9a-f]{64}$/.test(h)) && !hashes.some(h => h.includes("device-")));

  // teacher key: ids, delete
  const t = await J(await call(env, "GET", `/values?code=${code}&topic=pulse`, { headers: { "X-Teacher-Key": teacherKey } }));
  assert.deepEqual(t.values, [61, 72, 90]); assert.equal(t.ids.length, 3);
  const wrong = await call(env, "GET", `/values?code=${code}&topic=pulse`, { headers: { "X-Teacher-Key": "x".repeat(32) } });
  assert.equal(wrong.status, 403); assert.equal((await J(wrong)).ids, undefined);
  assert.equal((await call(env, "DELETE", "/value", { body: { code, teacherKey: "y".repeat(32), id: t.ids[1] } })).status, 403);
  assert.equal((await call(env, "DELETE", "/value", { body: { code, id: t.ids[1] } })).status, 403, "no key at all");
  assert.equal((await J(await call(env, "GET", `/values?code=${code}&topic=pulse`))).n, 3, "refused deletes removed nothing");
  assert.deepEqual(await J(await call(env, "DELETE", "/value", { body: { code, teacherKey, id: t.ids[1] } })), { ok: true });
  assert.deepEqual((await J(await call(env, "GET", `/values?code=${code}&topic=pulse`))).values, [61, 90]);
  assert.equal((await call(env, "DELETE", "/value", { body: { code, teacherKey, id: t.ids[1] } })).status, 404, "already gone");
  assert.equal((await call(env, "DELETE", "/value", { body: { code, teacherKey, id: "1" } })).status, 400);
  // a teacher key opens only its own class
  const other = await mk(env, "9.9.9.9"); await put(env, other.code, "pulse", 80, 9);
  const otherIds = (await J(await call(env, "GET", `/values?code=${other.code}&topic=pulse`, { headers: { "X-Teacher-Key": other.teacherKey } }))).ids;
  assert.equal((await call(env, "DELETE", "/value", { body: { code, teacherKey, id: otherIds[0] } })).status, 404, "an id from another class is not deletable");
  assert.equal((await call(env, "DELETE", "/value", { body: { code: other.code, teacherKey, id: otherIds[0] } })).status, 403, "class A's key does not open class B");
}

// validation
{ const env = { DB: d1() }; const { code } = await mk(env);
  const bad = async (b, status = 400) => assert.equal((await call(env, "POST", "/value", { body: b })).status, status, JSON.stringify(b));
  const ok = { code, topic: "pulse", value: 70, device: dev(1) };
  await bad({ ...ok, topic: "weight" }); await bad({ ...ok, topic: "__proto__" }); await bad({ ...ok, topic: undefined });
  await bad({ ...ok, value: 39 }); await bad({ ...ok, value: 141 }); await bad({ ...ok, value: 70.5 }); await bad({ ...ok, value: "70" }); await bad({ ...ok, value: null }); await bad({ ...ok, value: NaN });
  await bad({ ...ok, topic: "height", value: 119 }); await bad({ ...ok, topic: "height", value: 221 }); await bad({ ...ok, topic: "commute", value: -1 }); await bad({ ...ok, topic: "commute", value: 181 });
  await bad({ ...ok, code: "ABC" }); await bad({ ...ok, code: "ABCDEI" }); await bad({ ...ok, code: undefined }); await bad({ ...ok, code: ["ABCDEF"] });
  await bad({ ...ok, device: "short" }); await bad({ ...ok, device: "a".repeat(65) }); await bad({ ...ok, device: "has space has space" }); await bad({ ...ok, device: 12345678901234567 }); await bad({ ...ok, device: undefined });
  await bad({ ...ok, code: "ZZZZZZ" }, 404);   // well-formed but no such class
  await bad("{not json"); await bad("[]"); await bad("null");
  assert.equal((await call(env, "POST", "/value", { body: "x".repeat(5000) })).status, 413);
  for (const [topic, value] of [["pulse", 40], ["pulse", 140], ["height", 120], ["height", 220], ["commute", 0], ["commute", 180]]) {
    assert.equal((await call(env, "POST", "/value", { body: { code, topic, value, device: dev(1) } })).status, 200, `${topic} ${value} is in range`); }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values").get().n, 3, "one device, three topics: each boundary pair replaced itself");
  for (const [topic, lo, hi] of [["s61-rent5", 650, 3200], ["s62-song", 2, 9], ["s62-run4", 8, 36]]) {   // chapter 6 topics: same rules
    for (const value of [lo, hi]) assert.equal((await call(env, "POST", "/value", { body: { code, topic, value, device: dev(1) } })).status, 200, `${topic} ${value}`);
    await bad({ ...ok, topic, value: lo - 1 }); await bad({ ...ok, topic, value: hi + 1 }); await bad({ ...ok, topic, value: lo + 0.5 }); }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values").get().n, 6, "three more topics, one row each for the one device");
  for (const q of ["", "?code=ZZZZZZ&topic=pulse", `?code=${code}`, `?code=${code}&topic=nope`, "?code=bad&topic=pulse"]) {
    assert.ok([400, 404].includes((await call(env, "GET", "/values" + q)).status), q); }
  assert.equal((await call(env, "GET", "/values?code=ZZZZZZ&topic=pulse")).status, 404);
  assert.equal((await call(env, "DELETE", "/value", { body: { code: "ZZZZZZ", teacherKey: "k".repeat(32), id: 1 } })).status, 404);
}
// routing and methods
{ const env = { DB: d1() };
  assert.equal((await call(env, "GET", "/class")).status, 405); assert.equal((await call(env, "POST", "/values", { body: {} })).status, 405);
  assert.equal((await call(env, "PUT", "/value", { body: {} })).status, 405); assert.equal((await call(env, "GET", "/nope")).status, 404); assert.equal((await call(env, "GET", "")).status, 404);
  assert.equal((await call(env, "OPTIONS", "/value")).status, 405, "no CORS preflight is answered");
  assert.equal((await handle(new Request(BASE + "/class", { method: "POST" }), {})).status, 503, "no DB binding");
}
// same origin: a cross-origin write is refused, a same-origin one and one with no Origin pass; GET carries no CORS header
{ const env = { DB: d1() };
  for (const origin of ["https://evil.example", "http://x.test", "https://x.test:8443", "null", "not a url"]) {
    assert.equal((await call(env, "POST", "/class", { body: {}, origin })).status, 403, origin); }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM classes").get().n, 0, "refused writes changed nothing");
  const { code, teacherKey } = await J(await call(env, "POST", "/class", { body: {}, origin: "https://x.test" }));
  assert.equal((await put(env, code, "pulse", 70, 1, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "DELETE", "/value", { body: { code, teacherKey, id: 1 }, origin: "https://evil.example" })).status, 403);
  assert.equal((await put(env, code, "pulse", 70, 1, { origin: "https://x.test" })).status, 200);
  const g = await call(env, "GET", `/values?code=${code}&topic=pulse`, { origin: "https://evil.example" });
  assert.equal(g.headers.get("Access-Control-Allow-Origin"), null);
}
// rate limits: per IP per day, per kind, hashed key, no shared bucket for an unidentified requester
{ const env = { DB: d1(), CLASSDATA_CLASS_DAILY_LIMIT: "3", CLASSDATA_VALUE_DAILY_LIMIT: "4" };
  for (let i = 0; i < 3; i++) assert.equal((await call(env, "POST", "/class", { body: {} })).status, 201);
  const r = await call(env, "POST", "/class", { body: {} }); assert.equal(r.status, 429); assert.match((await J(r)).error, /limit/);
  assert.equal((await call(env, "POST", "/class", { body: {}, ip: "5.5.5.5" })).status, 201, "another IP has its own count");
  const { code } = await mk(env, "6.6.6.6");
  for (let i = 1; i <= 4; i++) assert.equal((await put(env, code, "pulse", 70 + i, i)).status, 200);
  assert.equal((await put(env, code, "pulse", 99, 5)).status, 429);
  assert.equal((await put(env, code, "pulse", 99, 5, { ip: "7.7.7.7" })).status, 200);
  assert.equal((await call(env, "GET", `/values?code=${code}&topic=pulse`)).status, 200, "reads are not counted");
  assert.equal((await call(env, "POST", "/class", { body: {}, ip: null })).status, 503, "no IP: refused");
  const keys = env.DB.db.prepare("SELECT client_id FROM ai_chat_usage").all().map(r => r.client_id);
  // five per-IP counters, plus (2026-11-14) one per-class counter for the class the values went to
  assert.ok(keys.every(k => /^cd:[cvk]:[0-9a-f]{32}$/.test(k)) && keys.length === 6 && keys.filter(k => k.startsWith("cd:k:")).length === 1, keys.join());
  // a malformed request does not spend the allowance
  const e2 = { DB: d1(), CLASSDATA_VALUE_DAILY_LIMIT: "1" }; const c2 = await mk(e2);
  assert.equal((await put(e2, c2.code, "pulse", 5, 1)).status, 400); assert.equal((await put(e2, c2.code, "pulse", 70, 1)).status, 200);
}
// lazy retention: a class older than 400 days and its values go when a new class is made; a younger one stays
{ const env = { DB: d1() };
  const old = await mk(env), fresh = await mk(env);
  await put(env, old.code, "pulse", 70, 1); await put(env, fresh.code, "pulse", 71, 1);
  env.DB.db.prepare("UPDATE classes SET created_at = datetime('now', '-401 days') WHERE code = ?").run(old.code);
  env.DB.db.prepare("UPDATE classes SET created_at = datetime('now', '-399 days') WHERE code = ?").run(fresh.code);
  await mk(env);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM classes WHERE code = ?").get(old.code).n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values WHERE code = ?").get(old.code).n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values WHERE code = ?").get(fresh.code).n, 1);
  assert.equal((await call(env, "GET", `/values?code=${old.code}&topic=pulse`)).status, 404);
}
// the per-topic cap holds for new devices but not for a device replacing its own value
{ const env = { DB: d1() }; const { code } = await mk(env);
  const ins = env.DB.db.prepare("INSERT INTO class_values (code, topic, value, device_hash) VALUES (?, 'pulse', 70, ?)");
  for (let i = 0; i < 2000; i++) ins.run(code, "h" + i);
  assert.equal((await put(env, code, "pulse", 71, 1)).status, 409);
  assert.equal((await put(env, code, "height", 171, 1)).status, 200, "other topics are unaffected");
}

// ================= tallies (2026-11-13, migration 0017) =================
const putT = (env, code, topic, counts, n, extra = {}) => call(env, "POST", "/tally", { body: { code, topic, counts, device: dev(n) }, ...extra });
const getT = async (env, code, topic, headers) => J(await call(env, "GET", `/tallies?code=${code}&topic=${topic}`, headers ? { headers } : {}));

// registry: tally topics are their own namespace, frozen, each with an outcome list
{ const ids = Object.keys(TALLY_TOPICS);
  assert.deepEqual(ids, ["coin-sim", "coin-real", "s32-toss2", "s32-spin8", "s32-bag-back", "s32-bag-keep", "s33-toss2", "s33-bag-keep", "s34-survey", "s41-dice2", "s42-ring", "s42-die", "s45-clock", "s31-die", "s63-spin8", "s43-sixes3", "s35-cups"]);
  assert.deepEqual(TALLY_TOPICS["s35-cups"].outcomes, ["Cup 1, red", "Cup 1, green", "Cup 2, red", "Cup 2, green"]); assert.equal(TALLY_TOPICS["s35-cups"].noun, "play");
  assert.deepEqual(TALLY_TOPICS["s63-spin8"].outcomes, ["1", "2", "3", "4", "5", "6", "7", "8"]); assert.equal(TALLY_TOPICS["s63-spin8"].noun, "spin");
  for (const id of ids) {
    const t = TALLY_TOPICS[id];
    assert.equal(t.id, id); assert.ok(Object.isFrozen(t) && Object.isFrozen(t.outcomes)); assert.ok(t.outcomes.length >= 2 && new Set(t.outcomes).size === t.outcomes.length, id);
    assert.ok(Number.isInteger(t.maxTotal) && t.maxTotal >= 1000); assert.equal(getTopic(id), null, "a tally topic is not a number topic"); }
  for (const id of Object.keys(TOPICS)) assert.equal(getTallyTopic(id), null, "a number topic is not a tally topic");
  assert.equal(getTallyTopic("__proto__"), null); assert.equal(getTallyTopic("constructor"), null); assert.equal(getTallyTopic(null), null);
  assert.deepEqual(TALLY_TOPICS["s41-dice2"].outcomes, ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.equal(TALLY_TOPICS["s34-survey"].outcomes.length, 9); assert.equal(TALLY_TOPICS["s34-survey"].outcomes[0], "Outside, Ninth");
}
// submit, sum, contributors, upsert per device, zeros remove, per-topic lists, case-insensitive code
{ const env = { DB: d1() }; const { code, teacherKey } = await mk(env);
  assert.deepEqual(await getT(env, code, "s32-toss2"), { code, topic: "s32-toss2", outcomes: ["HH", "HT", "TH", "TT"], counts: [0, 0, 0, 0], total: 0, devices: 0, updated: null });
  assert.deepEqual(await J(await putT(env, code, "s32-toss2", [3, 2, 4, 1], 1)), { ok: true, total: 10, devices: 1 });
  assert.deepEqual(await J(await putT(env, code, "s32-toss2", [5, 5, 5, 5], 2)), { ok: true, total: 20, devices: 2 });
  assert.deepEqual(await J(await putT(env, code.toLowerCase(), "s32-toss2", [0, 1, 0, 0], 3)), { ok: true, total: 1, devices: 3 });
  let g = await getT(env, code, "s32-toss2");
  assert.deepEqual([g.counts, g.total, g.devices], [[8, 8, 9, 6], 31, 3]); assert.match(g.updated, /^\d{4}-\d\d-\d\d /); assert.equal(g.rows, undefined, "no rows without the teacher key");
  // the same device re-sending its (grown) tally replaces it: a student's running count, not a pile of copies
  assert.deepEqual(await J(await putT(env, code, "s32-toss2", [4, 2, 4, 2], 1)), { ok: true, total: 12, devices: 3 });
  g = await getT(env, code, "s32-toss2"); assert.deepEqual([g.counts, g.total, g.devices], [[9, 8, 9, 7], 33, 3]);
  // all zeros (the student undid every real trial, or reset) removes that device's part
  assert.deepEqual(await J(await putT(env, code, "s32-toss2", [0, 0, 0, 0], 3)), { ok: true, total: 0, devices: 2 });
  g = await getT(env, code, "s32-toss2"); assert.deepEqual([g.counts, g.total, g.devices], [[9, 7, 9, 7], 32, 2]);
  assert.deepEqual(await J(await putT(env, code, "s32-toss2", [0, 0, 0, 0], 9)), { ok: true, total: 0, devices: 2 }, "zeros from a device with no tally: no-op");
  // another tally topic is its own list; number topics are untouched by tallies and the other way round
  await putT(env, code, "s41-dice2", [0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 1], 1);
  assert.deepEqual((await getT(env, code, "s41-dice2")).counts, [0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 1]);
  assert.equal((await getT(env, code, "s32-toss2")).total, 32);
  await put(env, code, "pulse", 70, 1);
  assert.deepEqual((await J(await call(env, "GET", `/values?code=${code}&topic=pulse`))).values, [70]);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values").get().n, 1);
  // only hashes and whole-number JSON are stored
  const rows = env.DB.db.prepare("SELECT * FROM class_tallies").all();
  assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.device_hash) && /^\[\d+(,\d+)*\]$/.test(r.counts)));
  // teacher: per-device rows, delete one; a wrong key or another class's key is refused
  const t = await getT(env, code, "s32-toss2", { "X-Teacher-Key": teacherKey });
  assert.deepEqual(t.rows.map(r => [r.total, r.counts]), [[12, [4, 2, 4, 2]], [20, [5, 5, 5, 5]]]);
  assert.equal((await call(env, "GET", `/tallies?code=${code}&topic=s32-toss2`, { headers: { "X-Teacher-Key": "x".repeat(32) } })).status, 403);
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, teacherKey: "y".repeat(32), id: t.rows[1].id } })).status, 403);
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, id: t.rows[1].id } })).status, 403);
  assert.deepEqual(await J(await call(env, "DELETE", "/tally", { body: { code, teacherKey, id: t.rows[1].id } })), { ok: true });
  g = await getT(env, code, "s32-toss2"); assert.deepEqual([g.counts, g.total, g.devices], [[4, 2, 4, 2], 12, 1]);
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, teacherKey, id: t.rows[1].id } })).status, 404, "already gone");
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, teacherKey, id: "1" } })).status, 400);
  const other = await mk(env, "9.9.9.9"); await putT(env, other.code, "s32-toss2", [1, 0, 0, 0], 5);
  const oid = (await getT(env, other.code, "s32-toss2", { "X-Teacher-Key": other.teacherKey })).rows[0].id;
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, teacherKey, id: oid } })).status, 404, "a tally of another class is not deletable");
  assert.equal((await call(env, "DELETE", "/tally", { body: { code: other.code, teacherKey, id: oid } })).status, 403, "class A's key does not open class B");
  // a value id is not a tally id: DELETE /value never removes a tally
  const vid = (await J(await call(env, "GET", `/values?code=${code}&topic=pulse`, { headers: { "X-Teacher-Key": teacherKey } }))).ids[0];
  const tid = (await getT(env, code, "s32-toss2", { "X-Teacher-Key": teacherKey })).rows[0].id;
  await call(env, "DELETE", "/value", { body: { code, teacherKey, id: vid } });
  assert.equal((await getT(env, code, "s32-toss2", { "X-Teacher-Key": teacherKey })).rows[0].id, tid);
}
// tally validation
{ const env = { DB: d1() }; const { code } = await mk(env);
  const bad = async (b, status = 400) => assert.equal((await call(env, "POST", "/tally", { body: b })).status, status, JSON.stringify(b).slice(0, 120));
  const ok = { code, topic: "s32-toss2", counts: [1, 2, 3, 4], device: dev(1) };
  await bad({ ...ok, topic: "pulse" }); await bad({ ...ok, topic: "toss2" }); await bad({ ...ok, topic: "__proto__" }); await bad({ ...ok, topic: undefined });
  await bad({ ...ok, counts: [1, 2, 3] }); await bad({ ...ok, counts: [1, 2, 3, 4, 5] }); await bad({ ...ok, counts: [1, 2, 3, -1] }); await bad({ ...ok, counts: [1, 2, 3, 1.5] });
  await bad({ ...ok, counts: [1, 2, 3, "4"] }); await bad({ ...ok, counts: [1, 2, 3, null] }); await bad({ ...ok, counts: "1,2,3,4" }); await bad({ ...ok, counts: { 0: 1 } }); await bad({ ...ok, counts: undefined });
  await bad({ ...ok, counts: [10001, 0, 0, 0] }); await bad({ ...ok, counts: [5000, 5000, 1, 0] }, 400);
  await bad({ ...ok, code: "ABC" }); await bad({ ...ok, code: "ABCDEI" }); await bad({ ...ok, device: "short" }); await bad({ ...ok, device: undefined });
  await bad({ ...ok, code: "ZZZZZZ" }, 404);
  await bad("{not json"); await bad("[]");
  assert.equal((await call(env, "POST", "/tally", { body: { ...ok, counts: Array(4).fill(1).concat(Array(2000).fill(0)) } })).status, 413, "a huge body is refused before parsing");
  assert.equal((await call(env, "POST", "/tally", { body: { ...ok, counts: [10000, 0, 0, 0] } })).status, 200, "maxTotal itself is allowed");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_tallies").get().n, 1, "refused tallies stored nothing");
  for (const q of ["", "?code=ZZZZZZ&topic=s32-toss2", `?code=${code}`, `?code=${code}&topic=pulse`, "?code=bad&topic=s32-toss2"]) {
    assert.ok([400, 404].includes((await call(env, "GET", "/tallies" + q)).status), q); }
  assert.equal((await call(env, "GET", `/values?code=${code}&topic=s32-toss2`)).status, 400, "a tally topic is not readable as numbers");
  assert.equal((await call(env, "POST", "/value", { body: { code, topic: "s32-toss2", value: 1, device: dev(1) } })).status, 400, "nor writable as a number");
}
// tally routing, same origin, rate limit (own bucket cd:t:), per-topic device cap
{ const env = { DB: d1(), CLASSDATA_TALLY_DAILY_LIMIT: "3" }; const { code, teacherKey } = await mk(env);
  assert.equal((await call(env, "GET", "/tally")).status, 405); assert.equal((await call(env, "PUT", "/tally", { body: {} })).status, 405);
  assert.equal((await call(env, "POST", "/tallies", { body: {} })).status, 405);
  assert.equal((await putT(env, code, "s32-toss2", [1, 0, 0, 0], 1, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "DELETE", "/tally", { body: { code, teacherKey, id: 1 }, origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "GET", `/tallies?code=${code}&topic=s32-toss2`, { origin: "https://evil.example" })).headers.get("Access-Control-Allow-Origin"), null);
  for (let i = 1; i <= 3; i++) assert.equal((await putT(env, code, "s32-toss2", [i, 0, 0, 0], 1, { origin: "https://x.test" })).status, 200);
  const r = await putT(env, code, "s32-toss2", [9, 0, 0, 0], 1); assert.equal(r.status, 429); assert.match((await J(r)).error, /limit/);
  assert.equal((await putT(env, code, "s32-toss2", [9, 0, 0, 0], 1, { ip: "7.7.7.7" })).status, 200, "another IP has its own count");
  assert.equal((await put(env, code, "pulse", 70, 1)).status, 200, "tallies do not spend the number allowance");
  assert.equal((await call(env, "GET", `/tallies?code=${code}&topic=s32-toss2`)).status, 200, "reads are not counted");
  assert.equal((await putT(env, code, "s32-toss2", [1, 0, 0, 0], 1, { ip: null })).status, 503);
  const keys = env.DB.db.prepare("SELECT client_id FROM ai_chat_usage").all().map(x => x.client_id);
  assert.ok(keys.some(k => /^cd:t:[0-9a-f]{32}$/.test(k)) && keys.every(k => /^cd:[cvtk]:[0-9a-f]{32}$/.test(k)), keys.join());
  const e2 = { DB: d1() }; const c2 = await mk(e2);
  const ins = e2.DB.db.prepare("INSERT INTO class_tallies (code, topic, counts, total, device_hash) VALUES (?, 's32-toss2', '[1,0,0,0]', 1, ?)");
  for (let i = 0; i < 500; i++) ins.run(c2.code, "h" + i);
  assert.equal((await putT(e2, c2.code, "s32-toss2", [1, 0, 0, 0], 1)).status, 409, "the 501st device is refused");
  assert.equal((await putT(e2, c2.code, "s32-spin8", [1, 0, 0, 0, 0, 0, 0, 0], 1)).status, 200, "other tally topics are unaffected");
  assert.equal((await getT(e2, c2.code, "s32-toss2")).devices, 500);
  // a stored row whose length no longer matches the outcome list is skipped, never mis-added
  e2.DB.db.prepare("INSERT INTO class_tallies (code, topic, counts, total, device_hash) VALUES (?, 's32-spin8', '[5,5]', 10, 'odd')").run(c2.code);
  assert.deepEqual((await getT(e2, c2.code, "s32-spin8")).counts, [1, 0, 0, 0, 0, 0, 0, 0]);
}
// retention: a class older than 400 days loses its tallies with it
{ const env = { DB: d1() };
  const old = await mk(env), fresh = await mk(env);
  await putT(env, old.code, "s32-toss2", [1, 1, 1, 1], 1); await putT(env, fresh.code, "s32-toss2", [2, 2, 2, 2], 1);
  env.DB.db.prepare("UPDATE classes SET created_at = datetime('now', '-401 days') WHERE code = ?").run(old.code);
  await mk(env);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_tallies WHERE code = ?").get(old.code).n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_tallies WHERE code = ?").get(fresh.code).n, 1);
}
// 0017 NOT applied (production before the author's word): every number route still works, the class sweep still runs,
// and a tally route fails as "unavailable" (JSON 500), which the page reads as "class data is not connected yet"
{ const env = { DB: d1({ tallies: false }) };
  const { code } = await mk(env); assert.match(code, CODE_RE);
  const old = await mk(env); env.DB.db.prepare("UPDATE classes SET created_at = datetime('now', '-401 days') WHERE code = ?").run(old.code);
  assert.equal((await call(env, "POST", "/class", { body: {} })).status, 201, "the sweep tolerates the missing table");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM classes WHERE code = ?").get(old.code).n, 0);
  assert.deepEqual(await J(await put(env, code, "pulse", 72, 1)), { ok: true, n: 1 });
  const r = await putT(env, code, "s32-toss2", [1, 0, 0, 0], 1); assert.equal(r.status, 500); assert.equal(r.headers.get("content-type").split(";")[0], "application/json");
  assert.equal((await call(env, "GET", `/tallies?code=${code}&topic=s32-toss2`)).status, 500);
  const probe = await call(env, "GET", `/tallies?code=AAAAAA&topic=s32-toss2`);
  assert.equal(probe.status, 500, "the page's probe (a made-up code) is NOT a 404 without the table, so the page says not connected");
  assert.equal(typeof (await J(probe)).error, "string");
  assert.equal((await call(env, "GET", `/values?code=AAAAAA&topic=pulse`)).status, 404, "the number pages' probe is unaffected");
}
{ const env = { DB: d1() };
  assert.equal((await call(env, "GET", `/tallies?code=AAAAAA&topic=s32-toss2`)).status, 404, "with 0017 the probe answers 404 (connected)");
}
// ======================= chapters 1 and 2 (2026-11-14): record topics, migration 0018 =======================
// Plan: projects/Introduction to Stats/factory/plans/classdata-ch12.md; API notes: classdata-ch12-api.md
const rec = (env, code, topic, values, n, extra = {}) => call(env, "POST", "/record", { body: { code, topic, values, device: dev(n) }, ...extra });
const assign = (env, code, topic, n, extra = {}) => call(env, "POST", "/assign", { body: { code, topic, device: dev(n) }, ...extra });
const vals = async (env, q, headers) => J(await call(env, "GET", "/values?" + q, { headers }));
const recs = async (env, code, topic, headers) => J(await call(env, "GET", `/records?code=${code}&topic=${topic}`, { headers }));

// registry: one topic per activity, carried across the sections that reuse its pool; chapter 5's three are untouched
assert.deepEqual(Object.keys(RECORD_TOPICS), ["alphabet", "sleep", "anchor", "planes", "trip", "paidwork"]);
assert.deepEqual(Object.fromEntries(Object.values(RECORD_TOPICS).map(t => [t.id, t.sections])),
  { alphabet: ["1.2", "2.2"], sleep: ["1.3", "2.6"], anchor: ["1.4"], planes: ["2.1", "2.3"], trip: ["2.4", "2.5"], paidwork: ["7.3"] });
assert.deepEqual(Object.fromEntries(Object.values(RECORD_TOPICS).map(t => [t.id, t.fields.map(f => `${f.id}:${f.kind}`)])), {
  alphabet: ["how:choice", "tries:int", "seconds:decimal"], sleep: ["wakes:choice", "sleepy:choice", "wake:clock", "hours:decimal", "weekend:clock"],
  anchor: ["trip:choice", "guess:int"], planes: ["metres:decimal"], trip: ["way:choice", "minutes:int"], paidwork: ["worked:choice"] });
for (const t of Object.values(RECORD_TOPICS)) {
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.fields) && t.fields.every(Object.isFrozen), t.id);
  assert.equal(getTopic(t.id), null, `${t.id} is not also a chapter 5 topic`);
  for (const f of t.fields) assert.ok(f.kind !== "choice" || (Object.isFrozen(f.options) && f.options.length >= 2), `${t.id}.${f.id} options`);
}
assert.equal(storageKey(RECORD_TOPICS.trip, getField(RECORD_TOPICS.trip, "minutes")), "commute", "2.4/2.5 minutes ARE chapter 5's commute pool");
assert.equal(getField(RECORD_TOPICS.trip, "minutes").min, TOPICS.commute.min); assert.equal(getField(RECORD_TOPICS.trip, "minutes").max, TOPICS.commute.max);
{ const keys = Object.values(RECORD_TOPICS).flatMap(t => t.fields.map(f => storageKey(t, f)));
  assert.equal(new Set(keys).size, keys.length, "no two fields share a storage key");
  assert.deepEqual(keys.filter(k => getTopic(k)), ["commute"], "only trip.minutes lands in a chapter 5 list"); }
assert.equal(RECORD_TOPICS.sleep.fields[1].ordered, true); assert.equal(RECORD_TOPICS.sleep.fields[0].ordered, false);
assert.deepEqual(RECORD_TOPICS.anchor.randomize.groups.map(g => g.id), ["A", "B"]);
assert.ok(getField(RECORD_TOPICS.anchor, "guess").afterAssign && !getField(RECORD_TOPICS.anchor, "trip").afterAssign);
assert.ok(RECORD_TOPICS.anchor.linked && RECORD_TOPICS.trip.linked && !RECORD_TOPICS.alphabet.linked && !RECORD_TOPICS.sleep.linked && !RECORD_TOPICS.planes.linked && !RECORD_TOPICS.paidwork.linked);
assert.deepEqual(getField(RECORD_TOPICS.paidwork, "worked").options, ["no", "yes"]);
assert.equal(getRecordTopic("__proto__"), null); assert.equal(getRecordTopic("pulse"), null); assert.equal(getField(RECORD_TOPICS.planes, "toString"), null);

// types and ranges: every kind, both edges, the grid, and the wrong JavaScript types (no strings, no booleans)
{ const F = (t, f) => getField(RECORD_TOPICS[t], f);
  const ok = (t, f, v, stored) => assert.deepEqual(toStored(F(t, f), v), { value: stored }, `${t}.${f} ${v}`);
  const no = (t, f, v) => assert.ok(toStored(F(t, f), v).error, `${t}.${f} ${JSON.stringify(v)} refused`);
  ok("alphabet", "seconds", 5.83, 583); ok("alphabet", "seconds", 1, 100); ok("alphabet", "seconds", 60, 6000); ok("alphabet", "seconds", 4.1, 410); ok("alphabet", "seconds", 12.07, 1207);
  for (const v of [5.835, 0.99, 60.01, -3, "5.83", NaN, Infinity, null, true, [5]]) no("alphabet", "seconds", v);
  ok("planes", "metres", 4.3, 43); ok("planes", "metres", 0, 0); ok("planes", "metres", 60, 600); ok("planes", "metres", 10.1, 101);
  for (const v of [4.35, -0.1, 60.1, "4.3"]) no("planes", "metres", v);
  ok("sleep", "hours", 7.5, 75); ok("sleep", "hours", 0, 0); ok("sleep", "hours", 16, 160); ok("sleep", "hours", 8, 80);
  for (const v of [7.3, 7.25, 16.5, -0.5]) no("sleep", "hours", v);
  ok("sleep", "wake", 405, 405); ok("sleep", "wake", 0, 0); ok("sleep", "wake", 1435, 1435); ok("sleep", "weekend", 600, 600);
  for (const v of [407, 1440, -5, 6.5, "06:45"]) no("sleep", "wake", v);
  ok("alphabet", "how", 0, 0); ok("alphabet", "how", 1, 1); ok("sleep", "sleepy", 4, 4); ok("trip", "way", 3, 3);
  for (const v of [2, -1, 0.5, true, "0", null]) no("alphabet", "how", v);
  no("sleep", "sleepy", 5);
  ok("alphabet", "tries", 1, 1); ok("alphabet", "tries", 5, 5); for (const v of [0, 6, 2.5]) no("alphabet", "tries", v);
  ok("anchor", "guess", 0, 0); ok("anchor", "guess", 20000, 20000); for (const v of [-1, 20001, 2500.5]) no("anchor", "guess", v);
  assert.equal(fromStored(F("alphabet", "seconds"), 583), 5.83); assert.equal(fromStored(F("planes", "metres"), 43), 4.3);
  assert.equal(fromStored(F("sleep", "hours"), 75), 7.5); assert.equal(fromStored(F("sleep", "wake"), 405), 405); assert.equal(fromStored(F("trip", "way"), 2), 2);
  assert.match(toStored(F("alphabet", "seconds"), 99).error, /1 to 60/); assert.match(toStored(F("sleep", "wake"), 407).error, /steps of 5 minutes/); }

// records: one per device, fields merge (a later section adds or replaces a field and keeps the rest), values read one field at a time
{ const env = { DB: d1() }; const { code, teacherKey } = await mk(env);
  assert.deepEqual(await J(await rec(env, code, "alphabet", { how: 0, tries: 2, seconds: 5.83 }, 1)), { ok: true, n: 1 }, "no group on a topic without one");
  assert.deepEqual(await J(await rec(env, code, "alphabet", { how: 1, seconds: 12.4 }, 2)), { ok: true, n: 2 });
  assert.deepEqual(await J(await rec(env, code.toLowerCase(), "alphabet", { seconds: 4.21 }, 3)), { ok: true, n: 3 });
  assert.deepEqual(await J(await rec(env, code, "alphabet", { seconds: 6.1 }, 1)), { ok: true, n: 3 }, "same device: a partial post replaces that field only");
  const sec = await vals(env, `code=${code}&topic=alphabet&field=seconds`);
  assert.deepEqual(sec.values, [4.21, 6.1, 12.4]); assert.equal(sec.n, 3); assert.equal(sec.field, "seconds"); assert.equal(sec.ids, undefined); assert.match(sec.updated, /^\d{4}-/);
  assert.deepEqual((await vals(env, `code=${code}&topic=alphabet&field=how`)).values, [0, 1], "device 1 kept its how after the partial post");
  assert.deepEqual((await vals(env, `code=${code}&topic=alphabet&field=tries`)).values, [2], "a skipped field is simply absent");
  assert.deepEqual(env.DB.db.prepare("SELECT DISTINCT topic FROM class_values ORDER BY topic").all().map(r => r.topic), ["alphabet.how", "alphabet.seconds", "alphabet.tries"]);
  assert.equal(env.DB.db.prepare("SELECT typeof(value) t FROM class_values WHERE topic = 'alphabet.seconds' LIMIT 1").get().t, "integer", "decimals are stored as integers");
  assert.deepEqual(env.DB.db.prepare("SELECT value FROM class_values WHERE topic = 'alphabet.seconds' ORDER BY value").all().map(r => r.value), [421, 610, 1240]);
  const hashes = env.DB.db.prepare("SELECT device_hash FROM class_records").all().map(r => r.device_hash);
  assert.ok(hashes.length === 3 && hashes.every(h => /^[0-9a-f]{64}$/.test(h)), "records hold only the device hash");
  // reading: not-linked topics are values-only for students; the teacher sees whole records with ids, in arrival order
  assert.equal((await call(env, "GET", `/records?code=${code}&topic=alphabet`)).status, 403, "students cannot match up a not-linked topic's fields");
  const t = await recs(env, code, "alphabet", { "X-Teacher-Key": teacherKey });
  assert.deepEqual(t.fields, ["how", "tries", "seconds"]); assert.equal(t.n, 3); assert.equal(t.ids.length, 3);
  assert.deepEqual(t.rows, [[0, 2, 6.1], [1, null, 12.4], [null, null, 4.21]]);
  assert.equal((await call(env, "GET", `/records?code=${code}&topic=alphabet`, { headers: { "X-Teacher-Key": "x".repeat(32) } })).status, 403);
  const tv = await vals(env, `code=${code}&topic=alphabet&field=seconds`, { "X-Teacher-Key": teacherKey });
  assert.equal(tv.ids.length, 3, "the teacher's field read keeps ids too");
  // reading errors
  for (const q of [`code=${code}&topic=alphabet`, `code=${code}&topic=alphabet&field=nope`, `code=${code}&topic=alphabet&field=__proto__`, `code=${code}&topic=pulse&field=x`, `code=bad&topic=alphabet&field=how`]) {
    assert.equal((await call(env, "GET", "/values?" + q)).status, 400, q); }
  assert.equal((await call(env, "GET", "/values?code=ZZZZZZ&topic=alphabet&field=how")).status, 404);
  assert.equal((await call(env, "GET", `/records?code=${code}&topic=pulse`)).status, 400, "a chapter 5 topic has no records");
  assert.equal((await call(env, "GET", "/records?code=ZZZZZZ&topic=trip")).status, 404);
  // the teacher removes one whole record: every field goes, other records and other topics stay
  await rec(env, code, "sleep", { wake: 400 }, 1);
  assert.deepEqual(await J(await call(env, "DELETE", "/record", { body: { code, teacherKey, id: t.ids[0] } })), { ok: true });
  assert.deepEqual((await recs(env, code, "alphabet", { "X-Teacher-Key": teacherKey })).rows, [[1, null, 12.4], [null, null, 4.21]]);
  assert.deepEqual((await vals(env, `code=${code}&topic=alphabet&field=how`)).values, [1]);
  assert.deepEqual((await vals(env, `code=${code}&topic=sleep&field=wake`)).values, [400], "the same student's sleep record is not touched");
  assert.equal((await call(env, "DELETE", "/record", { body: { code, teacherKey, id: t.ids[0] } })).status, 404, "already gone");
  assert.equal((await call(env, "DELETE", "/record", { body: { code, teacherKey: "y".repeat(32), id: t.ids[1] } })).status, 403);
  assert.equal((await call(env, "DELETE", "/record", { body: { code, id: t.ids[1] } })).status, 403, "no key at all");
  assert.equal((await call(env, "DELETE", "/record", { body: { code, teacherKey, id: "2" } })).status, 400);
  const other = await mk(env, "9.9.9.9"); await rec(env, other.code, "planes", { metres: 3.2 }, 1);
  const otherId = (await recs(env, other.code, "planes", { "X-Teacher-Key": other.teacherKey })).ids[0];
  assert.equal((await call(env, "DELETE", "/record", { body: { code, teacherKey, id: otherId } })).status, 404, "a record of another class is not deletable");
  assert.equal((await call(env, "DELETE", "/record", { body: { code: other.code, teacherKey, id: otherId } })).status, 403, "class A's key does not open class B");
  assert.equal((await recs(env, other.code, "planes", { "X-Teacher-Key": other.teacherKey })).n, 1, "refused deletes removed nothing");
  // a re-entry after a removal starts a fresh record
  assert.deepEqual(await J(await rec(env, code, "alphabet", { seconds: 5.5 }, 1)), { ok: true, n: 3 });
}

// write validation: nothing malformed is stored, and a malformed request spends no allowance
{ const env = { DB: d1(), CLASSDATA_VALUE_DAILY_LIMIT: "1" }; const { code } = await mk(env);
  const bad = async (b, status = 400) => assert.equal((await call(env, "POST", "/record", { body: b })).status, status, JSON.stringify(b));
  const ok = { code, topic: "alphabet", values: { how: 0 }, device: dev(1) };
  await bad({ ...ok, topic: "pulse" }); await bad({ ...ok, topic: "nope" }); await bad({ ...ok, topic: "__proto__" }); await bad({ ...ok, topic: undefined });
  await bad({ ...ok, values: {} }); await bad({ ...ok, values: [0] }); await bad({ ...ok, values: null }); await bad({ ...ok, values: 3 }); await bad({ ...ok, values: undefined });
  await bad({ ...ok, values: { colour: 1 } }); await bad({ ...ok, values: { how: 0, toString: 1 } }); await bad({ ...ok, values: { how: 2 } }); await bad({ ...ok, values: { how: "0" } });
  await bad({ ...ok, values: { seconds: 5.835 } }); await bad({ ...ok, values: { seconds: 61 } }); await bad({ ...ok, values: { tries: 0 } }); await bad({ ...ok, values: { how: 0, seconds: "5" } });
  await bad({ ...ok, topic: "sleep", values: { wake: 403 } }); await bad({ ...ok, topic: "sleep", values: { hours: 7.2 } }); await bad({ ...ok, topic: "planes", values: { metres: 4.35 } });
  await bad({ ...ok, topic: "anchor", values: { group: 1 } }); await bad({ ...ok, topic: "trip", values: { minutes: 181 } }); await bad({ ...ok, topic: "trip", values: { way: 4 } });
  await bad({ ...ok, code: "ABC" }); await bad({ ...ok, device: "short" }); await bad({ ...ok, device: undefined });
  await bad("{not json"); await bad("[]");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values").get().n + env.DB.db.prepare("SELECT COUNT(*) n FROM class_records").get().n, 0, "nothing was stored");
  assert.equal((await call(env, "POST", "/record", { body: ok })).status, 200, "the one allowed write is still there");
  assert.equal((await call(env, "POST", "/record", { body: { ...ok, device: dev(2) } })).status, 429);
  const e2 = { DB: d1() }; const c2 = await mk(e2);
  assert.equal((await call(e2, "POST", "/record", { body: { ...ok, code: "ZZZZZZ" } })).status, 404, "well-formed, no such class");
  assert.equal((await call(e2, "POST", "/assign", { body: { code: c2.code, topic: "alphabet", device: dev(1) } })).status, 400, "alphabet has no groups");
  assert.equal((await call(e2, "POST", "/assign", { body: { code: c2.code, topic: "pulse", device: dev(1) } })).status, 400);
  assert.equal((await call(e2, "POST", "/assign", { body: { code: c2.code, topic: "anchor", device: "x" } })).status, 400);
  assert.equal((await call(e2, "POST", "/assign", { body: { code: "ZZZZZZ", topic: "anchor", device: dev(1) } })).status, 404);
}

// the reused pools: sleep (1.3 then 2.6) and trip (2.4, 2.5 and chapter 5's commute are one list of minutes)
{ const env = { DB: d1() }; const { code, teacherKey } = await mk(env);
  await rec(env, code, "sleep", { wakes: 0, sleepy: 2, wake: 405, hours: 7.5 }, 1);   // in 1.3
  await rec(env, code, "sleep", { weekend: 600 }, 1);                                 // in 2.6: the wake time from 1.3 is still there
  await rec(env, code, "sleep", { wake: 380, weekend: 545 }, 2);                       // a student who skipped 1.3
  assert.deepEqual((await recs(env, code, "sleep", { "X-Teacher-Key": teacherKey })).rows, [[0, 2, 405, 7.5, 600], [null, null, 380, null, 545]]);
  assert.deepEqual((await vals(env, `code=${code}&topic=sleep&field=weekend`)).values, [545, 600]);
  assert.deepEqual(await J(await rec(env, code, "trip", { way: 0, minutes: 25 }, 1)), { ok: true, n: 1 });
  assert.deepEqual((await vals(env, `code=${code}&topic=commute`)).values, [25], "a 2.4 trip's minutes are in the chapter 5 commute list");
  assert.deepEqual(await J(await put(env, code, "commute", 30, 1)), { ok: true, n: 1 }, "a 5.2 entry by the same device replaces it");
  assert.deepEqual((await vals(env, `code=${code}&topic=trip&field=minutes`)).values, [30]);
  await put(env, code, "commute", 12, 3);   // a chapter 5 page only: in the minutes list, not a trip record (it has no way)
  assert.deepEqual((await vals(env, `code=${code}&topic=trip&field=minutes`)).values, [12, 30]);
  const tr = await recs(env, code, "trip");
  assert.deepEqual(tr.fields, ["way", "minutes"]); assert.deepEqual(tr.rows, [[0, 30]]); assert.equal(tr.ids, undefined, "students get no ids");
  // students: shuffled order (every row there), teacher: arrival order
  for (let i = 10; i < 40; i++) await rec(env, code, "trip", { way: i % 4, minutes: i }, i);
  const a = await recs(env, code, "trip"), b = await recs(env, code, "trip"), t = await recs(env, code, "trip", { "X-Teacher-Key": teacherKey });
  const key = r => r.join(":");
  assert.deepEqual(a.rows.map(key).sort(), t.rows.map(key).sort()); assert.equal(a.n, 31);
  assert.ok(a.rows.map(key).join() !== t.rows.map(key).join() || b.rows.map(key).join() !== t.rows.map(key).join(), "student order is shuffled");
  assert.deepEqual(t.rows.slice(0, 2), [[0, 30], [2, 10]]);
  // removing a trip record removes its minutes from the shared commute list too (they are one of its fields)
  const before = (await vals(env, `code=${code}&topic=commute`)).values;
  await call(env, "DELETE", "/record", { body: { code, teacherKey, id: t.ids[0] } });
  const after = (await vals(env, `code=${code}&topic=commute`)).values;
  assert.equal(after.length, before.length - 1); assert.equal(after.filter(v => v === 30).length, before.filter(v => v === 30).length - 1);
  assert.ok(after.includes(12), "the chapter 5 only value stays");
}

// 1.4: random assignment by the server, in blocks of two per class code
{ const env = { DB: d1(), CLASSDATA_CLASS_WRITE_DAILY_LIMIT: "100000" }; const { code, teacherKey } = await mk(env);
  assert.equal((await rec(env, code, "anchor", { guess: 2500 }, 1)).status, 409, "no guess before the group exists");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_records").get().n, 0, "the refused guess made no record");
  const g1 = await J(await assign(env, code, "anchor", 1));
  assert.ok(g1.ok && (g1.group === 0 || g1.group === 1) && g1.n === 1, JSON.stringify(g1));
  assert.deepEqual(await J(await assign(env, code, "anchor", 1)), g1, "asking again (a reload) gives the same group");
  const r1 = await J(await rec(env, code, "anchor", { trip: 1, guess: 2500 }, 1));
  assert.deepEqual(r1, { ok: true, n: 1, group: g1.group }, "the record comes back with its group");
  // the group cannot come from the client
  assert.equal((await rec(env, code, "anchor", { group: 1 - g1.group }, 1)).status, 400);
  await call(env, "POST", "/assign", { body: { code, topic: "anchor", device: dev(1), group: 1 - g1.group } });
  assert.equal((await J(await assign(env, code, "anchor", 1))).group, g1.group);
  // the yes/no may come first: it makes the record and assigns the group, which comes back so the page can show the question
  const r2 = await J(await rec(env, code, "anchor", { trip: 0 }, 2));
  assert.ok(r2.ok && r2.group === 1 - g1.group, "second arrival of the block gets the other group");
  assert.equal((await rec(env, code, "anchor", { guess: 7000 }, 2)).status, 200, "and now the guess is accepted");
  for (let i = 3; i <= 200; i++) await assign(env, code, "anchor", i);
  const rows = env.DB.db.prepare("SELECT seq, grp FROM class_records WHERE code = ? AND topic = 'anchor' ORDER BY seq").all(code);
  assert.deepEqual(rows.map(r => r.seq), [...Array(200).keys()], "seq is 0, 1, 2 ... with no gaps or repeats");
  for (let k = 0; k < 100; k++) assert.equal(rows[2 * k].grp + rows[2 * k + 1].grp, 1, `block ${k} has one of each`);
  assert.equal(rows.filter(r => r.grp === 0).length, 100, "200 arrivals: 100 in each group");
  const firsts = rows.filter(r => r.seq % 2 === 0).map(r => r.grp);
  assert.ok(firsts.includes(0) && firsts.includes(1), "the first of each block is a coin, not always A");
  await assign(env, code, "anchor", 201);
  const odd = env.DB.db.prepare("SELECT grp, COUNT(*) n FROM class_records WHERE code = ? GROUP BY grp").all(code).map(r => r.n);
  assert.equal(Math.abs(odd[0] - odd[1]), 1, "an odd count is off by one at most");
  // records of a linked topic: students see group, yes/no, guess (shuffled, no ids); hidden fields are null until sent
  const s = await recs(env, code, "anchor");
  assert.deepEqual(s.fields, ["group", "trip", "guess"]); assert.equal(s.n, 201); assert.equal(s.ids, undefined);
  assert.deepEqual(s.rows.filter(r => r[2] !== null).map(r => r.join(":")).sort(), [`${g1.group}:1:2500`, `${1 - g1.group}:0:7000`].sort());
  // blocks are per class code: another class starts its own at seq 0
  const other = await mk(env, "8.8.8.8");
  const o1 = await J(await assign(env, other.code, "anchor", 1)), o2 = await J(await assign(env, other.code, "anchor", 2));
  assert.equal(o1.group + o2.group, 1); assert.deepEqual(env.DB.db.prepare("SELECT seq FROM class_records WHERE code = ? ORDER BY seq").all(other.code).map(r => r.seq), [0, 1]);
  // the teacher removes one: its guess goes with it, the next arrival takes the next seq
  const tIds = (await recs(env, code, "anchor", { "X-Teacher-Key": teacherKey })).ids;
  await call(env, "DELETE", "/record", { body: { code, teacherKey, id: tIds[1] } });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values WHERE topic LIKE 'anchor.%'").get().n, 2, "device 2's yes/no and guess are gone");
  await assign(env, code, "anchor", 999);
  assert.equal(env.DB.db.prepare("SELECT MAX(seq) m FROM class_records WHERE code = ?").get(code).m, 201);
}
// block randomisation holds when arrivals come all at once
{ const env = { DB: d1() }; const { code } = await mk(env);
  const got = await Promise.all([...Array(60).keys()].map(i => assign(env, code, "anchor", 1000 + i).then(J)));
  assert.ok(got.every(g => g.ok), "every simultaneous arrival got a group");
  const rows = env.DB.db.prepare("SELECT seq, grp FROM class_records WHERE code = ? ORDER BY seq").all(code);
  assert.deepEqual(rows.map(r => r.seq), [...Array(60).keys()]);
  for (let k = 0; k < 30; k++) assert.equal(rows[2 * k].grp + rows[2 * k + 1].grp, 1, `simultaneous block ${k}`);
}

// rate limits per class code (a school network shares one IP), with the per-IP limit kept as a loose backstop
{ // defaults: one school IP sends far more than the old 200 a day, across classes and records
  const env = { DB: d1() }; const a = await mk(env), b = await mk(env);
  for (let i = 1; i <= 260; i++) assert.equal((await rec(env, i % 2 ? a.code : b.code, "sleep", { wakes: i % 4, sleepy: i % 5, wake: 400, hours: 8 }, i)).status, 200, `school value ${i}`);
  const ip = env.DB.db.prepare("SELECT count FROM ai_chat_usage WHERE client_id LIKE 'cd:v:%'").get().count;
  assert.equal(ip, 260, "a four-field record costs one unit, not four");
}
{ const env = { DB: d1(), CLASSDATA_CLASS_WRITE_DAILY_LIMIT: "3" }; const a = await mk(env), b = await mk(env);
  for (let i = 1; i <= 3; i++) assert.equal((await rec(env, a.code, "planes", { metres: i }, i, { ip: `10.0.0.${i}` })).status, 200);
  const r = await rec(env, a.code, "planes", { metres: 4 }, 4, { ip: "10.0.0.4" });
  assert.equal(r.status, 429, "class A has used its day, from any network"); assert.match((await J(r)).error, /class has sent its daily limit/);
  assert.equal((await put(env, a.code, "pulse", 70, 5, { ip: "10.0.0.5" })).status, 429, "chapter 5 values count against the same class");
  assert.equal((await assign(env, a.code, "anchor", 6, { ip: "10.0.0.6" })).status, 429, "so does an assignment");
  assert.equal((await rec(env, b.code, "planes", { metres: 4 }, 4, { ip: "10.0.0.1" })).status, 200, "class B has its own count");
  assert.equal((await call(env, "GET", `/values?code=${a.code}&topic=planes&field=metres`)).status, 200, "reads are not counted");
  const keys = env.DB.db.prepare("SELECT client_id FROM ai_chat_usage WHERE client_id LIKE 'cd:k:%'").all().map(x => x.client_id);
  assert.ok(keys.length === 2 && keys.every(k => /^cd:k:[0-9a-f]{32}$/.test(k)), "per-class keys are hashed");
  assert.ok(!JSON.stringify(env.DB.db.prepare("SELECT * FROM ai_chat_usage").all()).includes(a.code), "no class code in the usage table");
}
{ const env = { DB: d1(), CLASSDATA_VALUE_DAILY_LIMIT: "2" }; const a = await mk(env), b = await mk(env);
  assert.equal((await rec(env, a.code, "planes", { metres: 1 }, 1)).status, 200); assert.equal((await rec(env, b.code, "planes", { metres: 1 }, 2)).status, 200);
  const r = await rec(env, b.code, "planes", { metres: 2 }, 3); assert.equal(r.status, 429, "the per-IP backstop still holds"); assert.match((await J(r)).error, /network/);
  assert.equal((await rec(env, b.code, "planes", { metres: 2 }, 3, { ip: "4.4.4.4" })).status, 200);
  assert.equal((await rec(env, b.code, "planes", { metres: 2 }, 4, { ip: null })).status, 503, "no IP: refused");
}

// the record and per-key caps hold for a new device, not for one replacing its own answer
{ const env = { DB: d1() }; const { code } = await mk(env);
  await rec(env, code, "planes", { metres: 1 }, 1);
  const ins = env.DB.db.prepare("INSERT INTO class_records (code, topic, device_hash) VALUES (?, 'planes', ?)");
  for (let i = 0; i < 1999; i++) ins.run(code, "h" + i);
  assert.equal((await rec(env, code, "planes", { metres: 2 }, 2)).status, 409);
  assert.equal((await rec(env, code, "planes", { metres: 2 }, 1)).status, 200, "an existing record can still change");
  assert.equal((await rec(env, code, "alphabet", { how: 0 }, 2)).status, 200, "other topics are unaffected");
  const iv = env.DB.db.prepare("INSERT INTO class_values (code, topic, value, device_hash) VALUES (?, 'commute', 10, ?)");
  for (let i = 0; i < 2000; i++) iv.run(code, "c" + i);
  assert.equal((await rec(env, code, "trip", { way: 0, minutes: 9 }, 3)).status, 409, "the shared commute list is full");
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_records WHERE topic = 'trip'").get().n, 0, "a refused write leaves no empty record");
}

// All my classes (2.2): pooled values of several codes, values only
{ const env = { DB: d1() }; const a = await mk(env), b = await mk(env);
  await rec(env, a.code, "alphabet", { seconds: 5.1 }, 1); await rec(env, a.code, "alphabet", { seconds: 6.2 }, 2); await rec(env, b.code, "alphabet", { seconds: 4.4 }, 1);
  const p = await vals(env, `codes=${a.code},${b.code.toLowerCase()},${a.code}&topic=alphabet&field=seconds`, { "X-Teacher-Key": a.teacherKey });
  assert.deepEqual(p.values, [4.4, 5.1, 6.2]); assert.equal(p.n, 3); assert.deepEqual(p.codes, [a.code, b.code]); assert.deepEqual(p.per, { [a.code]: 2, [b.code]: 1 });
  assert.equal(p.ids, undefined, "never ids, even with a teacher key");
  await put(env, a.code, "pulse", 70, 1); await put(env, b.code, "pulse", 64, 1);
  assert.deepEqual((await vals(env, `codes=${a.code},${b.code}&topic=pulse`)).values, [64, 70], "chapter 5 topics pool too");
  for (const q of [`codes=&topic=pulse`, `codes=${a.code},bad&topic=pulse`, `codes=${a.code}&topic=nope`, `codes=${a.code}&topic=alphabet`, `codes=${a.code}&topic=pulse&field=x`,
                   `codes=${Array(13).fill(0).map((_, i) => "ABCDE" + "ABCDEFGHJKMNP"[i]).join(",")}&topic=pulse`]) assert.equal((await call(env, "GET", "/values?" + q)).status, 400, q);
  assert.equal((await call(env, "GET", `/values?codes=${a.code},ZZZZZZ&topic=pulse`)).status, 404);
}

// routing, methods and same origin for the new routes
{ const env = { DB: d1() }; const { code, teacherKey } = await mk(env);
  assert.equal((await call(env, "GET", "/record")).status, 405); assert.equal((await call(env, "PUT", "/record", { body: {} })).status, 405);
  assert.equal((await call(env, "POST", "/records", { body: {} })).status, 405); assert.equal((await call(env, "GET", "/assign")).status, 405);
  assert.equal((await rec(env, code, "planes", { metres: 3 }, 1, { origin: "https://evil.example" })).status, 403);
  assert.equal((await assign(env, code, "anchor", 1, { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(env, "DELETE", "/record", { body: { code, teacherKey, id: 1 }, origin: "https://evil.example" })).status, 403);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_records").get().n, 0);
  assert.equal((await rec(env, code, "planes", { metres: 3 }, 1, { origin: "https://x.test" })).status, 200);
  const g = await call(env, "GET", `/records?code=${code}&topic=trip`); assert.equal(g.headers.get("Cache-Control"), "no-store"); assert.equal(g.headers.get("Access-Control-Allow-Origin"), null);
}

// lazy retention covers records
{ const env = { DB: d1() }; const old = await mk(env), fresh = await mk(env);
  await rec(env, old.code, "planes", { metres: 2 }, 1); await rec(env, fresh.code, "planes", { metres: 3 }, 1);
  env.DB.db.prepare("UPDATE classes SET created_at = datetime('now', '-401 days') WHERE code = ?").run(old.code);
  await mk(env);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_records WHERE code = ?").get(old.code).n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_values WHERE code = ?").get(old.code).n, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) n FROM class_records WHERE code = ?").get(fresh.code).n, 1);
}

// backward compatibility: with 0016 applied and 0018 NOT applied, chapter 5 works exactly as before, and the new routes answer with the
// JSON 500 a page reads as "Class data is not connected yet" (never a 404, which would make it offer a class it cannot write to)
{ const env = { DB: d1({ records: false }) };
  const { code, teacherKey } = await mk(env);
  assert.match(code, CODE_RE, "class codes still made (the records sweep is skipped)");
  assert.deepEqual(await J(await put(env, code, "pulse", 72, 1)), { ok: true, n: 1 });
  assert.deepEqual(await J(await put(env, code, "commute", 20, 1)), { ok: true, n: 1 });
  const t = await J(await call(env, "GET", `/values?code=${code}&topic=pulse`, { headers: { "X-Teacher-Key": teacherKey } }));
  assert.deepEqual(t.values, [72]);
  assert.deepEqual(await J(await call(env, "DELETE", "/value", { body: { code, teacherKey, id: t.ids[0] } })), { ok: true });
  assert.equal((await call(env, "GET", "/values?code=AAAAAA&topic=pulse")).status, 404, "the chapter 5 probe still reads as connected");
  for (const [m, path, body] of [["GET", "/values?code=AAAAAA&topic=planes&field=metres"], ["GET", `/values?code=${code}&topic=planes&field=metres`], ["GET", `/records?code=${code}&topic=trip`],
                                 ["POST", "/record", { code, topic: "planes", values: { metres: 3 }, device: dev(1) }], ["POST", "/assign", { code, topic: "anchor", device: dev(1) }]]) {
    const r = await call(env, m, path, body ? { body } : {});
    assert.equal(r.status, 500, path); assert.equal(typeof (await J(r)).error, "string");
  }
}
// and the chapter 5 rows written before 0018 are untouched by applying it (it only adds a table)
{ const db = new DatabaseSync(":memory:"); db.exec(usageSql); db.exec(migration);
  db.prepare("INSERT INTO classes (code, teacher_key_hash) VALUES ('ABCDEF', 'h')").run();
  db.prepare("INSERT INTO class_values (code, topic, value, device_hash) VALUES ('ABCDEF', 'pulse', 70, 'd')").run();
  db.exec(recordsSql); db.exec(recordsSql);   // twice: IF NOT EXISTS makes it safe to re-run
  assert.deepEqual(db.prepare("SELECT code, topic, value FROM class_values").all().map(r => ({ ...r })), [{ code: "ABCDEF", topic: "pulse", value: 70 }]);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'class%' ORDER BY name").all().map(r => r.name), ["class_records", "class_values", "classes"]);
  assert.throws(() => db.prepare("INSERT INTO class_records (code, topic, device_hash, grp) VALUES ('ABCDEF', 'anchor', 'd', 2)").run(), /CHECK/, "grp is only 0 or 1");
}
console.log("classdata.test.mjs: ok");
