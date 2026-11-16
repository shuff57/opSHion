import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/server/index.js';
import { database } from './db.mjs';
import { TOPICS, TALLY_TOPICS, RECORD_TOPICS } from '../functions/_lib/classdata_topics.js';

test('public app, shared tosses, idempotent updates, numeric values, and origin isolation', async () => {
  const env = { DB: database() };
  async function call(path, body, extra = {}) {
    const r = await worker.fetch(new Request('https://opshion.test' + path, { method: body ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { r, j: (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text() };
  }
  assert.match((await call('/')).j, /A little chance/);
  assert.equal((await call('/app.js')).r.status, 200);
  const catalog = (await call('/api/catalog')).j;
  assert.ok(catalog.some(x => x.id === 'coin-sim'));
  const made = await call('/api/classdata/class', {});
  assert.equal(made.r.status, 201);
  const code = made.j.code;
  const post = (device, counts, topic = 'coin-sim') => call('/api/classdata/tally', { code, topic, counts, device });
  assert.equal((await post('student-one-123456', [6, 4])).r.status, 200);
  assert.equal((await post('student-two-123456', [2, 8])).r.status, 200);
  assert.equal((await post('student-one-123456', [6, 4])).r.status, 200);
  const pooled = await call('/api/classdata/tallies?code=' + code + '&topic=coin-sim');
  assert.deepEqual(pooled.j.counts, [8, 12]);
  assert.equal(pooled.j.total, 20); assert.equal(pooled.j.devices, 2);
  // Simulated work never pollutes real observations.
  assert.equal((await call('/api/classdata/tallies?code=' + code + '&topic=coin-real')).j.total, 0);
  const value = n => call('/api/classdata/value', { code, topic: 'pulse', value: n, device: 'student-one-123456' });
  await value(70); await value(72);
  assert.deepEqual((await call('/api/classdata/values?code=' + code + '&topic=pulse')).j.values, [72]);
  assert.equal((await value(9999)).r.status, 400);
  assert.equal((await call('/api/classdata/class', {}, { Origin: 'https://other.test' })).r.status, 403);
  assert.equal(pooled.r.headers.get('Cache-Control'), 'no-store');
  assert.equal(pooled.r.headers.get('Access-Control-Allow-Origin'), null);
  assert.ok(pooled.r.headers.get('Content-Security-Policy'));
  env.DB.close();
});

test('only the textbook origin can use the classroom API across origins', async () => {
  const env = { DB: database() };
  const url = 'https://opshion.test/api/classdata/class';
  const req = (method, origin) => new Request(url, { method, headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.3', 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  const preflight = await worker.fetch(req('OPTIONS', 'https://oerbookshelf.app'), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://oerbookshelf.app');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Teacher-Key/);
  const created = await worker.fetch(req('POST', 'https://oerbookshelf.app'), env);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('Access-Control-Allow-Origin'), 'https://oerbookshelf.app');
  assert.equal((await worker.fetch(req('OPTIONS', 'https://unrelated.test'), env)).status, 403);
  assert.equal((await worker.fetch(req('POST', 'https://unrelated.test'), env)).status, 403);
  env.DB.close();
});


test('every textbook topic is available and assignment reveals only the assigned prompt', async () => {
  const env = { DB: database() };
  const call = async (path, body) => {
    const r = await worker.fetch(new Request('https://opshion.test/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.9', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    return { status: r.status, data: await r.json() };
  };
  const { data: catalog } = await call('catalog');
  const ids = catalog.map(a => a.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of [...Object.keys(TOPICS), ...Object.keys(TALLY_TOPICS), ...Object.keys(RECORD_TOPICS), 'pulse-commute', 'height-pulse', 'playlist']) assert.ok(ids.includes(id), id);
  for (const a of catalog) assert.ok(a.title && a.prompt && a.label && a.source, a.id);
  assert.equal(catalog.find(a => a.id === 'anchor').randomize, undefined);
  assert.ok(!JSON.stringify(catalog).includes('1,500'));
  assert.ok(!JSON.stringify(catalog).includes('6,000'));
  const { data: { code } } = await call('classdata/class', {});
  const assigned = await call('classdata/assign', { code, topic: 'anchor', device: 'assignment-test-device' });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.data.prompt, RECORD_TOPICS.anchor.randomize.groups[assigned.data.group].prompt);
  const again = await call('classdata/assign', { code, topic: 'anchor', device: 'assignment-test-device' });
  assert.deepEqual(again.data, assigned.data);
  // Record writes remain partial, decimals remain display units, and commute is shared.
  for (const [topic, values] of [['alphabet', { seconds: 5.83 }], ['sleep', { wake: 405, hours: 7.5 }], ['planes', { metres: 4.3 }], ['trip', { way: 2, minutes: 18 }]]) {
    assert.equal((await call('classdata/record', { code, topic, device: 'record-test-device', values })).status, 200);
  }
  assert.deepEqual((await call('classdata/values?code=' + code + '&topic=alphabet&field=seconds')).data.values, [5.83]);
  assert.deepEqual((await call('classdata/values?code=' + code + '&topic=sleep&field=wake')).data.values, [405]);
  assert.deepEqual((await call('classdata/values?code=' + code + '&topic=planes&field=metres')).data.values, [4.3]);
  assert.deepEqual((await call('classdata/values?code=' + code + '&topic=commute')).data.values, [18]);
  assert.equal((await call('classdata/records?code=' + code + '&topic=alphabet')).status, 403);
  env.DB.close();
});
