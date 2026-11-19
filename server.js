'use strict';
/**
 * Catch Me If You Can — เซิร์ฟเวอร์กระดานเตือนภัย + static file server
 * ไม่มี dependency ภายนอก ใช้ Node 18+ เท่านั้น
 *
 * ENV:
 *   PORT          พอร์ต (ค่าเริ่มต้น 3000)
 *   DATA_DIR      โฟลเดอร์เก็บ db.json (ค่าเริ่มต้น ../data)
 *   TRUST_PROXY   ตั้งเป็น 1 ถ้าอยู่หลัง reverse proxy เพื่ออ่าน IP จาก X-Forwarded-For
 *   ADMIN_TOKEN   ถ้าตั้งไว้ จะเปิด DELETE /api/reports/:id สำหรับผู้ดูแล (ส่ง header X-Admin-Token)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const CATS = ['noship', 'notmatch', 'fake', 'deposit', 'mule', 'phish', 'other'];
const LIMITS = { body: 16 * 1024, reports: 5000, confirms: 50000, writesPerMin: 30, readsPerMin: 240 };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; ')
};

/* ---------- helpers ---------- */
const clean = (v, max) => typeof v === 'string'
  ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max) : '';
const clientId = req => {
  const v = String(req.headers['x-client-id'] || '');
  return /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null;
};
const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/* ---------- storage: JSON file, เขียนแบบ atomic ---------- */
function createStore(file) {
  let db = { reports: [], confirms: [] };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* เริ่มใหม่ */ }
  let timer = null;
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 150); };
  return { db, save, flush };
}

/* ---------- rate limit ในหน่วยความจำ (ต่อ IP ต่อนาที) ---------- */
function createLimiter() {
  const hits = new Map();
  setInterval(() => {
    const t = Date.now() - 60000;
    for (const [k, v] of hits) { if (v.t < t) hits.delete(k); }
  }, 30000).unref();
  return (ip, kind, max) => {
    const k = ip + '|' + kind, now = Date.now();
    let e = hits.get(k);
    if (!e || now - e.t > 60000) { e = { t: now, n: 0 }; hits.set(k, e); }
    e.n++;
    return e.n <= max;
  };
}

/* ---------- validation ---------- */
function parseReport(b) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'invalid body');
  const cat = CATS.includes(b.cat) ? b.cat : null;
  const area = clean(b.area, 60), title = clean(b.title, 90), detail = clean(b.detail, 700);
  const ident = clean(b.ident, 200), author = clean(b.author, 30) || 'นักสืบ', platform = clean(b.platform, 40);
  if (!cat) throw new HttpError(400, 'invalid cat');
  if (!area) throw new HttpError(400, 'invalid area');
  if (title.length < 6) throw new HttpError(400, 'title too short');
  if (detail.length < 15) throw new HttpError(400, 'detail too short');
  if (/(?<!\d)\d{13}(?!\d)/.test(detail.replace(/[\s-]/g, ''))) throw new HttpError(400, 'looks like a national id');
  return { cat, area, title, detail, ident, author, platform };
}

function parseConfirm(b, store) {
  if (!b || typeof b !== 'object') throw new HttpError(400, 'invalid body');
  const rid = clean(b.rid, 64);
  const kind = b.kind === 'verify' || b.kind === 'tip' ? b.kind : null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(rid)) throw new HttpError(400, 'invalid rid');
  if (!kind) throw new HttpError(400, 'invalid kind');
  // rid ต้องเป็นรายงานที่มีอยู่ หรือเป็นเคสตัวอย่างฝั่งหน้าเว็บ (s01-s99)
  if (!/^s\d{2}$/.test(rid) && !store.db.reports.some(r => r.id === rid)) throw new HttpError(400, 'unknown report');
  const out = { rid, kind, author: clean(b.author, 30) || 'นักสืบ' };
  if (kind === 'tip') {
    out.text = clean(b.text, 300);
    if (out.text.length < 4) throw new HttpError(400, 'tip too short');
  }
  return out;
}

