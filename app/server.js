'use strict';

/*
 * API Monitor — standalone app (zero dependencies)
 *
 * Endpoints:
 *   POST /events           ingest captures from the Chrome extension
 *   GET  /                 dashboard UI
 *   GET  /events/stream    live feed (Server-Sent Events)
 *   GET  /api/ping         health check (reports version)
 *   GET  /api/snapshot     records + marks (bodies/frames omitted, newest first)
 *   GET  /api/records/:id  one full record incl. bodies + WS frames
 *   GET  /api/search?q=    full-text search (bodies, urls, errors)
 *   POST /api/replay       re-issue a captured request; returns fresh response
 *   GET  /api/export       download all records as JSON
 *   GET  /api/export/har   download captures as HAR 1.2 (DevTools-compatible)
 *   GET  /api/export/curl  download a .sh with one cURL per capture
 *   POST /api/mark         add a labelled timestamp mark (session annotation)
 *   DELETE /api/marks/:id  remove a mark
 *   POST /api/marks/clear  remove all marks
 *   POST /api/purge        delete records by host and/or urlContains
 *   POST /api/clear        wipe stored records + marks
 *
 * Binds to 127.0.0.1 only (not exposed to your network).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8899;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requests.jsonl');
const PERSIST = process.env.PERSIST !== '0';

const MAX_RECORDS = Number(process.env.MAX_RECORDS) || 5000; // in-memory ring buffer
const MAX_BODY_FIELD = 256 * 1024;  // per captured body
const MAX_UPLOAD = 32 * 1024 * 1024;
const ROTATE_BYTES = 25 * 1024 * 1024;

const records = []; // oldest -> newest; endpoints output newest first
let seqN = 0;
const clients = new Set();

const APP_VERSION = '1.5.0';

/* session marks — timestamped annotations dropped between requests (memory only) */
let markSeq = 0;
const marks = []; // { id, ts, label } chronological

/* ---------------- persistence (JSONL ring file) ---------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

(function hydrate() {
  if (!PERSIST) return;
  let raw = '';
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (e) {
    return;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id) records.push(rec);
    } catch (e) { /* skip corrupted line */ }
  }
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  seqN = records.reduce((m, r) => Math.max(m, r.n || 0), 0);
  console.log(`[store] loaded ${records.length} persisted record(s) from ${DATA_FILE}`);
})();

function persist(rec) {
  if (!PERSIST) return;
  try {
    let size = 0;
    try { size = fs.statSync(DATA_FILE).size; } catch (e) { size = 0; }
    if (size > ROTATE_BYTES) {
      try { fs.renameSync(DATA_FILE, DATA_FILE + '.1'); } catch (e) { /* ignore */ }
    }
    fs.appendFileSync(DATA_FILE, JSON.stringify(rec) + '\n');
  } catch (e) { /* persistence is best-effort */ }
}

