const $ = id => document.getElementById(id);
let tab = null;

init();

async function init() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = t;
  $('tab-url').textContent = t.url || 'unknown page';
  await refresh();
  $('toggle').addEventListener('click', onToggle);
  $('open').addEventListener('click', async e => {
    e.preventDefault();
    const st = (await chrome.runtime.sendMessage({ cmd: 'status', tabId: tab.id })) || {};
    chrome.tabs.create({ url: st.dashboard || 'http://127.0.0.1:8899' });
    window.close();
  });
  setInterval(refresh, 3000);
}

async function refresh() {
  if (!tab) return;
  const st = (await chrome.runtime.sendMessage({ cmd: 'status', tabId: tab.id })) || {};
  render(st);
}

function render(st) {
  const srvEl = $('srv');
  if (st.online === true) {
    srvEl.textContent = 'connected';
    srvEl.style.color = '#6ee7a8';
  } else if (st.online === false) {
    srvEl.textContent = 'not running';
    srvEl.style.color = '#fca5a5';
  } else {
    srvEl.textContent = 'unknown';
    srvEl.style.color = '#9fb0c3';
  }

  document.getElementById('dot').className = 'dot' + (st.online ? ' on' : '');

  const cap = !!st.capturing;
  $('toggle').textContent = cap ? 'Stop capturing' : 'Start capturing';
  $('toggle').className = cap ? 'stop' : '';
  $('state').textContent = cap ? '\u00B7 capturing this tab' : '';

  const err = $('err');
  if (st.error) {
    err.style.display = 'block';
    err.textContent = st.error;
  } else {
    err.style.display = 'none';
  }
}

async function onToggle() {
  const btn = $('toggle');
  btn.disabled = true;
  const res = (await chrome.runtime.sendMessage({ cmd: 'toggle', tabId: tab.id })) || {};
  btn.disabled = false;
  render(res);
}
