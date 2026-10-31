/*
 * API Monitor Bridge — background service worker (Manifest V3)
 *
 * Attaches chrome.debugger to tabs you toggle (via the popup), listens to
 * Chrome DevTools Protocol "Network" events, and POSTs finished request
 * records to the local standalone app (default http://127.0.0.1:8899/events).
 */

const SERVER = 'http://127.0.0.1:8899'; // must match the standalone app port
const ATTACH_VERSION = '1.3';
const MAX_BODY = 200 * 1024;   // max chars kept per request/response body
const MAX_OUTBOX = 2000;       // records buffered while the app is unreachable
const FLUSH_INTERVAL_MS = 1500;

/** tabIds currently being captured (persisted in session storage) */
const capturing = new Set();
/** CDP requestId -> draft record being built */
const drafts = new Map();
/** finished records waiting to be delivered to the app */
const outbox = [];

let serverOnline = null; // null = unknown, true/false after a flush attempt
let flushing = false;

const session = chrome.storage.session;

/* ---------------- lifecycle ---------------- */

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('sweep', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('sweep', { periodInMinutes: 1 }));

// Re-attach after service-worker suspension + retry delivery while offline.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'sweep') return;
  for (const tabId of [...capturing]) ensureAttached(tabId);
  flush();
});

/* ---------------- attach / detach ---------------- */

async function ensureAttached(tabId) {
  if (!capturing.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, ATTACH_VERSION);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/attached/i.test(msg)) throw e;
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: MAX_BODY });
  } catch (e) { /* may already be enabled */ }
}

async function attach(tabId) {
  await chrome.debugger.attach({ tabId }, ATTACH_VERSION);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', { maxPostDataSize: MAX_BODY });
  } catch (e) { /* may already be enabled */ }
  capturing.add(tabId);
  await session.set({ capturing: [...capturing] });
  setBadge();
}

async function detach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (e) { /* already detached */ }
  cleanupTab(tabId);
}

function cleanupTab(tabId) {
  capturing.delete(tabId);
  for (const [rid, d] of drafts) if (d.tabId === tabId) drafts.delete(rid);
  session.set({ capturing: [...capturing] }).catch(() => {});
  setBadge();
}

chrome.debugger.onDetach.addListener(source => {
  const tabId = source && source.tabId;
  if (tabId != null) cleanupTab(tabId);
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (capturing.has(tabId)) cleanupTab(tabId);
});

async function toggleTab(tabId) {
  if (capturing.has(tabId)) {
    await detach(tabId);
    return { capturing: false };
  }
  try {
    await attach(tabId);
    pingServer().catch(() => {});
    return { capturing: true };
  } catch (e) {
    const m = String((e && e.message) || e);
    return {
      capturing: false,
      error: /cannot attach/i.test(m)
        ? 'Cannot attach to this page — try a normal http(s) page. (' + m + ')'
        : m,
    };
  }
}

/* ---------------- CDP events ---------------- */

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (tabId == null || !capturing.has(tabId)) return;
  switch (method) {
    case 'Network.requestWillBeSent': onRequest(tabId, params); break;
    case 'Network.responseReceived':  onResponse(tabId, params); break;
    case 'Network.loadingFinished':   void onFinished(tabId, params); break;
    case 'Network.loadingFailed':     onFailed(tabId, params); break;
    case 'Network.webSocketCreated':  onWsCreated(tabId, params); break;
    case 'Network.webSocketOpened':   onWsOpened(tabId, params); break;
    case 'Network.webSocketClosed':   onWsClosed(tabId, params); break;
    case 'Network.webSocketFrameReceived': onWsFrame(tabId, params, 'in'); break;
    case 'Network.webSocketFrameSent':     onWsFrame(tabId, params, 'out'); break;
    case 'Network.webSocketFrameError':    onWsFrame(tabId, params, 'err'); break;
  }
});

const secToMs = s => Math.max(0, Math.round((s || 0) * 1000));

function clip(s, cap = MAX_BODY) {
  if (s == null) return [null, false];
  const str = typeof s === 'string' ? s : String(s);
  return str.length > cap ? [str.slice(0, cap), true] : [str, false];
}

function sanitizeHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  let n = 0;
  for (const k of Object.keys(h)) {
    if (n++ >= 60) break;
    out[String(k).slice(0, 128)] = String(h[k]).slice(0, 4096);
  }
  return out;
}

function summarizeInitiator(i) {
  if (!i || typeof i !== 'object') return null;
  const url = i.url || (i.stack && i.stack.callFrames && i.stack.callFrames[0] && i.stack.callFrames[0].url) || '';
  return { type: i.type || 'other', url: url || null };
}

function onRequest(tabId, p) {
  const prior = drafts.get(p.requestId);
  // A redirect finalizes the previous leg with its redirect response.
  if (prior && p.redirectResponse) {
    const rr = p.redirectResponse;
    enqueue(buildRecord(prior, {
      status: rr.status,
      statusText: rr.statusText || '',
      resHeaders: sanitizeHeaders(rr.headers),
      mimeType: rr.mimeType || '',
      ttfbMs: secToMs(p.timestamp - prior.start),
      durationMs: secToMs(p.timestamp - prior.start),
      size: rr.encodedDataLength > 0 ? rr.encodedDataLength : 0,
      redirect: true,
    }));
  }
  const req = p.request || {};
  const [reqBody, reqBodyTruncated] = clip(req.postData);
  drafts.set(p.requestId, {
    tabId,
    ts: Math.round((p.wallTime || Date.now() / 1000) * 1000),
    url: req.url || '',
    method: req.method || 'GET',
    reqHeaders: sanitizeHeaders(req.headers),
    reqBody,
    reqBodyTruncated,
    type: p.type || 'Other',
    start: p.timestamp,
    initiator: summarizeInitiator(p.initiator),
  });
}

function onResponse(tabId, p) {
  const d = drafts.get(p.requestId);
  if (!d) return;
  const r = p.response || {};
  d.status = r.status != null ? r.status : null;
  d.statusText = r.statusText || '';
  d.resHeaders = sanitizeHeaders(r.headers);
  d.mimeType = r.mimeType || '';
  if (r.requestHeaders) d.reqHeaders = sanitizeHeaders(r.requestHeaders);
  d.ttfbMs = secToMs(p.timestamp - d.start);
  d.fromCache = Boolean(r.fromDiskCache);
}

async function onFinished(tabId, p) {
  const d = drafts.get(p.requestId);
  if (!d) return;
  drafts.delete(p.requestId);
  const extra = {
    durationMs: secToMs(p.timestamp - d.start),
    size: p.encodedDataLength > 0 ? p.encodedDataLength : 0,
  };
  try {
    const body = await chrome.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId: p.requestId }
    );
    if (body && typeof body.body === 'string') {
      const [b, t] = clip(body.body);
      extra.resBody = b;
      extra.resBodyTruncated = t;
      extra.resBodyEncoding = body.base64Encoded ? 'base64' : 'text';
    }
  } catch (e) { /* streaming/binary/evicted bodies can't be read */ }
  enqueue(buildRecord(d, extra));
}

function onFailed(tabId, p) {
  const d = drafts.get(p.requestId);
  if (!d) return;
  drafts.delete(p.requestId);
  enqueue(buildRecord(d, {
    status: 0,
    statusText: '',
    error: p.errorText || 'network error',
  }));
}

/* ---------------- websockets ---------------- */

const WS_MAX_FRAMES = 80;
const WS_FRAME_CAP = 16 * 1024;

function onWsCreated(tabId, p) {
  drafts.set(p.requestId, {
    tabId,
    ts: Date.now(),
    url: p.url || '',
    method: 'WS',
    type: 'websocket',
    reqHeaders: {},
    resHeaders: {},
    status: null,
    statusText: 'connecting',
    wsFrames: [],
    wsFramesTruncated: false,
    start: null,
    initiator: summarizeInitiator(p.initiator),
  });
}

function onWsOpened(tabId, p) {
  const d = drafts.get(p.requestId);
  if (d) {
    d.status = 101;
    d.statusText = 'Switching Protocols';
  }
}