function rewriteStore() {
  if (!PERSIST) return;
  try {
    fs.writeFileSync(DATA_FILE, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  } catch (e) { /* best-effort */ }
}

/* ---------------- ingest ---------------- */

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

function capStr(v) {
  if (v == null || typeof v !== 'string') return [null, false];
  return v.length > MAX_BODY_FIELD ? [v.slice(0, MAX_BODY_FIELD), true] : [v, false];
}

function capHeaders(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return {};
  const out = {};
  let i = 0;
  for (const k of Object.keys(h)) {
    if (i++ >= 60) break;
    out[String(k).slice(0, 200)] = String(h[k]).slice(0, 4096);
  }
  return out;
}

function build(e) {
  if (!e || typeof e !== 'object' || !e.url) return null;
  const [reqBody, reqBodyTrunc] = capStr(e.reqBody);
  const [resBody, resBodyTrunc] = capStr(e.resBody);
  let wsFrames = null;
  if (Array.isArray(e.wsFrames) && e.wsFrames.length) {
    wsFrames = e.wsFrames.slice(0, 80).map(f => ({
      d: f && f.d === 'out' ? 'out' : 'in',
      t: Number(f.t) || 0,
      len: Number(f && f.len) || 0,
      data: f && typeof f.data === 'string' ? f.data.slice(0, 16384) : null,
    }));
  }
  const ts = Number.isFinite(Number(e.ts)) ? Number(e.ts) : Date.now();
  return {
    n: ++seqN,
    id: 'r' + seqN,
    ts,
    receivedAt: Date.now(),
    tabId: Number(e.tabId) || 0,
    method: String(e.method || 'GET').toUpperCase().slice(0, 12),
    url: String(e.url).slice(0, 8192),
    type: e.type ? String(e.type).slice(0, 40) : null,
    status: e.status == null ? null : (Number(e.status) || 0),
    statusText: e.statusText ? String(e.statusText).slice(0, 200) : '',
    mimeType: e.mimeType ? String(e.mimeType).slice(0, 200) : null,
    durationMs: num(e.durationMs),
    ttfbMs: num(e.ttfbMs),
    size: num(e.size),
    reqHeaders: capHeaders(e.reqHeaders),
    resHeaders: capHeaders(e.resHeaders),
    reqBody,
    resBody,
    reqBodyTruncated: !!e.reqBodyTruncated || reqBodyTrunc,
    resBodyTruncated: !!e.resBodyTruncated || resBodyTrunc,
    resBodyEncoding: e.resBodyEncoding === 'base64' ? 'base64' : 'text',
    wsFrames,
    wsFramesCount: e.wsFramesCount != null ? (Number(e.wsFramesCount) || 0) : (wsFrames ? wsFrames.length : null),
    wsFramesTruncated: !!e.wsFramesTruncated,
    error: e.error ? String(e.error).slice(0, 300) : null,
    redirect: !!e.redirect,
    fromCache: !!e.fromCache,
    initiator: e.initiator && typeof e.initiator === 'object' ? {
      type: String(e.initiator.type || 'other').slice(0, 40),
      url: e.initiator.url ? String(e.initiator.url).slice(0, 2048) : null,
    } : null,
  };
}

function condense(r) {
  const { reqBody, resBody, wsFrames, ...rest } = r;
  return rest;
}

function ingest(events) {
  if (!Array.isArray(events)) return 0;
  let added = 0;
  for (const e of events.slice(0, 500)) {
    const rec = build(e);
    if (!rec) continue;
    records.push(rec);
    added++;
    persist(rec);
    broadcast({ t: 'request', record: condense(rec) });
  }
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return added;
}

/* ---------------- exporters ---------------- */

function headersToList(h) {
  return Object.keys(h || {}).map(k => ({ name: k, value: String(h[k]) }));
}

function toHAR() {
  const entries = records.map(r => {
    let qs = [];
    try {
      qs = [...new URL(r.url).searchParams.entries()].map(([name, value]) => ({ name, value }));
    } catch (e) { /* no query string */ }
    const ttfb = Math.max(0, r.ttfbMs != null ? r.ttfbMs : 0);
    const total = Math.max(0, r.durationMs != null ? r.durationMs : 0);
    const entry = {
      _apiMonitor: { id: r.id, type: r.type, tabId: r.tabId, initiator: r.initiator, error: r.error, fromCache: r.fromCache },
      startedDateTime: new Date(r.ts || Date.now()).toISOString(),
      time: total,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: 'http/1.1',
        headers: headersToList(r.reqHeaders),
        queryString: qs,
        cookies: [],
        headersSize: -1,
        bodySize: r.reqBody != null ? r.reqBody.length : 0,
      },
      response: {
        status: r.status || 0,
        statusText: r.statusText || (r.error ? 'error: ' + r.error : ''),
        httpVersion: 'http/1.1',
        headers: headersToList(r.resHeaders),
        cookies: [],
        content: {
          size: r.size != null ? r.size : (r.resBody != null ? r.resBody.length : 0),
          mimeType: r.mimeType || 'text/plain',
          text: r.resBody != null ? r.resBody : undefined,
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: r.resBody != null ? r.resBody.length : -1,
      },
      cache: {},
      timings: {
        send: 0,
        wait: ttfb,
        receive: Math.max(0, total - ttfb),
        comment: 'API Monitor: derived from TTFB / total duration',
      },
      _resourceType: r.type || r.method,
    };
    if (r.reqBody != null) {
      entry.request.postData = {
        mimeType: r.reqHeaders['content-type'] || r.reqHeaders['Content-Type'] || 'text/plain',
        text: r.reqBody,
      };
    }
    if (r.resBodyEncoding === 'base64' && r.resBody != null && r.resBody.length) {
      entry.response.content.encoding = 'base64';
    }
    return entry;
  });
  return {
    log: {
      version: '1.2',
      creator: { name: 'API Monitor', version: APP_VERSION },
      pages: [],
      entries,
    },
  };
}

function shQuoteServer(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function serverCurl(r) {
  const parts = ['curl'];
  if (r.method && r.method !== 'GET') parts.push('-X ' + r.method);
  parts.push(shQuoteServer(r.url));
  const hdrs = r.reqHeaders || {};
  let hadEncoding = false;
  for (const k of Object.keys(hdrs)) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'connection') continue;
    if (lk === 'accept-encoding') { hadEncoding = true; continue; }
    parts.push('-H ' + shQuoteServer(k + ': ' + hdrs[k]));
  }
  if (hadEncoding) parts.push('--compressed');
  if (r.reqBody != null && r.reqBody.length) parts.push('--data-raw ' + shQuoteServer(r.reqBody));
  return parts.join(' ');
}