/* ---------- app ---------- */
function createServer(opts = {}) {
  const root = opts.root || path.join(__dirname, '..', 'public');
  const store = createStore(path.join(opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json'));
  const limit = createLimiter();
  const adminToken = opts.adminToken !== undefined ? opts.adminToken : process.env.ADMIN_TOKEN;
  const trustProxy = opts.trustProxy !== undefined ? opts.trustProxy : process.env.TRUST_PROXY === '1';

  const send = (res, status, body, headers = {}) => {
    const isObj = body !== null && typeof body === 'object';
    const data = status === 204 ? '' : (isObj ? JSON.stringify(body) : String(body));
    res.writeHead(status, Object.assign({}, SECURITY_HEADERS, isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}, headers));
    res.end(data);
  };

  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > LIMITS.body) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'invalid json')); }
    });
    req.on('error', reject);
  });

  async function handleApi(req, res, url, ip) {
    const method = req.method, parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (!limit(ip, isWrite ? 'w' : 'r', isWrite ? LIMITS.writesPerMin : LIMITS.readsPerMin)) throw new HttpError(429, 'too many requests');
    const uid = clientId(req);
    const { db } = store;

    if (parts[1] === 'health' && method === 'GET') return send(res, 200, { ok: true });

    if (parts[1] === 'reports' && parts.length === 2) {
      if (method === 'GET') {
        const reports = db.reports.slice().sort((a, b) => b.ts - a.ts).slice(0, 300)
          .map(({ uid: _u, ...r }) => r);
        return send(res, 200, { reports });
      }
      if (method === 'POST') {
        if (!uid) throw new HttpError(400, 'missing X-Client-Id');
        const r = Object.assign(parseReport(await readBody(req)), { id: newId('r_'), ts: Date.now(), uid });
        db.reports.push(r);
        if (db.reports.length > LIMITS.reports) db.reports.splice(0, db.reports.length - LIMITS.reports);
        store.save();
        const { uid: _u, ...pub } = r;
        return send(res, 201, pub);
      }
    }

    if (parts[1] === 'reports' && parts.length === 3 && method === 'DELETE') {
      if (!adminToken || req.headers['x-admin-token'] !== adminToken) throw new HttpError(403, 'forbidden');
      const i = db.reports.findIndex(r => r.id === parts[2]);
      if (i < 0) throw new HttpError(404, 'not found');
      db.reports.splice(i, 1);
      db.confirms = db.confirms.filter(c => c.rid !== parts[2]);
      store.save();
      return send(res, 204, null);
    }

    if (parts[1] === 'confirms' && parts.length === 2) {
      if (method === 'GET') {
        const confirms = db.confirms.map(({ uid: u, ...c }) => Object.assign(c, { mine: !!uid && u === uid }));
        return send(res, 200, { confirms });
      }
      if (method === 'POST') {            // เบาะแสเพิ่มเติม (tip)
        if (!uid) throw new HttpError(400, 'missing X-Client-Id');
        const c = parseConfirm(await readBody(req), store);
        if (c.kind !== 'tip') throw new HttpError(400, 'use PUT for verify');
        const rec = Object.assign(c, { id: newId('t_'), uid, ts: Date.now() });
        db.confirms.push(rec);
        if (db.confirms.length > LIMITS.confirms) db.confirms.splice(0, db.confirms.length - LIMITS.confirms);
        store.save();
        return send(res, 201, { id: rec.id });
      }
    }

    if (parts[1] === 'confirms' && parts.length === 3) {
      const id = decodeURIComponent(parts[2]);
      if (!uid) throw new HttpError(400, 'missing X-Client-Id');
      if (method === 'PUT') {             // ยืนยันเคส: หนึ่งคนต่อหนึ่งเคส
        const c = parseConfirm(await readBody(req), store);
        if (c.kind !== 'verify' || id !== c.rid + '__' + uid) throw new HttpError(400, 'id mismatch');
        const rec = Object.assign(c, { id, uid, ts: Date.now() });
        const i = db.confirms.findIndex(x => x.id === id);
        if (i >= 0) db.confirms[i] = rec; else db.confirms.push(rec);
        store.save();
        return send(res, 200, { id });
      }
      if (method === 'DELETE') {
        if (!id.endsWith('__' + uid)) throw new HttpError(403, 'not yours');
        const i = db.confirms.findIndex(x => x.id === id && x.kind === 'verify');
        if (i >= 0) { db.confirms.splice(i, 1); store.save(); }
        return send(res, 204, null);
      }
    }
    throw new HttpError(404, 'not found');
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes('\0')) throw new HttpError(400, 'bad path');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(403, 'forbidden');
    let st;
    try { st = fs.statSync(file); } catch (e) { throw new HttpError(404, 'not found'); }
    if (!st.isFile()) throw new HttpError(404, 'not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    }));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url, ip);
      else serveStatic(req, res, url);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'internal error' });
      else res.end();
    }
  });
  server.store = store;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  const server = createServer();
  server.listen(port, () => console.log('Catch Me If You Can: http://localhost:' + port));
  const bye = () => { server.store.flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
