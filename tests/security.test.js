'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { parseOrigins, fitsSend, LIMITS } = require('../server');
const { fixture, client, mutation, request } = require('./helpers.cjs');

test('configuration requires explicit, canonical HTTPS origins', () => {
  for (const value of ['', undefined, '*', 'null', 'http://localhost', 'https://localhost/', 'https://*.home.arpa', 'https://user:pass@localhost', 'https://localhost?x', 'https://localhost/#x']) assert.throws(() => parseOrigins(value));
  assert.equal(parseOrigins('https://192.168.1.50:3457, https://chuk-it.home.arpa:3457').size, 2);
});

test('Origin, Host and path checks reject foreign browsers before history', async t => {
  const app = await fixture(); t.after(app.close);
  const good = client(app); const init = await good.next('init');
  const add = mutation(init.session, 'add', { text: 'secret fixture' }); good.send(add); await good.next('ack');
  for (const options of [
    { origin: 'https://untrusted.example' }, { origin: 'null' }, { origin: null },
    { origin: app.origin + '.evil.example' }, { origin: app.origin + '/' },
    { origin: app.origin + ' https://evil.example' }, { origin: app.origin.replace('https:', 'http:') },
    { headers: { Host: 'evil.example' } }, { path: '/' }, { path: '/ws?anything' },
    { origin: app.origins[1] }, { headers: { 'Sec-WebSocket-Protocol': 'clipboard' } },
  ]) {
    const bad = client(app, options);
    const status = await new Promise((resolve, reject) => {
      bad.ws.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); bad.ws.terminate(); });
      bad.ws.on('open', () => reject(new Error('Foreign origin connected')));
    });
    assert.equal(status, 403, JSON.stringify(options)); assert.equal(bad.messages.length, 0);
  }
  const alternate = client(app, { origin: app.origins[1], headers: { Host: `localhost:${app.port}` } });
  assert.equal((await alternate.next('init')).clips[0].text, 'secret fixture');
  assert.equal(alternate.ws.extensions, '');
});

test('HTTP routes, methods, response headers and TLS are restricted', async t => {
  const app = await fixture(); t.after(app.close);
  const page = await request(app);
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(page.body, /<script>|style=/);
  assert.equal((await request(app, '/app.js')).status, 200);
  assert.equal((await request(app, '/styles.css', { method: 'HEAD' })).body, '');
  for (const route of ['/certs/key.pem', '/server.js', '/.env', '/package.json', '/../server.js', '/?x']) assert.equal((await request(app, route)).status, 404);
  assert.equal((await request(app, '/', { method: 'POST' })).status, 405);
  assert.equal((await request(app, '/', { headers: { Host: 'evil.example' }, servername: 'localhost' })).status, 403);
  await assert.rejects(request(app, '/', { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }));
  await assert.rejects(request(app, '/', { ca: undefined }));
});

test('exact text, multi-client sync, atomic dedupe and retry acknowledgements', async t => {
  const app = await fixture(); t.after(app.close);
  const a = client(app), b = client(app); const init = await a.next('init'); await b.next('init');
  const text = '  <script>synthetic</script>\r\n\tline 🙂\n ';
  const add = mutation(init.session, 'add', { text }); a.send(add);
  const ack = await a.next('ack'); const original = await b.next('add');
  assert.equal(original.clip.text, text);
  a.send(add); await delay(30);
  assert.equal(a.messages.filter(msg => msg.type === 'ack').length, 2);
  assert.equal(b.messages.filter(msg => msg.type === 'add').length, 1);
  a.send({ ...add, text: 'changed' }); assert.equal((await a.next('error')).code, 'request_conflict');
  const duplicate = mutation(init.session, 'add', { text }); b.send(duplicate);
  const replaced = await a.next('add', msg => msg.clip.id !== ack.clipId);
  assert.deepEqual(replaced.removed, [ack.clipId]); assert.notEqual(replaced.clip.id, ack.clipId);
  const reconnected = client(app); const snapshot = await reconnected.next('init');
  assert.equal(snapshot.clips.length, 1); assert.equal(snapshot.clips[0].text, text);
});