function toCurlScript() {
  const lines = [
    '#!/usr/bin/env bash',
    '# API Monitor cURL collection — ' + records.length + ' command(s), generated ' + new Date().toISOString(),
    '# WARNING: re-running these issues real HTTP(S) requests to the captured targets.',
    '',
  ];
  for (const r of records.slice().reverse()) { // newest first
    const st = r.status == null ? '' : r.status;
    const err = r.error ? ' (ERROR: ' + r.error + ')' : '';
    lines.push('# ' + st + ' ' + r.method + ' ' + r.url + err);
    lines.push(serverCurl(r));
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------- SSE ---------------- */

function broadcast(obj) {
  if (clients.size === 0) return;
  const frame = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const c of clients) {
    try { c.res.write(frame); } catch (e) {
      clearInterval(c.hb);
      clients.delete(c);
    }
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
  });
  res.write('retry: 2000\n\n');

  const client = { res, hb: null };
  client.hb = setInterval(() => {
    try { res.write(':hb\n\n'); } catch (e) { end(); }
  }, 15000);

  const end = () => {
    clearInterval(client.hb);
    clients.delete(client);
    try { res.end(); } catch (e) { /* ignore */ }
  };
  req.on('close', end);

  try {
    res.write('data: ' + JSON.stringify({ t: 'hello', version: APP_VERSION, records: records.length }) + '\n\n');
  } catch (e) { /* ignore */ }
  clients.add(client);
}

/* ---------------- static UI ---------------- */

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

function serveStatic(urlPath, res) {
  const entry = STATIC_FILES[urlPath];
  if (!entry) return false;
  const [file, type] = entry;
  try {
    const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('missing UI file: ' + file);
  }
  return true;
}

