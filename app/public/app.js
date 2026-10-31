/* API Monitor dashboard (vanilla JS, no dependencies) */
(async function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const listEl = $('#list');
  const noteEl = $('#list-note');
  const detailEl = $('#detail');

  const MAX_KEEP = 5000;   // records kept client-side
  const MAX_ROWS = 350;    // rows rendered in the list

  const all = [];          // condensed records, newest first
  const filtered = [];     // subset of `all` matching current filters
  const bodyCache = new Map(); // id -> full record incl. bodies
  const marks = [];        // session marks, chronological (oldest -> newest)
  const pausedQueue = [];  // records that arrived while the view was paused (newest first)
  let paused = false;
  const replayCache = new Map(); // id -> replay result
  let replayBusyId = null;

  /* server-backed "search in bodies" mode */
  let bodySearch = false;
  let searchToken = 0;
  const searchCache = new Map();
  let cursorIdx = -1;

  let selectedId = null;
  let detailTab = 'overview';
  let reconnectTimer = null;

  const filters = { q: '', method: '', status: '', host: '', minMs: 0, restOnly: false, endpoint: '' };

  /* ---------------- utils ---------------- */

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function hostOf(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }
  function pathOf(url) {
    try {
      const u = new URL(url);
      return (u.pathname + u.search).slice(0, 240);
    } catch (e) { return url; }
  }
  function normPath(url) {
    let pathname;
    try { pathname = new URL(url).pathname; } catch (e) { return url; }
    return pathname.split('/').map(seg => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';                       // numeric
      if (/^[0-9a-f]{8,}$/i.test(seg)) return ':hex';            // hex ids/hashes
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg)) return ':token';
      return seg;
    }).join('/');
  }

  /* endpoint key: "METHOD host/normalized/path" — path params collapse to :id etc. */
  function epKeyOf(r) {
    if (!r.__ep) r.__ep = r.method + ' ' + hostOf(r.url) + normPath(r.url);
    return r.__ep;
  }

  const NON_REST_TYPES = /^(document|script|stylesheet|image|font|media|prefetch|preload|manifest|signedexchange|webbundle|websocket)$/;
  function isRestApi(r) {
    const t = (r.type || '').toLowerCase();
    if (NON_REST_TYPES.test(t)) return false;
    const mime = (r.mimeType || '').toLowerCase();
    if (/javascript|text\/css|^image\/|^font\/|^audio\/|^video\/|text\/html/.test(mime)) return false;
    if (/json|xml|graphql|octet-stream/.test(mime)) return true;
    if (t === 'fetch' || t === 'xmlhttprequest' || t === 'other' || t === 'beacon' || t === 'ping' || t === 'eventsource' || t === '') return true;
    return false;
  }

  function shQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  /* single-line command; works in bash, zsh and PowerShell */
  function buildCurl(r) {
    const parts = ['curl'];
    if (r.method && r.method !== 'GET') parts.push('-X ' + r.method);
    parts.push(shQuote(r.url));
    const hdrs = r.reqHeaders || {};
    let hadEncoding = false;
    for (const k of Object.keys(hdrs)) {
      const lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'connection') continue;
      if (lk === 'accept-encoding') { hadEncoding = true; continue; }
      parts.push('-H ' + shQuote(k + ': ' + hdrs[k]));
    }
    if (hadEncoding) parts.push('--compressed');
    if (r.reqBody != null && r.reqBody.length) {
      parts.push('--data-raw ' + shQuote(r.reqBody));
    }
    return parts.join(' ');
  }

  function fmtMs(v) {
    if (v == null || !Number.isFinite(v)) return '\u2014';
    if (v < 1) return '<1ms';
    if (v < 1000) return Math.round(v) + 'ms';
    return (v / 1000).toFixed(2) + 's';
  }
  function fmtBytes(v) {
    if (v == null || !Number.isFinite(v) || v <= 0) return '\u2014';
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(ts) {
    try { return new Date(ts).toLocaleTimeString(); } catch (e) { return ''; }
  }

  const methodClass = m => {
    const c = { GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch', DELETE: 'del', HEAD: 'head', OPTIONS: 'opt' };
    return 'm ' + (c[m] || 'other');
  };
  const statusClass = r => {
    if (r.error && !r.status) return 'st sf';
    const s = Number(r.status) || 0;
    if (s >= 200 && s < 300) return 'st s2';
    if (s >= 300 && s < 400) return 'st s3';
    if (s >= 400 && s < 500) return 'st s4';
    if (s >= 500) return 'st s5';
    return 'st s0';
  };
  const isError = r => (r.error && !r.status) || (Number(r.status) || 0) >= 400;

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  /* ---------------- list ---------------- */

  function matches(r, skip) {
    skip = skip || [];
    if (skip.indexOf('endpoint') < 0 && filters.endpoint && epKeyOf(r) !== filters.endpoint) return false;
    if (filters.restOnly && !isRestApi(r)) return false;
    if (filters.host && hostOf(r.url) !== filters.host) return false;
    if (filters.method && r.method !== filters.method) return false;
    if (filters.status) {
      const b = (r.error && !r.status) ? 'failed' : (Math.floor((Number(r.status) || 0) / 100) + 'xx');
      if (b !== filters.status) return false;
    }
    if (filters.minMs && !(r.durationMs != null && r.durationMs >= filters.minMs)) return false;
    if (filters.q) {
      const hay = (r.url + ' ' + r.method + ' ' + (r.status == null ? '' : r.status) + ' ' +
        (r.mimeType || '') + ' ' + (r.error || '')).toLowerCase();
      if (!hay.includes(filters.q.toLowerCase())) return false;
    }
    return true;
  }

  function rowNode(r) {
    const el = document.createElement('div');
    el.className = 'lrow' + (r.id === selectedId ? ' sel' : '');
    el.dataset.id = r.id;
    const st = (r.error && !r.status) ? 'ERR' : (r.status == null ? '\u2014' : r.status);
    const metaParts = [fmtMs(r.durationMs), fmtBytes(r.size)];
    if (r.type) metaParts.push(r.type);
    if (r.redirect) metaParts.push('redirect');
    if (r.fromCache) metaParts.push('cache');
    const rowTitle = r.url + (r.snippet ? '\n[' + r.snippetField + '] \u2026' + r.snippet + '\u2026' : '');
    el.innerHTML =
      '<span class="' + statusClass(r) + '">' + esc(st) + '</span>' +
      '<span class="' + methodClass(r.method) + '">' + esc(r.method) + '</span>' +
      '<span class="path" title="' + esc(rowTitle) + '">' + esc(hostOf(r.url) + pathOf(r.url)) + '</span>' +
      '<span class="meta">' + esc(metaParts.join(' \u00B7 ')) +
      '<span class="curl-mini" title="Copy as cURL">curl</span></span>';
    return el;
  }

  function markRowNode(m) {
    const el = document.createElement('div');
    el.className = 'markrow';
    el.dataset.mid = m.id;
    el.innerHTML =
      '<span class="mflag">\u2691</span>' +
      '<span class="mlabel">' + esc(m.label) + '</span>' +
      '<span class="mtime">' + esc(fmtTime(m.ts)) + '</span>' +
      '<button class="mrm" title="Remove mark">\u2715</button>';
    return el;
  }

  function renderList() {
    const frag = document.createDocumentFragment();
    const shown = filtered.slice(0, MAX_ROWS);
    // interleave marks (chronological) between records (records are newest-first)
    let mi = marks.length - 1; // walk marks newest -> oldest
    for (const r of shown) {
      while (mi >= 0 && marks[mi].ts > (r.ts || 0)) {
        frag.insertBefore(markRowNode(marks[mi]), frag.firstChild);
        mi--;
      }
      frag.appendChild(rowNode(r));
    }
    while (mi >= 0) {
      frag.appendChild(markRowNode(marks[mi]));
      mi--;
    }
    listEl.replaceChildren(frag);
    if (filtered.length > MAX_ROWS) {
      noteEl.textContent = 'Showing ' + MAX_ROWS + ' newest of ' + filtered.length + ' — refine filters to narrow down.';
    } else if (filtered.length === 0) {
      noteEl.textContent = marks.length
        ? marks.length + ' mark(s) — no requests match in this range.'
        : (all.length === 0
          ? 'No requests yet — click the extension icon on your tab and \u201CStart capturing\u201D.'
          : 'Filters match 0 of ' + all.length + ' requests.');
    } else {
      noteEl.textContent = '';
    }
  }

  function prependRow(r) {
    if (marks.length > 0) { renderList(); return; } // keep marks interleaved correctly
    if (listEl.firstChild && listEl.firstChild.classList && listEl.firstChild.classList.contains('lrow')) {
      listEl.prepend(rowNode(r));
      // cap only counts request rows; mark dividers are kept
      let rows = listEl.querySelectorAll('.lrow').length;
      while (rows > MAX_ROWS) {
        const rowsAll = listEl.querySelectorAll('.lrow');
        listEl.removeChild(rowsAll[rowsAll.length - 1]);
        rows--;
      }
      if (filtered.length > MAX_ROWS) {
        noteEl.textContent = 'Showing ' + MAX_ROWS + ' newest of ' + filtered.length + ' \u2014 refine filters to narrow down.';
      } else {
        noteEl.textContent = '';
      }
    } else {
      renderList();
    }
  }

  /* ---------------- replay & diff ---------------- */

  async function runReplay(r) {
    if (replayBusyId) return;
    replayBusyId = r.id;
    if (selectedId === r.id) renderDetail(r);
    try {
      const res = await fetch('/api/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: r.id }),
      });
      replayCache.set(r.id, await res.json());
    } catch (e) {
      replayCache.set(r.id, { ok: false, error: String((e && e.message) || e) });
    } finally {
      if (replayBusyId === r.id) {
        replayBusyId = null;
        if (selectedId === r.id) renderDetail(r);
      }
    }
  }

  /* LCS-based line diff with caps so huge bodies don't explode memory */
  function lineDiff(a, b, cap) {
    cap = cap || 800;
    let A = String(a == null ? '' : a).split(/\r?\n/);
    let B = String(b == null ? '' : b).split(/\r?\n/);
    const truncated = A.length > cap || B.length > cap;
    if (A.length > cap) A = A.slice(0, cap);
    if (B.length > cap) B = B.slice(0, cap);
    const n = A.length, m = B.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
      const cur = dp[i], next = dp[i + 1];
      for (let j = m - 1; j >= 0; j--) {
        cur[j] = A[i] === B[j] ? next[j + 1] + 1 : Math.max(next[j], cur[j + 1]);
      }
    }
    const rows = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { rows.push({ t: '=', l: A[i], r: B[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: '-', l: A[i], r: null }); i++; }
      else { rows.push({ t: '+', l: null, r: B[j] }); j++; }
    }
    while (i < n) { rows.push({ t: '-', l: A[i], r: null }); i++; }
    while (j < m) { rows.push({ t: '+', l: null, r: B[j] }); j++; }
    return { rows, truncated };
  }

  function renderReplayResult(res, r) {
    if (!res.ok) {
      return '<div class="note" style="color:var(--red)">Replay failed: ' + esc(res.error || 'unknown error') + '</div>';
    }
    let html =
      '<div class="dhead-top" style="margin:6px 0">' +
      '<span class="' + statusClass(res) + '">' + esc(res.status == null ? '\u2014' : res.status) + '</span>' +
      '<span class="meta">' + esc('replay \u00B7 ' + fmtMs(res.durationMs) + ' \u00B7 ' + fmtBytes(res.size) +
        (res.bodyTruncated ? ' \u00B7 truncated' : '')) + '</span></div>';

    if (r.resBody != null && res.body != null && !res.binary) {
      const orig = prettyText(r.resBody, r.mimeType);
      const replayed = prettyText(res.body, res.mimeType);
      const d = lineDiff(orig, replayed);
      let rowsHtml = '';
      for (const row of d.rows) {
        const cls = row.t === '=' ? 's' : (row.t === '-' ? 'd' : 'a');
        rowsHtml += '<div class="diff-row ' + cls + '">' +
          '<div>' + esc(row.l == null ? '' : row.l) + '</div>' +
          '<div>' + esc(row.r == null ? '' : row.r) + '</div></div>';
      }
      html +=
        '<div class="sect">Diff \u2014 captured vs replayed</div>' +
        (d.truncated ? '<div class="note">Diff truncated to the first 800 lines per side.</div>' : '') +
        '<div class="diff"><div class="diff-h"><div>captured response</div><div>replayed response</div></div>' +
        rowsHtml + '</div>';
    } else if (res.binary) {
      html += '<div class="sect">Diff</div><div class="note">Replayed response is binary (' + esc(fmtBytes(res.size)) + ') \u2014 diff unavailable.</div>';
    }
    return html;
  }

  function renderReplayTab(r) {
    const result = replayCache.get(r.id);
    const busy = replayBusyId === r.id;
    let html =
      '<div class="note">Re-issues the captured request \u2014 same method, headers' +
      (r.reqBody != null ? ', body' : '') + ' \u2014 from the app over the real network to ' +
      esc(hostOf(r.url) || 'the target') + '. A real request is fired; the result is kept in your browser only.</div>' +
      '<button id="btn-replay" class="ghost"' + (busy ? ' disabled' : '') + ' style="margin:8px 0">' +
      (busy ? 'Replaying\u2026' : (result ? 'Re-send request' : 'Send replay request')) + '</button>';
    if (result) html += renderReplayResult(result, r);
    return html;
  }

  /* ---------------- detail ---------------- */

  async function ensureFull(id) {
    let full = bodyCache.get(id);
    if (full) return full;
    try {
      const res = await fetch('/api/records/' + encodeURIComponent(id));
      if (res.ok) {
        full = await res.json();
        bodyCache.set(id, full);
      }
    } catch (e) { /* leave null */ }
    return full;
  }

  async function select(id) {
    selectedId = id;
    for (const el of listEl.children) {
      el.classList.toggle('sel', el.dataset.id === id);
    }
    renderDetailLoading();
    try {
      const full = await ensureFull(id);
      if (selectedId !== id) return;
      if (!full) { renderDetailMessage('Record not found (server may have been cleared/restarted).'); return; }
      renderDetail(full);
    } catch (e) {
      if (selectedId === id) renderDetailMessage('Failed to load details: ' + e.message);
    }
  }

  function renderDetailLoading() {
    detailEl.innerHTML = '<div class="placeholder">Loading\u2026</div>';
  }
  function renderDetailMessage(msg) {
    detailEl.innerHTML = '<div class="placeholder">' + esc(msg) + '</div>';
  }

  function kvRows(pairs) {
    return '<table class="kv">' + pairs.map(([k, v]) =>
      '<tr><td class="k">' + esc(k) + '</td><td class="v">' + esc(v == null ? '\u2014' : v) + '</td></tr>'
    ).join('') + '</table>';
  }

  function prettyText(raw, contentType) {
    const rawStr = String(raw == null ? '' : raw);
    const trimmed = rawStr.trimStart();
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch (e) { /* not JSON — show raw */ }
    }
    return rawStr;
  }

  function prettyBody(raw, contentType) {
    if (raw == null) return '<div class="note">No body.</div>';
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('x-www-form-urlencoded')) {
      let rows = '';
      try {
        for (const [k, v] of new URLSearchParams(raw)) {
          rows += '<tr><td class="k">' + esc(k) + '</td><td class="v">' + esc(v) + '</td></tr>';
        }
      } catch (e) { /* fall through */ }
      if (rows) {
        return '<table class="kv">' + rows + '</table>' + bodyPre(raw, true) ;
      }
    }
    return bodyPre(prettyText(raw, ct));
  }

  function bodyPre(text, hidden) {
    return '<div class="body-wrap"><button class="copy-btn" data-copy>Copy</button>' +
      '<pre class="body" style="' + (hidden ? 'display:none' : '') + '">' + esc(text) + '</pre></div>';
  }

  function renderOverview(r) {
    const dur = r.durationMs != null ? r.durationMs : 0;
    const ttfb = r.ttfbMs != null ? r.ttfbMs : 0;
    const dl = Math.max(0, dur - ttfb);
    const total = Math.max(1, ttfb + dl);
    const initiator = r.initiator ? (r.initiator.type || 'other') + (r.initiator.url ? ' \u2014 ' + r.initiator.url : '') : null;
    return kvRows([
      ['status', r.status == null ? (r.error ? 'failed' : '\u2014') : r.status + (r.statusText ? ' ' + r.statusText : '')],
      ['time', fmtTime(r.ts)],
      ['type', r.type || '\u2014'],
      ['mime', r.mimeType || '\u2014'],
      ['total time', fmtMs(r.durationMs)],
      ['waiting (ttfb)', fmtMs(r.ttfbMs)],
      ['content', fmtMs(dl)],
      ['size (encoded)', fmtBytes(r.size)],
      ['host', hostOf(r.url) || '\u2014'],
      ['tab id', r.tabId || '\u2014'],
      ['initiator', initiator || '\u2014'],
      ['notes', [r.redirect ? 'redirect' : null, r.fromCache ? 'served from cache' : null,
        r.error ? 'error: ' + r.error : null,
        r.wsFramesCount != null ? r.wsFramesCount + ' WS frame(s)' : null].filter(Boolean).join(', ') || '\u2014'],
    ]) +
      '<div class="sect">Timing</div>' +
      '<div class="wf"><div class="wf-row">' +
      '<span class="wf-label">waiting</span>' +
      '<div class="wf-track"><i class="wf-wait" style="width:' + ((ttfb / total) * 100).toFixed(1) + '%"></i><i class="wf-dl" style="width:' + ((dl / total) * 100).toFixed(1) + '%"></i></div>' +
      '<span class="wf-val">' + esc(fmtMs(r.durationMs)) + '</span>' +
      '</div></div>';
  }

  function headerList(h) {
    const keys = Object.keys(h || {});
    if (!keys.length) return '<div class="note">None.</div>';
    return '<ul class="hdrlist">' + keys.map(k =>
      '<li><b>' + esc(k) + ':</b> <span>' + esc(h[k]) + '</span></li>').join('') + '</ul>';
  }

  function renderDetail(r) {
    const tabDefs = [
      ['overview', 'Overview'],
      ['headers', 'Headers'],
      ['req', 'Request'],
      ['res', 'Response'],
      ['curl', 'cURL'],
      ['replay', 'Replay'],
    ];
    if (r.wsFrames && r.wsFrames.length) tabDefs.push(['ws', 'WS Frames (' + r.wsFrames.length + ')']);
    if (!tabDefs.some(t => t[0] === detailTab)) detailTab = 'overview';
    const tabs = tabDefs.map(([id, label]) =>
      '<button data-tab="' + id + '" class="' + (detailTab === id ? 'active' : '') + '">' + label + '</button>'
    ).join('');

    let bodyHtml = '';
    if (detailTab === 'overview') {
      bodyHtml = renderOverview(r);
    } else if (detailTab === 'headers') {
      bodyHtml = '<div class="sect">Request headers</div>' + headerList(r.reqHeaders) +
        '<div class="sect">Response headers</div>' + headerList(r.resHeaders);
    } else if (detailTab === 'req') {
      bodyHtml = r.reqBody == null
        ? '<div class="note">No request body.</div>'
        : prettyBody(r.reqBody, (r.reqHeaders['content-type'] || r.reqHeaders['Content-Type'] || ''));
      if (r.reqBody != null && r.reqBodyTruncated) {
        bodyHtml = '<div class="note">Truncated to 200 KB by the capture limit.</div>' + bodyHtml;
      }
    } else if (detailTab === 'curl') {
      const risky = Object.keys(r.reqHeaders || {}).some(k => /^(cookie|authorization)$/i.test(k));
      bodyHtml =
        '<div class="note">Single-line command \u2014 works in bash, zsh and PowerShell.' +
        (risky ? ' Includes auth/cookie headers from the capture.' : '') + '</div>' +
        '<div class="body-wrap"><button class="copy-btn" data-copy>Copy</button>' +
        '<pre class="body" style="max-height:340px">' + esc(buildCurl(r)) + '</pre></div>';
    } else if (detailTab === 'replay') {
      bodyHtml = renderReplayTab(r);
    } else if (detailTab === 'ws') {
      bodyHtml = (r.wsFramesTruncated ? '<div class="note">Frame buffer capped \u2014 showing the first frames.</div>' : '') +
        '<div class="ws-list">' + r.wsFrames.map(f =>
          '<div class="wsf ' + (f.d === 'out' ? 'out' : f.d === 'err' ? 'err' : 'in') + '">' +
          '<div class="wsf-h"><b>' + (f.d === 'out' ? '\u2191 out' : f.d === 'err' ? '\u26A0 error' : '\u2193 in') + '</b>' +
          '<span>' + esc(fmtTime(f.t) + ' \u00B7 ' + fmtBytes(f.len)) + '</span></div>' +
          (f.data ? bodyPre(prettyText(f.data)) : '<div class="note">(no payload)</div>') +
          '</div>').join('') + '</div>';
    } else {
      if (r.resBodyEncoding === 'base64' && r.resBody != null) {
        const approx = Math.floor((r.resBody || '').length * 0.75);
        bodyHtml = '<div class="note">Binary response (\u2248' + esc(fmtBytes(approx)) + '), not rendered.</div>';
      } else if (r.resBody == null) {
        bodyHtml = '<div class="note">No response body captured.</div>';
      } else {
        bodyHtml = prettyBody(r.resBody, r.mimeType) +
          (r.resBodyTruncated ? '<div class="note">Truncated to 200 KB by the capture limit.</div>' : '');
      }
    }

    const st = (r.error && !r.status) ? 'ERR' : (r.status == null ? '\u2014' : r.status);
    detailEl.innerHTML =
      '<div class="dhead">' +
      '<div class="dhead-top">' +
      '<span class="' + statusClass(r) + ' big">' + esc(st) + '</span>' +
      '<span class="' + methodClass(r.method) + ' big">' + esc(r.method) + '</span>' +
      '<button class="ghost x" id="dclose">\u2715</button>' +
      '</div>' +
      '<div class="durl">' + esc(r.url) + '</div>' +
      '<div class="dtabs">' + tabs + '</div>' +
      '</div>' +
      '<div class="dbody">' + bodyHtml + '</div>';

    $('#dclose').addEventListener('click', () => {
      selectedId = null;
      detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
      for (const el of listEl.children) el.classList.remove('sel');
    });
    const rbtn = detailEl.querySelector('#btn-replay');
    if (rbtn) rbtn.addEventListener('click', () => { void runReplay(r); });
    for (const b of detailEl.querySelectorAll('.dtabs button')) {
      b.addEventListener('click', () => { detailTab = b.dataset.tab; renderDetail(r); });
    }
    for (const b of detailEl.querySelectorAll('[data-copy]')) {
      b.addEventListener('click', () => {
        const pre = b.parentElement.querySelector('pre');
        if (pre) navigator.clipboard.writeText(pre.textContent).then(() => toast('Copied'), () => toast('Copy failed'));
      });
    }
  }

  /* ---------------- insights ---------------- */

  function topEntries(map, n, fmt) {
    return [...map.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([k, v]) => fmt(k, v));
  }

  function renderBars(items, cls) {
    if (!items.length) return '<div class="empty">No data yet.</div>';
    const max = Math.max(...items.map(i => i.v), 1);
    return items.map(i =>
      '<div class="hrow' + (i.id ? ' click' : '') + '"' + (i.id ? ' data-id="' + esc(i.id) + '"' : '') + '>' +
      '<span class="hl" title="' + esc(i.l) + '">' + esc(i.l) + '</span>' +
      '<div class="hb ' + (cls || '') + '"><i style="width:' + ((i.v / max) * 100).toFixed(1) + '%"></i></div>' +
      '<span class="hv">' + esc(i.h || i.v) + '</span>' +
      '</div>').join('');
  }

  function renderTimeline() {
    const N = 30, BUCKET = 10000, SPAN = N * BUCKET;
    const now = Date.now();
    const total = new Array(N).fill(0);
    const errs = new Array(N).fill(0);
    for (const r of filtered) {
      const age = now - (r.ts || 0);
      if (age < 0 || age > SPAN) continue;
      const bi = N - 1 - Math.floor(age / BUCKET);
      total[bi]++;
      if (isError(r)) errs[bi]++;
    }
    const max = Math.max(...total, 1);
    let html = '<div class="tl">';
    for (let i = 0; i < N; i++) {
      const eH = (errs[i] / max) * 100;
      const oH = ((total[i] - errs[i]) / max) * 100;
      html += '<div class="tcol" title="' + (SPAN / 1000 - (i * SPAN / 1000) / 1).toFixed(0) + 's ago: ' + total[i] + '">' +
        (oH > 0 ? '<i class="tok" style="height:' + oH.toFixed(1) + '%"></i>' : '') +
        (eH > 0 ? '<i class="terr" style="height:' + eH.toFixed(1) + '%"></i>' : '') +
        '</div>';
    }
    html += '</div><div class="tl-axis"><span>-5 min</span><span>-2.5 min</span><span>now</span></div>';
    if (max === 1 && total.every(c => c === 0)) return '<div class="empty">No data yet.</div>';
    return html;
  }

  function renderInsights() {
    const n = filtered.length;
    if (n === 0) {
      $('#tiles').innerHTML = '<div class="empty">No requests match the current filters.</div>';
      for (const id of ['chart-status', 'chart-hosts', 'chart-endpoints', 'chart-slow', 'chart-ct', 'chart-timeline']) {
        $('#' + id).innerHTML = '<div class="empty">No data yet.</div>';
      }
      return;
    }

    let errN = 0, bytes = 0, durSum = 0, durCount = 0, rpm = 0;
    const now = Date.now();
    const durs = [];
    const statuses = new Map();
    const hosts = new Map();
    const endpoints = new Map();
    const cts = new Map();
    const slow = [];

    for (const r of filtered) {
      const err = isError(r);
      if (err) errN++;
      if (r.size) bytes += r.size;
      if (r.durationMs != null && Number.isFinite(r.durationMs)) {
        durs.push(r.durationMs);
        durSum += r.durationMs;
        durCount++;
      }
      if (r.ts && now - r.ts <= 60000) rpm++;

      const sb = err && !r.status ? 'failed' : (Math.floor((Number(r.status) || 0) / 100) + 'xx');
      const sc = statuses.get(sb) || { count: 0 };
      sc.count++;
      statuses.set(sb, sc);

      const h = hostOf(r.url) || 'unknown';
      const hc = hosts.get(h) || { count: 0 };
      hc.count++;
      hosts.set(h, hc);

      const epKey = epKeyOf(r);
      const ec = endpoints.get(epKey) || { count: 0, durSum: 0, durN: 0, err: 0 };
      ec.count++;
      if (r.durationMs != null && Number.isFinite(r.durationMs)) { ec.durSum += r.durationMs; ec.durN++; }
      if (err) ec.err++;
      endpoints.set(epKey, ec);

      if (r.mimeType) {
        const mc = cts.get(r.mimeType) || { count: 0 };
        mc.count++;
        cts.set(r.mimeType, mc);
      }

      if (r.durationMs != null && Number.isFinite(r.durationMs)) {
        slow.push(r);
      }
    }

    durs.sort((a, b) => a - b);
    const avg = durCount ? durSum / durCount : null;
    const p95 = durs.length ? durs[Math.ceil(durs.length * 0.95) - 1] : null;
    const errPct = n ? Math.round((errN / n) * 100) : 0;

    $('#tiles').innerHTML = [
      { v: n, l: 'requests (filtered)', h: 'of ' + all.length + ' captured' },
      { v: errN, l: 'errors', h: errPct + '% of shown', cls: errN ? 'bad' : '' },
      { v: avg != null ? fmtMs(avg) : '\u2014', l: 'avg duration' },
      { v: p95 != null ? fmtMs(p95) : '\u2014', l: 'p95 duration', cls: p95 != null && p95 > 2000 ? 'warn' : '' },
      { v: fmtBytes(bytes), l: 'total data' },
      { v: rpm, l: 'req/min', h: 'last 60 s' },
    ].map(t =>
      '<div class="tile"><div class="tile-v ' + (t.cls || '') + '">' + esc(t.v) + '</div>' +
      '<div class="tile-l">' + esc(t.l) + '</div>' +
      (t.h ? '<div class="tile-h">' + esc(t.h) + '</div>' : '') + '</div>'
    ).join('');

    const statusItems = ['2xx', '3xx', '4xx', '5xx', 'failed']
      .filter(k => statuses.has(k))
      .map(k => ({ l: k, v: statuses.get(k).count, h: statuses.get(k).count + '' }));
    $('#chart-status').innerHTML = renderBars(statusItems, 'green');

    $('#chart-hosts').innerHTML = renderBars(
      topEntries(hosts, 8, (k, v) => ({ l: k, v: v.count, h: v.count + '' })), 'amber');

    $('#chart-endpoints').innerHTML = renderBars(
      topEntries(endpoints, 12, (k, v) => ({
        id: k,
        l: k,
        v: v.count,
        h: '\u00D7' + v.count + ' \u00B7 avg ' + (v.durN ? fmtMs(v.durSum / v.durN) : '\u2014') + (v.err ? ' \u00B7 ' + Math.round((v.err / v.count) * 100) + '% err' : ''),
      })));

    const slowTop = slow.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 6)
      .map(r => ({
        l: r.method + ' ' + pathOf(r.url).slice(0, 48),
        v: r.durationMs,
        h: fmtMs(r.durationMs),
        id: r.id,
      }));
    $('#chart-slow').innerHTML = renderBars(slowTop, 'red');

    $('#chart-ct').innerHTML = renderBars(
      topEntries(cts, 6, (k, v) => ({ l: k, v: v.count, h: v.count + '' })));

    $('#chart-timeline').innerHTML = renderTimeline();
  }

  let insightsTimer = null;
  function scheduleInsights() {
    if (insightsTimer) return;
    insightsTimer = setTimeout(() => {
      insightsTimer = null;
      renderInsights();
      renderMini();
      renderSpark();
      updateHostFilter();
      updateEndpointFilter();
      updateEpStats();
    }, 250);
  }

  /* tiny requests-per-second pulse in the header */
  function renderSpark() {
    const el = $('#spark');
    if (!el) return;
    const now = Date.now();
    const buckets = new Array(60).fill(0);
    for (const r of all) {
      const age = now - (r.ts || 0);
      if (age >= 0 && age < 60000) buckets[59 - Math.floor(age / 1000)]++;
    }
    const max = Math.max(...buckets, 1);
    let html = '';
    for (let i = 0; i < 60; i++) {
      const h = buckets[i] ? Math.max(10, Math.round((buckets[i] / max) * 88)) : 4;
      const title = buckets[i] ? (59 - i) + 's ago: ' + buckets[i] + ' req' : 'idle';
      html += '<i style="height:' + h + '%;opacity:' + (buckets[i] ? '.9' : '.3') + '" title="' + esc(title) + '"></i>';
    }
    el.innerHTML = html;
  }

  function renderMini() {
    let errN = 0;
    for (const r of filtered) if (isError(r)) errN++;
    $('#mini-stats').textContent =
      filtered.length + ' shown \u00B7 ' + errN + ' errors \u00B7 ' + all.length + ' captured';
  }

  /* ---------------- filters / host dropdown ---------------- */

  function updateHostFilter() {
    const sel = $('#f-host');
    const current = filters.host;
    const hosts = new Map();
    for (const r of all) {
      const h = hostOf(r.url);
      if (h) hosts.set(h, (hosts.get(h) || 0) + 1);
    }
    const options = [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(e =>
      '<option' + (e[0] === current ? ' selected' : '') + '>' + esc(e[0]) + '</option>').join('');
    sel.innerHTML = '<option value="">Any host</option>' + options;
  }

  let lastEpOptionsHtml = '';
  function updateEndpointFilter() {
    const sel = $('#f-endpoint');
    const current = filters.endpoint;
    const counts = new Map();
    for (const r of all) {
      if (!matches(r, ['endpoint'])) continue;
      const k = epKeyOf(r);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let options = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([k, c]) =>
        '<option value="' + esc(k) + '"' + (k === current ? ' selected' : '') + '>' +
        esc(k + '  \u00D7' + c) + '</option>').join('');
    const html = '<option value="">All endpoints</option>' + options;
    if (html === lastEpOptionsHtml) return; // avoid rebuilding dropdown mid-interaction
    lastEpOptionsHtml = html;
    sel.innerHTML = html;
  }

  /* stats pill for the selected endpoint: count + average + errors */
  function updateEpStats() {
    const el = $('#ep-stats');
    if (!filters.endpoint) { el.hidden = true; return; }
    let n = 0, durSum = 0, durN = 0, errs = 0;
    for (const r of all) {
      if (!matches(r)) continue;
      n++;
      if (isError(r)) errs++;
      if (r.durationMs != null && Number.isFinite(r.durationMs)) { durSum += r.durationMs; durN++; }
    }
    el.hidden = false;
    el.textContent = '\u00D7' + n + ' calls \u00B7 avg ' +
      (durN ? fmtMs(durSum / durN) : '\u2014') +
      (errs ? ' \u00B7 ' + errs + ' errors' : '');
  }

  function searchModeActive() {
    return bodySearch && filters.q && filters.q.trim().length >= 2;
  }

  async function runServerSearch() {
    const q = filters.q.trim();
    const myToken = ++searchToken;
    let data = searchCache.get(q);
    if (!data) {
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        data = await res.json();
      } catch (e) { /* fall through */ }
      if (myToken !== searchToken) return;
      if (data) {
        searchCache.set(q, data);
        if (searchCache.size > 30) searchCache.delete(searchCache.keys().next().value);
      }
    }
    if (!data) { noteEl.textContent = 'Search failed \u2014 is the app still running?'; return; }
    filtered.length = 0;
    for (const r of data.results || []) filtered.push(r);
    renderList();
    noteEl.textContent = 'Server search: ' + filtered.length + ' hit(s) in ' + (data.scanned || 0) +
      ' records \u2014 searches bodies, URLs and errors; retype or clear to refresh.';
    scheduleInsights();
  }

  function refilter() {
    if (searchModeActive()) { void runServerSearch(); return; }
    filtered.length = 0;
    for (const r of all) if (matches(r)) filtered.push(r);
    renderList();
    scheduleInsights();
  }

  function bindFilters() {
    $('#f-search').addEventListener('input', e => { filters.q = e.target.value.trim(); refilter(); });
    $('#f-method').addEventListener('change', e => { filters.method = e.target.value; refilter(); });
    $('#f-status').addEventListener('change', e => { filters.status = e.target.value; refilter(); });
    $('#f-host').addEventListener('change', e => { filters.host = e.target.value; refilter(); });
    $('#f-endpoint').addEventListener('change', e => { filters.endpoint = e.target.value; refilter(); });
    $('#f-rest').addEventListener('change', e => { filters.restOnly = e.target.checked; refilter(); });
    $('#f-bodies').addEventListener('change', e => { bodySearch = e.target.checked; refilter(); });

    /* keyboard flow: / focus search · j/k move · Enter open · c copy curl · Esc close */
    document.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inField = e.target && e.target.closest && e.target.closest('input, textarea, select');
      if (e.key === '/' && !inField) {
        e.preventDefault();
        const s = $('#f-search');
        s.focus(); s.select();
        return;
      }
      if (inField) {
        if (e.key === 'Escape') { e.target.blur(); }
        return;
      }
      const rows = listEl.querySelectorAll('.lrow');
      if ((e.key === 'j' || e.key === 'k') && rows.length) {
        e.preventDefault();
        let idx = e.key === 'j' ? cursorIdx + 1 : cursorIdx - 1;
        if (idx < 0) idx = -1;
        if (idx >= rows.length) idx = rows.length - 1;
        cursorIdx = idx;
        for (const r of rows) r.classList.remove('cursor');
        if (idx >= 0) {
          rows[idx].classList.add('cursor');
          rows[idx].scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        if (cursorIdx >= 0 && cursorIdx < rows.length) select(rows[cursorIdx].dataset.id);
      } else if (e.key === 'c' && !inField) {
        if (cursorIdx >= 0 && cursorIdx < rows.length) {
          const id = rows[cursorIdx].dataset.id;
          void ensureFull(id).then(rec => {
            if (!rec) { toast('Details unavailable'); return; }
            navigator.clipboard.writeText(buildCurl(rec)).then(() => toast('cURL copied'), () => toast('Copy failed'));
          }).catch(() => toast('Copy failed'));
        }
      } else if (e.key === 'Escape') {
        if (selectedId) {
          selectedId = null;
          detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
          for (const el of listEl.children) el.classList.remove('sel');
        }
      }
    });
    $('#f-min').addEventListener('input', e => {
      filters.minMs = Number(e.target.value) || 0;
      refilter();
    });
    $('#btn-reset').addEventListener('click', () => {
      filters.q = ''; filters.method = ''; filters.status = ''; filters.host = ''; filters.minMs = 0;
      filters.endpoint = ''; filters.restOnly = false;
      $('#f-search').value = ''; $('#f-method').value = '';
      $('#f-status').value = ''; $('#f-host').value = ''; $('#f-min').value = '';
      $('#f-endpoint').value = ''; $('#f-rest').checked = false;
      updateEpStats();
      refilter();
    });
    $('#btn-clear').addEventListener('click', async () => {
      try { await fetch('/api/clear', { method: 'POST' }); } catch (e) { toast('Clear failed'); }
      // SSE 'clear' message will reset state; do it locally too:
      resetData();
    });
    $('#btn-mark').addEventListener('click', addMarkNow);
    $('#btn-pause').addEventListener('click', togglePause);
    listEl.addEventListener('click', async e => {
      const mrm = e.target.closest('.mrm');
      if (mrm) {
        e.stopPropagation();
        const mr = mrm.closest('.markrow');
        if (mr) void deleteMarkNow(mr.dataset.mid);
        return;
      }
      const curlBtn = e.target.closest('.curl-mini');
      if (curlBtn) {
        e.stopPropagation();
        const row = curlBtn.closest('.lrow');
        if (!row) return;
        const rec = await ensureFull(row.dataset.id);
        if (!rec) { toast('Details unavailable \u2014 server may have restarted'); return; }
        navigator.clipboard.writeText(buildCurl(rec)).then(() => toast('cURL copied'), () => toast('Copy failed'));
        return;
      }
      const row = e.target.closest('.lrow');
      if (row) select(row.dataset.id);
    });
    document.getElementById('chart-slow').addEventListener('click', e => {
      const row = e.target.closest('.hrow[data-id]');
      if (row) {
        select(row.dataset.id);
        detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    document.getElementById('chart-endpoints').addEventListener('click', e => {
      const row = e.target.closest('.hrow[data-id]');
      if (row) {
        filters.endpoint = row.dataset.id;
        $('#f-endpoint').value = filters.endpoint;
        refilter();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  /* ---------------- data flow ---------------- */

  function resetData() {
    all.length = 0;
    filtered.length = 0;
    bodyCache.clear();
    marks.length = 0;
    pausedQueue.length = 0;
    updatePauseUi();
    selectedId = null;
    filters.endpoint = '';
    filters.restOnly = false;
    $('#f-endpoint').value = '';
    $('#f-rest').checked = false;
    updateEpStats();
    detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
    renderList();
    scheduleInsights();
    updateHostFilter();
  }

  function addRecord(rec) {
    all.unshift(rec);
    if (all.length > MAX_KEEP) all.length = MAX_KEEP;
    if (searchModeActive()) return; // frozen point-in-time search view
    if (matches(rec)) {
      filtered.unshift(rec);
      if (filtered.length > MAX_KEEP) filtered.length = MAX_KEEP;
      if (filtered.length === 1) refilter(); else prependRow(rec);
    }
    scheduleInsights();
  }

  /* drop records matching a server-pushed purge filter, in place */
  function purgeLocal(f) {
    const host = f && f.host ? String(f.host) : null;
    const urlContains = f && f.urlContains ? String(f.urlContains) : null;
    if (!host && !urlContains) return;
    const hit = r => {
      const h = hostOf(r.url);
      return (host && h === host) || (urlContains && r.url.includes(urlContains));
    };
    const wipe = arr => {
      for (let i = arr.length - 1; i >= 0; i--) if (hit(arr[i])) arr.splice(i, 1);
    };
    wipe(all);
    wipe(filtered);
    wipe(pausedQueue);
    for (const [id, r] of [...bodyCache.entries()]) if (hit(r)) bodyCache.delete(id);
    if (selectedId) {
      const stillThere = all.some(r => r.id === selectedId) || bodyCache.has(selectedId);
      if (!stillThere) {
        selectedId = null;
        detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
      }
    }
    renderList();
    scheduleInsights();
    updateHostFilter();
    updateEndpointFilter();
    updateEpStats();
  }

  async function refreshSnapshot() {
    try {
      const res = await fetch('/api/snapshot');
      const data = await res.json();
      all.length = 0;
      for (const r of data.records || []) all.push(r);
      bodyCache.clear();
      marks.length = 0;
      for (const m of data.marks || []) marks.push(m);
      if (data.version) $('#app-version').textContent = 'v' + data.version;
      if (selectedId && !all.some(r => r.id === selectedId)) {
        selectedId = null;
        detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
      }
      refilter();
    } catch (e) { /* server may be restarting */ }
  }

  /* ---------------- SSE ---------------- */

  function setConn(online) {
    $('#conn-dot').className = 'dot' + (online ? ' on' : '');
    $('#conn-label').textContent = online ? 'live' : 'reconnecting\u2026';
  }

  /* ---------------- pause / resume ---------------- */

  function updatePauseUi() {
    const btn = $('#btn-pause');
    btn.classList.toggle('active', paused);
    btn.textContent = paused
      ? 'Resume (' + pausedQueue.length + ' buffered)'
      : 'Pause';
    btn.title = paused
      ? 'Resume live updates — ' + pausedQueue.length + ' captured request(s) are buffered'
      : 'Freeze the live view \u2014 captures keep buffering in the background';
  }

  function togglePause() {
    paused = !paused;
    updatePauseUi();
    if (!paused && pausedQueue.length) {
      const buffered = pausedQueue.splice(0, pausedQueue.length);
      for (let i = buffered.length - 1; i >= 0; i--) addRecord(buffered[i]); // oldest first
      if (buffered.length > 4) refilter();
    } else if (!paused) {
      renderList();
    }
  }

  /* ---------------- marks ---------------- */

  async function addMarkNow() {
    const label = window.prompt('Mark label (e.g. "clicked Checkout")', 'Mark ' + (marks.length + 1));
    if (label === null) return; // cancelled
    try {
      await fetch('/api/mark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label || 'Mark' }),
      });
      // server broadcasts 'mark' to all dashboards
    } catch (e) { toast('Mark failed'); }
  }

  async function deleteMarkNow(id) {
    try { await fetch('/api/marks/' + encodeURIComponent(id), { method: 'DELETE' }); }
    catch (e) { toast('Delete failed'); }
  }

  function connect() {
    /* ?nosse=1 renders the snapshot without the live feed — diagnostics/screenshots */
    const params = new URLSearchParams(location.search);
    if (params.has('nosse')) {
      setConn(false);
      $('#conn-label').textContent = 'static (nosse)';
      return;
    }
    try { if (window.es) window.es.close(); } catch (e) { /* ignore */ }
    const es = new EventSource('/events/stream');
    window.es = es;
    es.onopen = () => { setConn(true); refreshSnapshot(); };
    es.onerror = () => setConn(false);
    es.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'hello') {
        setConn(true);
        if (msg.version) $('#app-version').textContent = 'v' + msg.version;
      } else if (msg.t === 'request') {
        if (!msg.record) return;
        if (paused) {
          pausedQueue.unshift(msg.record);
          updatePauseUi();
        } else {
          addRecord(msg.record);
        }
      } else if (msg.t === 'mark') {
        if (msg.mark) {
          marks.push(msg.mark);
          if (!paused && marks.length <= MAX_ROWS + 2) renderList();
        }
      } else if (msg.t === 'deleteMark') {
        const idx = marks.findIndex(m => m.id === msg.id);
        if (idx >= 0) { marks.splice(idx, 1); if (!paused) renderList(); }
      } else if (msg.t === 'purge') {
        purgeLocal(msg);
      } else if (msg.t === 'clear') {
        resetData();
      }
    };
  }

  /* ---------------- boot ---------------- */

  detailEl.innerHTML = '<div class="placeholder">Select a request on the left to inspect it.</div>';
  bindFilters();
  await refreshSnapshot();
  connect();

  /* deep link: #r<id> or #r<id>/<tab> opens a record (optionally on a tab) — shareable */
  const mhash = location.hash ? location.hash.match(/^#r([^/]+)(?:\/(\w+))?$/) : null;
  if (mhash) {
    const full = await ensureFull(mhash[1]);
    if (mhash[2] && full) { detailTab = mhash[2]; }
    if (full) { selectedId = mhash[1]; renderDetail(full); }
  }
})();
