'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('./server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmiyc-'));
async function start(dir = tmp()) {
  const s = createServer({ dataDir: dir, adminToken: 'secret' });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  return { s, dir, base: 'http://127.0.0.1:' + s.address().port };
}
const call = (base, p, o = {}) => fetch(base + p, {
  ...o, headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'tester01', ...(o.headers || {}) }
});
const good = { cat: 'noship', area: 'กรุงเทพมหานคร', platform: 'Facebook', title: 'เพจขายกล้องบล็อกผู้ซื้อหลังโอน', detail: 'ราคาถูกมาก ให้โอนเต็มจำนวนก่อนส่งของ แล้วถูกบล็อกหลังโอน', ident: 'bad.example' };

test('create + list report, uid is never exposed', async () => {
  const { s, base } = await start();
  const r = await call(base, '/api/reports', { method: 'POST', body: JSON.stringify(good) });
  assert.equal(r.status, 201);
  const list = await (await call(base, '/api/reports')).json();
  assert.equal(list.reports.length, 1);
  assert.equal(list.reports[0].title, good.title);
  assert.equal(list.reports[0].platform, 'Facebook');
  assert.equal('uid' in list.reports[0], false);
  s.close();
});

test('report validation', async () => {
  const { s, base } = await start();
  const post = b => call(base, '/api/reports', { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await post({ ...good, title: 'สั้น' })).status, 400);
  assert.equal((await post({ ...good, cat: 'nope' })).status, 400);
  assert.equal((await post({ ...good, cat: 'callcenter' })).status, 400);
  assert.equal((await post({ ...good, detail: 'เลขบัตร 1234567890123 อยู่ตรงนี้นะ' })).status, 400);
  assert.equal((await call(base, '/api/reports', { method: 'POST', body: JSON.stringify(good), headers: { 'X-Client-Id': 'x' } })).status, 400);
  assert.equal((await call(base, '/api/reports', { method: 'POST', body: '{bad json' })).status, 400);
  s.close();
});

test('verify is one per user, mine flag is per caller, delete only your own', async () => {
  const { s, base } = await start();
  const rep = await (await call(base, '/api/reports', { method: 'POST', body: JSON.stringify(good) })).json();
  const id = rep.id + '__tester01';
  const body = JSON.stringify({ rid: rep.id, kind: 'verify' });
  assert.equal((await call(base, '/api/confirms/' + id, { method: 'PUT', body })).status, 200);
  assert.equal((await call(base, '/api/confirms/' + id, { method: 'PUT', body })).status, 200); // idempotent
  assert.equal((await call(base, '/api/confirms/' + rep.id + '__someoneelse', { method: 'PUT', body })).status, 400);
  let mine = (await (await call(base, '/api/confirms')).json()).confirms;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].mine, true);
  const other = (await (await call(base, '/api/confirms', { headers: { 'X-Client-Id': 'other0001' } })).json()).confirms;
  assert.equal(other[0].mine, false);
  assert.equal((await call(base, '/api/confirms/' + id, { method: 'DELETE', headers: { 'X-Client-Id': 'other0001' } })).status, 403);
  assert.equal((await call(base, '/api/confirms/' + id, { method: 'DELETE' })).status, 204);
  mine = (await (await call(base, '/api/confirms')).json()).confirms;
  assert.equal(mine.length, 0);
  s.close();
});

test('tips: need a known report (or sample id)', async () => {
  const { s, base } = await start();
  const tip = rid => call(base, '/api/confirms', { method: 'POST', body: JSON.stringify({ rid, kind: 'tip', text: 'เจอเบอร์เดียวกันโทรมาเมื่อวาน' }) });
  assert.equal((await tip('r_missing')).status, 400);
  assert.equal((await tip('s01')).status, 201);
  s.close();
});

test('static files, security headers, path traversal', async () => {
  const { s, base } = await start();
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Catch Me If You Can/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  const bad = await fetch(base + '/..%2f..%2fserver%2fserver.js');
  assert.ok([403, 404].includes(bad.status));
  assert.equal((await fetch(base + '/server/server.js')).status, 404);
  s.close();
});

test('data survives a restart', async () => {
  const a = await start();
  await call(a.base, '/api/reports', { method: 'POST', body: JSON.stringify(good) });
  a.s.store.flush(); a.s.close();
  const b = await start(a.dir);
  const list = await (await call(b.base, '/api/reports')).json();
  assert.equal(list.reports.length, 1);
  b.s.close();
});

test('admin delete needs the token', async () => {
  const { s, base } = await start();
  const rep = await (await call(base, '/api/reports', { method: 'POST', body: JSON.stringify(good) })).json();
  assert.equal((await call(base, '/api/reports/' + rep.id, { method: 'DELETE' })).status, 403);
  assert.equal((await call(base, '/api/reports/' + rep.id, { method: 'DELETE', headers: { 'X-Admin-Token': 'secret' } })).status, 204);
  assert.equal((await (await call(base, '/api/reports')).json()).reports.length, 0);
  s.close();
});

test('body size cap and rate limit', async () => {
  const { s, base } = await start();
  const big = await call(base, '/api/reports', { method: 'POST', body: JSON.stringify({ ...good, detail: 'x'.repeat(20000) }) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  let got429 = false;
  for (let i = 0; i < 40; i++) {
    const r = await call(base, '/api/reports', { method: 'POST', body: JSON.stringify({ ...good, title: 'ทดสอบ ' + i + ' ครั้ง' }) });
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429);
  s.close();
});