function onWsFrame(tabId, p, dir) {
  const d = drafts.get(p.requestId);
  if (!d || !d.wsFrames) return;
  if (d.wsFrames.length >= WS_MAX_FRAMES) {
    d.wsFramesTruncated = true;
    return;
  }
  const resp = p.response || {};
  if (dir === 'err') {
    d.error = resp.errorMessage || d.error || 'frame error';
    return;
  }
  const payload = typeof resp.payloadData === 'string' ? resp.payloadData : '';
  d.wsFrames.push({ d: dir, t: Date.now(), len: payload.length, data: payload.slice(0, WS_FRAME_CAP) });
}

function onWsClosed(tabId, p) {
  const d = drafts.get(p.requestId);
  if (!d) return;
  drafts.delete(p.requestId);
  const frames = d.wsFrames || [];
  enqueue(buildRecord(d, {
    status: d.status != null ? d.status : 0,
    statusText: d.statusText || '',
    size: frames.reduce((s, f) => s + (f.len || 0), 0),
    error: d.error || (d.status == null ? 'closed before handshake' : null),
    wsFrames: frames,
    wsFramesCount: frames.length,
    wsFramesTruncated: !!d.wsFramesTruncated,
  }));
}

function buildRecord(d, extra) {
  return {
    tabId: d.tabId,
    ts: d.ts,
    url: d.url,
    method: d.method,
    type: d.type,
    reqHeaders: d.reqHeaders,
    resHeaders: d.resHeaders || {},
    reqBody: d.reqBody != null ? d.reqBody : null,
    reqBodyTruncated: !!d.reqBodyTruncated,
    status: null,
    statusText: '',
    mimeType: null,
    size: 0,
    durationMs: 0,
    ttfbMs: d.ttfbMs != null ? d.ttfbMs : 0,
    error: null,
    redirect: false,
    fromCache: !!d.fromCache,
    initiator: d.initiator || null,
    resBody: null,
    resBodyTruncated: false,
    resBodyEncoding: 'text',
    ...extra,
  };
}

/* ---------------- delivery ---------------- */

function enqueue(rec) {
  outbox.push(rec);
  if (outbox.length > MAX_OUTBOX) outbox.splice(0, outbox.length - MAX_OUTBOX);
  flush();
}

async function flush() {
  if (flushing || outbox.length === 0) return;
  flushing = true;
  const batch = outbox.splice(0, outbox.length);
  try {
    const res = await fetch(SERVER + '/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (serverOnline !== true) {
      serverOnline = true;
      setBadge();
    }
  } catch (e) {
    serverOnline = false;
    outbox.unshift(...batch); // keep in order, retry later
    if (outbox.length > MAX_OUTBOX) outbox.length = MAX_OUTBOX;
    setBadge();
  } finally {
    flushing = false;
  }
}

setInterval(flush, FLUSH_INTERVAL_MS);

async function pingServer() {
  try {
    const r = await fetch(SERVER + '/api/ping');
    serverOnline = r.ok;
  } catch (e) {
    serverOnline = false;
  }
  setBadge();
  return serverOnline;
}

function setBadge() {
  if (capturing.size === 0) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (serverOnline === false) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  } else {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  }
}

/* keep the service worker alive while capturing (API activity resets the idle timer) */
setInterval(() => {
  if (capturing.size > 0) chrome.runtime.getPlatformInfo(() => {});
}, 20000);

/* restore capture state after a wake-up */
(function restore() {
  session.get(['capturing']).then(({ capturing: tabs }) => {
    for (const t of tabs || []) capturing.add(t);
    for (const t of [...capturing]) {
      chrome.debugger.attach({ tabId: t }, ATTACH_VERSION)
        .then(() => chrome.debugger.sendCommand({ tabId: t }, 'Network.enable', { maxPostDataSize: MAX_BODY }))
        .catch(() => {});
    }
    setBadge();
  }).catch(() => {});
})();

/* ---------------- popup messages ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.cmd !== 'string') return;
  if (msg.cmd === 'toggle') {
    toggleTab(msg.tabId).then(sendResponse, e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.cmd === 'status') {
    pingServer().then(online =>
      sendResponse({
        capturing: capturing.has(msg.tabId),
        online,
        dashboard: SERVER,
        outbox: outbox.length,
      })
    );
    return true;
  }
});