test('delete, clear and eviction synchronize all clients', async t => {
  const app = await fixture({ items: 2 }); t.after(app.close);
  const a = client(app); const { session } = await a.next('init');
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const add = mutation(session, 'add', { text: `item${i}` }); a.send(add);
    ids.push((await a.next('ack', msg => msg.requestId === add.requestId)).clipId);
  }
  assert.deepEqual(a.messages.filter(msg => msg.type === 'add').at(-1).removed, [ids[0]]);
  const remove = mutation(session, 'delete', { id: ids[1] }); a.send(remove); await a.next('delete');
  const b = client(app); assert.deepEqual((await b.next('init')).clips.map(c => c.id), [ids[2]]);
  a.send(mutation(session, 'clear')); await b.next('clear');
  const c = client(app); assert.deepEqual((await c.next('init')).clips, []);
});

test('serialized store size is bounded, including escaped text', async t => {
  const app = await fixture({ storeBytes: 1200 }); t.after(app.close);
  const a = client(app); const { session } = await a.next('init');
  for (let i = 0; i < 3; i++) {
    const msg = mutation(session, 'add', { text: String(i) + '\u0001'.repeat(60) }); a.send(msg); await a.next('ack', m => m.requestId === msg.requestId);
  }
  const b = client(app); const { clips } = await b.next('init');
  assert.equal(clips.length, 1); assert.ok(Buffer.byteLength(JSON.stringify(clips)) <= 1202);
});

test('bad JSON, binary, unknown fields and invalid types do not mutate or leak logs', async t => {
  const app = await fixture(); t.after(app.close);
  const a = client(app); const { session } = await a.next('init');
  const base = mutation(session);
  const messages = [null, [], 42, { ...base, text: 12 }, { ...base, text: ' \n\t' }, { ...base, extra: 'x' },
    { ...base, source: 'x'.repeat(41) }, { ...base, source: 'bad\nlog' }, { ...base, requestId: [base.requestId] },
    { ...base, createdAt: 'yesterday' }, { ...base, type: 'unknown' }, mutation(session, 'delete', { id: 1 })];
  for (const msg of messages) a.send(msg);
  a.ws.send('{"secret-fixture":'); a.ws.send(Buffer.from('secret-fixture'));
  await delay(50);
  assert.equal(a.messages.filter(msg => msg.type === 'error').length, messages.length + 2);
  const b = client(app); assert.deepEqual((await b.next('init')).clips, []);
  assert.deepEqual(app.logs, []);
});

test('restart session and expired requests cannot replay old actions', async t => {
  const app = await fixture(); const a = client(app); const { session } = await a.next('init');
  const add = mutation(session); a.send(add); const oldId = (await a.next('ack')).clipId;
  await app.close();
  const second = await fixture(); t.after(second.close);
  const b = client(second); const newInit = await b.next('init'); assert.notEqual(newInit.session, session);
  b.send(add); assert.equal((await b.next('error')).code, 'session_changed');
  const stale = mutation(newInit.session, 'add', { createdAt: Date.now() - LIMITS.retryMs }); b.send(stale);
  assert.equal((await b.next('error', m => m.requestId === stale.requestId)).code, 'request_expired');
  const fresh = mutation(newInit.session); b.send(fresh); assert.notEqual((await b.next('ack')).clipId, oldId);
});

test('receipt capacity fails closed without losing earlier retry protection', async t => {
  const app = await fixture({ receipts: 1 }); t.after(app.close);
  const a = client(app); const { session } = await a.next('init');
  const first = mutation(session); a.send(first); await a.next('ack');
  const next = mutation(session, 'add', { text: 'second' }); a.send(next);
  assert.equal((await a.next('error')).code, 'busy');
  a.send(first); await delay(20); assert.equal(a.messages.filter(m => m.type === 'ack').length, 2);
});