/* ---------------- helpers ---------------- */

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > cap) {
        reject(Object.assign(new Error('payload too large'), { code: 'ETooLarge' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------- request replay ---------------- */

const MAX_REPLAY_BODY = 512 * 1024;

function replayRecord(rec) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(rec.url); } catch (e) {
      resolve({ ok: false, error: 'invalid URL: ' + rec.url });
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      resolve({ ok: false, error: 'unsupported protocol: ' + u.protocol });
      return;
    }
    const headers = {};
    for (const k of Object.keys(rec.reqHeaders || {})) {
      const lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'connection' || lk === 'host') continue;
      headers[k] = String(rec.reqHeaders[k]);
    }
    if (!headers.accept) headers.accept = '*/*';
    if (!headers['user-agent']) headers['user-agent'] = 'API-Monitor/' + APP_VERSION + ' (replay)';

    let payload = null;
    if (rec.reqBody != null && rec.reqBody.length && rec.method !== 'GET' && rec.method !== 'HEAD') {
      payload = Buffer.from(rec.reqBody, 'utf8');
    }

    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: rec.method || 'GET',
      headers,
      rejectUnauthorized: false, // dev APIs often use self-signed certs
      timeout: 15000,
    };
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let settled = false;
    const finish = r => { if (!settled) { settled = true; resolve(r); } };

    const out = lib.request(opts, resIn => {
      const mime = resIn.headers['content-type'] || '';
      const chunks = [];
      let size = 0, truncated = false;
      resIn.on('data', c => {
        size += c.length;
        if (size > MAX_REPLAY_BODY) { truncated = true; return; }
        chunks.push(c);
      });
      resIn.on('end', () => {
        const respHeaders = {};
        let i = 0;
        for (const [k, v] of Object.entries(resIn.headers)) {
          if (i++ >= 60) break;
          respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v).slice(0, 4096);
        }
        finish({
          ok: true,
          status: resIn.statusCode || 0,
          statusText: resIn.statusMessage || '',
          durationMs: Date.now() - t0,
          size,
          mimeType: mime,
          headers: respHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
          bodyTruncated: truncated,
          binary: /^(image\/|font\/|audio\/|video\/)|octet-stream/i.test(mime),
        });
      });
      resIn.on('error', err => finish({ ok: false, error: String((err && err.message) || err) }));
    });
    out.on('timeout', () => out.destroy(new Error('connection timed out')));
    out.on('error', err => finish({ ok: false, error: String((err && err.message) || err), durationMs: Date.now() - t0 }));
    if (payload) out.write(payload);
    out.end();
  });
}

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  };
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = u.pathname;

    if (req.method === 'POST' && p === '/events') {
      let raw;
      try {
        raw = await readBody(req, MAX_UPLOAD);
        const data = JSON.parse(raw.toString('utf8') || '{}');
        const events = Array.isArray(data) ? data : data.events;
        const received = ingest(events);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, received }));
      } catch (e) {
        res.writeHead(e && e.code === 'ETooLarge' ? 413 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
      return;
    }

    if (req.method === 'GET' && p === '/events/stream') {
      handleSSE(req, res);
      return;
    }

    if (req.method === 'GET' && p === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        version: APP_VERSION,
        records: records.length,
        uptimeSec: Math.round(process.uptime()),
      }));
      return;
    }

    if (req.method === 'GET' && p === '/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        version: APP_VERSION,
        marks: marks.slice(),
        records: records.slice().reverse().map(condense),
      }));
      return;
    }

    if (req.method === 'GET' && p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      const limit = Math.min(Number(u.searchParams.get('limit')) || 40, 100);
      const results = [];
      if (q.length >= 2) {
        const needle = q.toLowerCase();
        for (let i = records.length - 1; i >= 0 && results.length < limit; i--) {
          const r = records[i];
          let snippet = null, field = null;
          const scan = (text, name) => {
            if (snippet != null || text == null) return;
            const idx = String(text).toLowerCase().indexOf(needle);
            if (idx >= 0) {
              field = name;
              const from = Math.max(0, idx - 60);
              snippet = String(text).slice(from, idx + needle.length + 60).replace(/\s+/g, ' ').trim();
            }
          };
          scan(r.reqBody, 'request body');
          scan(r.resBody, 'response body');
          scan(r.url, 'url');
          scan(r.error, 'error');
          if (snippet == null) continue;
          results.push(Object.assign(condense(r), { snippet, snippetField: field }));
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        query: q,
        scanned: records.length,
        results,
      }));
      return;
    }

    const m = req.method === 'GET' ? p.match(/^\/api\/records\/(.+)$/) : null;
    if (m) {
      const rec = records.find(r => r.id === m[1] || String(r.n) === m[1]);
      if (!rec) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rec));
      return;
    }

    if (req.method === 'POST' && p === '/api/replay') {
      let id = null;
      try {
        const data = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
        id = data && data.id ? String(data.id) : null;
      } catch (e) { /* no id */ }
      const rec = id ? records.find(r => r.id === id || String(r.n) === id) : null;
      if (!rec) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'record not found (clear/restart wipes it)' }));
        return;
      }
      const result = await replayRecord(rec);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && p === '/api/export/har') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="api-monitor-${stamp}.har"`,
      });
      res.end(JSON.stringify(toHAR(), null, 2));
      return;
    }

    if (req.method === 'GET' && p === '/api/export/curl') {
      res.writeHead(200, {
        'content-type': 'text/x-shellscript; charset=utf-8',
        'content-disposition': `attachment; filename="api-monitor-${Date.now()}-curls.sh"`,
      });
      res.end(toCurlScript());
      return;
    }

    if (req.method === 'GET' && p === '/api/export') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="api-monitor-${stamp}.json"`,
      });
      res.end(JSON.stringify(
        { exportedAt: new Date().toISOString(), count: records.length, records: records.slice().reverse() },
        null,
        2
      ));
      return;
    }

    if (req.method === 'POST' && p === '/api/purge') {
      try {
        const data = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
        const host = data && data.host ? String(data.host).slice(0, 300) : null;
        const urlContains = data && data.urlContains ? String(data.urlContains).slice(0, 1024) : null;
        if (!host && !urlContains) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'provide "host" and/or "urlContains"' }));
          return;
        }
        const hit = r => {
          let h = '';
          try { h = new URL(r.url).host; } catch (e) { /* keep '' */ }
          return (host && h === host) || (urlContains && r.url.includes(urlContains));
        };
        let removed = 0;
        for (let i = records.length - 1; i >= 0; i--) {
          if (hit(records[i])) { records.splice(i, 1); removed++; }
        }
        rewriteStore();
        broadcast({ t: 'purge', host, urlContains });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, removed, remaining: records.length }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
      return;
    }

    if (req.method === 'POST' && p === '/api/mark') {
      let label = '';
      try { const data = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); label = (data && data.label) || ''; } catch (e) { /* empty label ok */ }
      const mark = {
        id: 'mk' + (++markSeq) + '-' + Date.now().toString(36),
        ts: Date.now(),
        label: String(label || 'Mark').slice(0, 80),
      };
      marks.push(mark);
      if (marks.length > 200) marks.splice(0, marks.length - 200);
      broadcast({ t: 'mark', mark, total: marks.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mark }));
      return;
    }

    const dm = req.method === 'DELETE' ? p.match(/^\/api\/marks\/(.+)$/) : null;
    if (dm) {
      const idx = marks.findIndex(m => m.id === dm[1]);
      if (idx < 0) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      marks.splice(idx, 1);
      broadcast({ t: 'deleteMark', id: dm[1] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && p === '/api/marks/clear') {
      marks.length = 0;
      broadcast({ t: 'marksCleared' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && p === '/api/clear') {
      records.length = 0;
      marks.length = 0;
      if (PERSIST) {
        try { fs.writeFileSync(DATA_FILE, ''); } catch (e) { /* ignore */ }
      }
      broadcast({ t: 'clear' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && serveStatic(p, res)) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    try {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error: ' + ((e && e.message) || e));
    } catch (e2) { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  API Monitor — standalone app');
  console.log('  ─────────────────────────────────────────');
  console.log(`  Dashboard : http://${HOST}:${PORT}`);
  console.log(`  Ingest    : POST http://${HOST}:${PORT}/events  (extension endpoint)`);
  console.log('  Stop      : Ctrl+C');
  console.log('');
});

server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Close the other app or run: set PORT=8898 && node server.js (then update SERVER in the extension's background.js).`);
    process.exit(1);
  }
  console.error(e);
});