test('oversize and excessive fragmentation close one connection; server survives', async t => {
  const app = await fixture(); t.after(app.close);
  const huge = client(app); await huge.next('init'); const closed = once(huge.ws, 'close');
  huge.ws.send('x'.repeat(LIMITS.messageBytes + 1)); await closed;
  const fragments = client(app); await fragments.next('init'); const fragmentedClose = once(fragments.ws, 'close');
  for (let i = 0; i < 1026; i++) fragments.ws.send('x', { fin: false });
  await fragmentedClose;
  const healthy = client(app); assert.deepEqual((await healthy.next('init')).clips, []);
});

test('connection and handshake limits apply per address', async t => {
  const app = await fixture({ perAddress: 1, attemptsPerMinute: 3 }); t.after(app.close);
  const good = client(app); await good.next('init');
  const second = client(app);
  const status = await new Promise(resolve => second.ws.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); second.ws.terminate(); }));
  assert.equal(status, 429);
});

test('message rate and byte limits close flood senders', async t => {
  for (const limits of [{ messagesPerMinute: 2 }, { addressMessagesPerMinute: 2 }, { bytesPerMinute: 300 }]) {
    const app = await fixture(limits); t.after(app.close);
    const a = client(app); const { session } = await a.next('init'); const closed = once(a.ws, 'close');
    for (let i = 0; i < 4; i++) a.send(mutation(session, 'add', { text: String(i).repeat(100) }));
    await closed;
  }
});

test('heartbeat removes dead clients and keeps responsive clients', async t => {
  const app = await fixture({ heartbeatMs: 30 }); t.after(app.close);
  const dead = client(app, { autoPong: false }); await dead.next('init');
  const live = client(app); await live.next('init'); await once(dead.ws, 'close');
  assert.equal(live.ws.readyState, 1);
});

test('backpressure includes the next payload and the global queue', () => {
  const a = { bufferedAmount: 7 }, b = { bufferedAmount: 4 };
  const limits = { clientBuffer: 10, totalBuffer: 15 };
  assert.equal(fitsSend(a, 3, [a, b], limits), true);
  assert.equal(fitsSend(a, 4, [a, b], limits), false);
  assert.equal(fitsSend(b, 5, [a, b], limits), false);
});

test('security summaries contain counts without submitted data', async t => {
  const app = await fixture({ heartbeatMs: 25 }); t.after(app.close);
  const a = client(app); await a.next('init'); a.ws.send('{"do-not-log-this":');
  await delay(60);
  const summary = app.logs.find(line => line.includes('security_summary'));
  assert.ok(summary); assert.equal(JSON.parse(summary).counts.invalid_message, 1);
  assert.doesNotMatch(app.logs.join(''), /do-not-log-this|127\.0\.0\.1|requestId/);
});

test('global connection cap applies even when the per-address cap is higher', async t => {
  const app = await fixture({ connections: 1, perAddress: 5 }); t.after(app.close);
  const a = client(app); await a.next('init');
  const b = client(app);
  const status = await new Promise(resolve => b.ws.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); b.ws.terminate(); }));
  assert.equal(status, 429);
});

test('repeated rejected upgrades exhaust the handshake budget', async t => {
  const app = await fixture({ attemptsPerMinute: 2 }); t.after(app.close);
  for (let i = 0; i < 3; i++) {
    const bad = client(app, { origin: 'https://untrusted.example' });
    const status = await new Promise(resolve => bad.ws.on('unexpected-response', (_, res) => { res.resume(); resolve(res.statusCode); bad.ws.terminate(); }));
    assert.equal(status, i < 2 ? 403 : 429);
  }
});

test('application closes a client before sending an over-budget snapshot', async t => {
  const app = await fixture({ clientBuffer: 30 }); t.after(app.close);
  const a = client(app); await once(a.ws, 'close'); assert.equal(a.messages.length, 0);
});

test('a large initial history fits the outgoing budget', async t => {
  const app = await fixture(); t.after(app.close);
  const a = client(app); const { session } = await a.next('init');
  for (let i = 0; i < 28; i++) {
    const add = mutation(session, 'add', { text: `${i}:` + 'x'.repeat(480 * 1024) });
    a.send(add); await a.next('ack', msg => msg.requestId === add.requestId);
  }
  const b = client(app); const snapshot = await b.next('init');
  assert.equal(snapshot.clips.length, 28);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024);
});
