import {
  api, getSettings, isWebUrl, normalizeUrl, siteOf, groupKeyFor, timeAgo, weekKey, send,
} from './shared.js';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const searchEl = $('#search');

let settings;
let tabs = [];
let heavy = {};
let cpu = new Map(); // tabId -> 0..1, from probe.js in each page
let cpuNodes = []; // [{ ids, node, group }] filled by render()
let view = 'window';
let selected = 0;

/* ---------- helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function svg(path) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '14');
  s.setAttribute('height', '14');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = path; // static icon paths only
  return s;
}
const ICON_CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
const ICON_X = '<path d="M18 6 6 18M6 6l12 12"/>';
const ICON_OPEN = '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';

function favicon(url, pageUrl) {
  const box = el('span', { class: 'favicon', 'aria-hidden': 'true' });
  const letter = (siteOf(pageUrl)[0] || '•').toUpperCase();
  if (url && /^(https?|data):/i.test(url)) {
    const img = el('img', { src: url, alt: '' });
    img.addEventListener('error', () => { box.textContent = letter; });
    box.append(img);
  } else {
    box.textContent = letter;
  }
  return box;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function minutesLabel(min) {
  if (min % 1440 === 0) return plural(min / 1440, 'day');
  if (min % 60 === 0) return plural(min / 60, 'hour');
  return plural(min, 'minute');
}

function formatWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/* ---------- CPU ---------- */

const HIGH_CPU = 0.3;

// Latest CPU share for a tab: live reading from its page, else the
// background's last "busy" report.
function cpuOf(tabId) {
  if (cpu.has(tabId)) return cpu.get(tabId);
  const h = heavy[tabId];
  return h && Date.now() - h.at < 45_000 ? h.ratio : null;
}

const pct = (r) => (r > 0 && r < 0.01 ? '<1%' : `${Math.round(r * 100)}%`);

function askCpu(t) {
  if (t.discarded || !isWebUrl(t.url)) return Promise.resolve(null);
  const timeout = new Promise((res) => setTimeout(() => res(null), 400));
  const ask = api.tabs.sendMessage(t.id, { type: 'taber-cpu' }, { frameId: 0 })
    .then((r) => (typeof r?.ratio === 'number' ? r.ratio : null))
    .catch(() => null);
  return Promise.race([ask, timeout]);
}

async function refreshCpu() {
  const values = await Promise.all(tabs.map(askCpu));
  const next = new Map();
  tabs.forEach((t, i) => { if (values[i] != null) next.set(t.id, values[i]); });
  cpu = next;
  if (view === 'cpu') render(); else paintCpu();
}

function sumCpu(ids) {
  let total = null;
  for (const id of ids) {
    const r = cpuOf(id);
    if (r != null) total = (total ?? 0) + r;
  }
  return total;
}

// Update the CPU labels in place, so the list does not jump while open.
function paintCpu() {
  for (const { ids, node, group } of cpuNodes) {
    const r = group ? sumCpu(ids) : cpuOf(ids[0]);
    node.hidden = r == null;
    node.textContent = r == null ? '' : `CPU ${pct(r)}`;
    node.classList.toggle('high', r != null && r >= (group ? 2 * HIGH_CPU : HIGH_CPU));
  }
}

function cpuLabel(ids, group) {
  const node = el('span', {
    class: group ? 'cpu-total' : 'pill cpu',
    title: group
      ? 'CPU used by these tabs together (estimate)'
      : 'Share of the last 10 s this page kept the browser busy (estimate). Asleep and browser pages: none.',
  });
  cpuNodes.push({ ids, node, group });
  return node;
}

/* ---------- panels ---------- */

const panelRenderers = {
  tabs: () => {},
  sessions: renderSessions,
  snoozed: renderSnoozed,
  statsPanel: renderStatsPanel,
};

function showPanel(name) {
  document.querySelectorAll('.nav [data-panel]').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.panel === name)));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== name; });
  try { localStorage.setItem('taber-panel', name); } catch {}
  panelRenderers[name]?.();
  if (name === 'tabs') searchEl.focus();
}

document.querySelectorAll('.nav [data-panel]').forEach((b) =>
  b.addEventListener('click', () => showPanel(b.dataset.panel)));

/* ---------- tabs panel ---------- */

async function load() {
  settings = await getSettings();
  [tabs, heavy] = await Promise.all([
    api.tabs.query({}),
    send('heavyState').catch(() => ({})),
  ]);
  heavy ||= {};
  renderStats();
  render();
  renderClosed();
  renderSnoozeCount();
  refreshCpu();
}

function duplicateKeys() {
  const counts = new Map();
  for (const t of tabs) {
    if (!isWebUrl(t.url)) continue;
    const k = normalizeUrl(t.url, settings);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

function renderStats() {
  const windows = new Set(tabs.map((t) => t.windowId)).size;
  const sleeping = tabs.filter((t) => t.discarded).length;
  let dups = 0;
  for (const n of duplicateKeys().values()) if (n > 1) dups += n - 1;
  $('#stats').textContent = `${plural(tabs.length, 'tab')} · ${plural(windows, 'window')}` +
    (sleeping ? ` · ${sleeping} asleep` : '');
  $('#dupBtn').textContent = dups ? `Close ${plural(dups, 'duplicate')}` : 'No duplicates';
  $('#dupBtn').disabled = !dups;
  $('#oldBtn').title = `Close tabs unused for ${minutesLabel(settings.autoCloseMinutes)}`;
}

function filtered() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) return tabs;
  const words = q.split(/\s+/);
  return tabs.filter((t) => {
    const hay = `${t.title} ${t.url}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function sections(list) {
  if (view === 'site') {
    const map = new Map();
    for (const t of list) {
      const s = isWebUrl(t.url) ? groupKeyFor(t.url, settings).title : 'Browser pages';
      if (!map.has(s)) map.set(s, []);
      map.get(s).push(t);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([title, items]) => ({ title, items }));
  }
  if (view === 'cpu') {
    const items = [...list].sort((a, b) => (cpuOf(b.id) ?? -1) - (cpuOf(a.id) ?? -1));
    return [{ title: 'Most CPU first', items }];
  }
  if (view === 'old') {
    const items = [...list].sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
    return [{ title: 'Least recently used first', items }];
  }
  const byWin = new Map();
  for (const t of list) {
    if (!byWin.has(t.windowId)) byWin.set(t.windowId, []);
    byWin.get(t.windowId).push(t);
  }
  let i = 0;
  return [...byWin.values()].map((items) => ({
    title: `Window ${++i}${items[0]?.incognito ? ' (private)' : ''}`,
    items: items.sort((a, b) => a.index - b.index),
  }));
}

function render() {
  const list = filtered();
  const counts = duplicateKeys();
  listEl.replaceChildren();
  cpuNodes = [];
  if (!list.length) {
    listEl.append(el('div', { class: 'empty' }, searchEl.value ? 'No tabs match.' : 'No tabs.'));
    return;
  }
  selected = Math.min(selected, list.length - 1);
  let flatIndex = 0;
  for (const sec of sections(list)) {
    const ids = sec.items.map((t) => t.id);
    listEl.append(el('div', { class: 'section-head' },
      el('span', {}, `${sec.title} · ${sec.items.length}`, cpuLabel(ids, true)),
      sec.items.length > 1 ? el('button', { class: 'link', onclick: () => closeTabs(ids) }, 'Close all') : null,
    ));
    for (const t of sec.items) {
      const isDup = isWebUrl(t.url) && counts.get(normalizeUrl(t.url, settings)) > 1;
      const idx = flatIndex++;
      const meta = [
        siteOf(t.url) || t.url,
        t.pinned ? 'pinned' : null,
        t.audible ? 'playing' : null,
        t.discarded ? 'asleep' : null,
        t.active ? 'open now' : timeAgo(t.lastAccessed),
      ].filter(Boolean).join(' · ');
      listEl.append(el('div', {
        class: `tab${t.active ? ' active-tab' : ''}${t.discarded ? ' sleeping' : ''}${idx === selected ? ' selected' : ''}`,
        title: t.url,
        'data-id': t.id,
        onclick: () => switchTo(t),
      },
        favicon(t.favIconUrl, t.url),
        el('div', { class: 'body' },
          el('div', { class: 'title' }, t.title || t.url),
          el('div', { class: 'meta' }, meta),
        ),
        cpuLabel([t.id], false),
        isDup ? el('span', { class: 'pill' }, 'dup') : null,
        isWebUrl(t.url) ? el('button', {
          class: 'row-btn',
          title: 'Snooze',
          'aria-label': `Snooze ${t.title}`,
          onclick: (e) => { e.stopPropagation(); openSnoozeMenu(e.currentTarget, t.id); },
        }, svg(ICON_CLOCK)) : null,
        el('button', {
          class: 'close-x',
          title: 'Close tab',
          'aria-label': `Close ${t.title}`,
          onclick: (e) => { e.stopPropagation(); closeTabs([t.id]); },
        }, '×'),
      ));
    }
  }
  paintCpu();
}

async function renderClosed() {
  const { closedLog = [] } = await api.storage.local.get('closedLog');
  $('#closedCount').textContent = closedLog.length ? `(${closedLog.length})` : '';
  const box = $('#closedList');
  box.replaceChildren();
  $('#clearLog').hidden = !closedLog.length;
  if (!closedLog.length) {
    box.append(el('div', { class: 'empty' }, 'Nothing closed yet.'));
    return;
  }
  const reasonText = { stale: 'old', duplicate: 'duplicate', manual: 'closed by you', limit: 'tab limit', heavy: 'high CPU', error: 'did not load' };
  for (const e of closedLog) {
    box.append(el('div', {
      class: 'tab', title: `Restore ${e.url}`,
      onclick: async () => { await send('restore', { id: e.id }); window.close(); },
    },
      favicon(e.favIconUrl, e.url),
      el('div', { class: 'body' },
        el('div', { class: 'title' }, e.title),
        el('div', { class: 'meta' }, `${reasonText[e.reason] ?? e.reason} · ${timeAgo(e.closedAt)}`),
      ),
    ));
  }
}

async function switchTo(t) {
  await api.tabs.update(t.id, { active: true });
  await api.windows.update(t.windowId, { focused: true });
  window.close();
}

async function closeTabs(ids) {
  await send('closeTabs', { tabIds: ids });
  toast(`Closed ${plural(ids.length, 'tab')}`);
  await load();
}

const actionMessages = {
  groupAll: (r) => (r.native === false ? 'Tabs sorted into groups' : `Made ${plural(r.groups, 'group')}`),
  ungroupAll: (r) => `Ungrouped ${plural(r.count ?? 0, 'tab')}`,
  sleepOthers: (r) => (r.slept ? `Put ${plural(r.slept, 'tab')} to sleep` : 'Nothing to put to sleep'),
  mergeWindows: (r) => (r.moved ? `Merged ${plural(r.moved, 'tab')} into this window` : 'Only one window open'),
  closeDuplicates: (r) => `Closed ${plural(r.closed, 'duplicate')}`,
  closeOld: (r) => (r.closed ? `Closed ${plural(r.closed, 'old tab')}` : 'No old tabs to close'),
};

document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const action = btn.dataset.action;
    const extra = action === 'sleepOthers' ? { windowId: (await api.windows.getCurrent()).id } : {};
    const r = await send(action, extra);
    btn.disabled = false;
    toast(r?.ok === false ? `Failed: ${r.error}` : actionMessages[action](r));
    await load();
  });
});

document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view;
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    try { localStorage.setItem('taber-view', view); } catch {}
    if (settings) render();
  });
});

searchEl.addEventListener('input', () => { selected = 0; render(); });
searchEl.addEventListener('keydown', (e) => {
  const rows = [...listEl.querySelectorAll('.tab')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    selected = Math.max(0, Math.min(rows.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('selected', i === selected));
    rows[selected]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const t = tabs.find((x) => x.id === Number(rows[selected]?.dataset.id));
    if (t) switchTo(t);
  }
});

// Keep CPU numbers live while the popup is open.
setInterval(() => { if (settings && !document.hidden) refreshCpu(); }, 2000);

/* ---------- snooze menu ---------- */

function snoozeOptions() {
  const now = new Date();
  const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const nextMonday = new Date(now); nextMonday.setDate(now.getDate() + (((8 - now.getDay()) % 7) || 7));
  const saturday = new Date(now); saturday.setDate(now.getDate() + (((6 - now.getDay()) + 7) % 7 || 7));
  const opts = [
    { label: 'In 1 hour', when: now.getTime() + 3_600_000 },
    { label: 'Later today', when: now.getTime() + 3 * 3_600_000 },
  ];
  if (now.getHours() < 17) opts.push({ label: 'This evening', when: at(now, 18) });
  opts.push({ label: 'Tomorrow', when: at(tomorrow, 9) });
  if (now.getDay() >= 1 && now.getDay() <= 4) opts.push({ label: 'This weekend', when: at(saturday, 10) });
  opts.push({ label: 'Next week', when: at(nextMonday, 9) });
  return opts;
}

const menu = $('#snoozeMenu');
function openSnoozeMenu(anchor, tabId) {
  menu.replaceChildren(...snoozeOptions().map((o) => el('button', {
    role: 'menuitem',
    onclick: async () => {
      closeMenu();
      const r = await send('snooze', { tabId, wakeAt: o.when });
      toast(r?.ok ? `Snoozed until ${formatWhen(o.when)}` : `Failed: ${r?.error}`);
      await load();
    },
  }, el('span', {}, o.label), el('span', { class: 'when' }, formatWhen(o.when)))));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  menu.querySelector('button')?.focus();
}
function closeMenu() { menu.hidden = true; }
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); closeMenu(); } });

/* ---------- sessions panel ---------- */

$('#saveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const win = await api.windows.getCurrent();
  const r = await send('saveSession', {
    name: $('#sessionName').value,
    scope: $('#sessionScope').value,
    windowId: win.id,
    close: $('#sessionClose').checked,
  });
  if (r?.ok) {
    $('#sessionName').value = '';
    toast(`Saved ${plural(r.count, 'tab')}`);
  } else {
    toast(`Failed: ${r?.error}`);
  }
  await renderSessions();
  await load();
});

async function renderSessions() {
  const { sessions = [] } = await api.storage.local.get('sessions');
  const box = $('#sessionList');
  box.replaceChildren();
  if (!sessions.length) {
    box.append(el('div', { class: 'empty' }, 'No saved sessions yet. Save this window to reopen it later.'));
    return;
  }
  for (const s of sessions) {
    const count = s.windows.reduce((n, w) => n + w.tabs.length, 0);
    const first = s.windows[0]?.tabs[0];
    let armed = false;
    const del = el('button', { class: 'row-btn', title: 'Delete session', 'aria-label': `Delete ${s.name}` }, svg(ICON_X));
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Two clicks to delete, no browser dialog.
      if (!armed) {
        armed = true;
        del.replaceChildren('Delete?');
        del.classList.add('always');
        del.style.width = 'auto';
        setTimeout(() => { armed = false; del.replaceChildren(svg(ICON_X)); del.classList.remove('always'); del.style.width = ''; }, 2500);
        return;
      }
      await send('deleteSession', { id: s.id });
      renderSessions();
    });
    box.append(el('div', {
      class: 'tab', title: 'Open this session in a new window',
      onclick: async () => { await send('openSession', { id: s.id }); window.close(); },
    },
      favicon(first?.favIconUrl, first?.url),
      el('div', { class: 'body' },
        el('div', { class: 'title' }, s.name),
        el('div', { class: 'meta' },
          `${plural(count, 'tab')}${s.windows.length > 1 ? ` · ${plural(s.windows.length, 'window')}` : ''} · ${timeAgo(s.createdAt)}`),
      ),
      el('span', { class: 'row-btn', 'aria-hidden': 'true' }, svg(ICON_OPEN)),
      del,
    ));
  }
}

/* ---------- snoozed panel ---------- */

async function renderSnoozeCount() {
  const { snoozed = [] } = await api.storage.local.get('snoozed');
  $('#snoozeCount').textContent = snoozed.length ? String(snoozed.length) : '';
}

async function renderSnoozed() {
  const { snoozed = [] } = await api.storage.local.get('snoozed');
  const box = $('#snoozeList');
  box.replaceChildren();
  if (!snoozed.length) {
    box.append(el('div', { class: 'empty' }, 'No snoozed tabs.'));
    return;
  }
  for (const s of [...snoozed].sort((a, b) => a.wakeAt - b.wakeAt)) {
    box.append(el('div', {
      class: 'tab', title: `Open now: ${s.url}`,
      onclick: async () => { await send('wakeNow', { id: s.id }); window.close(); },
    },
      favicon(s.favIconUrl, s.url),
      el('div', { class: 'body' },
        el('div', { class: 'title' }, s.title),
        el('div', { class: 'meta' }, `Opens ${formatWhen(s.wakeAt)}`),
      ),
      el('button', {
        class: 'row-btn always',
        title: 'Remove without opening',
        'aria-label': `Remove ${s.title}`,
        onclick: async (e) => {
          e.stopPropagation();
          await send('cancelSnooze', { id: s.id });
          renderSnoozed();
          renderSnoozeCount();
        },
      }, svg(ICON_X)),
    ));
  }
}

/* ---------- stats panel ---------- */

async function renderStatsPanel() {
  const { stats = { weeks: {}, sites: {}, memoryFreedMB: 0 } } = await api.storage.local.get('stats');
  const week = stats.weeks?.[weekKey()] ?? {};
  const sleeping = tabs.filter((t) => t.discarded).length;
  const closedWeek = ['stale', 'limit', 'heavy', 'error', 'duplicate', 'manual']
    .reduce((n, r) => n + (week[`closed_${r}`] || 0), 0);

  const tile = (num, label) => el('div', { class: 'tile' },
    el('div', { class: 'num' }, String(num)), el('div', { class: 'label' }, label));
  const mem = stats.memoryFreedMB || 0;
  $('#tiles').replaceChildren(
    tile(tabs.length, 'open tabs'),
    tile(sleeping, 'asleep now'),
    tile(mem ? (mem >= 1024 ? `${(mem / 1024).toFixed(1)} GB` : `${Math.round(mem)} MB`) : '—', 'memory freed'),
  );
  $('#tiles').lastChild.title = 'Page memory measured before Tabora slept or closed tabs. Chrome only; Firefox does not report it.';

  const rows = [
    ['Tabs put to sleep (idle)', week.slept],
    ['Tabs put to sleep (tab limit)', week.slept_limit],
    ['Tabs put to sleep (high CPU)', week.slept_heavy],
    ['Old tabs closed', week.closed_stale],
    ['Tabs that did not load closed', week.closed_error],
    ['Duplicate tabs avoided', week.dup_avoided],
    ['Duplicates closed', week.closed_duplicate],
    ['Tabs snoozed', week.snoozed],
    ['All tabs closed', closedWeek],
  ];
  $('#weekList').replaceChildren(...rows.map(([k, v]) => el('div', {}, el('span', {}, k), el('span', {}, String(v || 0)))));

  const top = Object.entries(stats.sites || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
  $('#topSites').replaceChildren(...(top.length
    ? top.map(([site, n], i) => el('li', {},
      el('span', { class: 'rank' }, String(i + 1)),
      favicon(null, `https://${site}`),
      el('span', { class: 'name' }, site),
      el('span', { class: 'count' }, String(n))))
    : [el('li', { class: 'muted' }, 'Browse a bit and your top sites show up here.')]));
}

/* ---------- init ---------- */

$('#openOptions').addEventListener('click', () => { api.runtime.openOptionsPage(); window.close(); });
$('#clearLog').addEventListener('click', async () => { await send('clearLog'); renderClosed(); });

try {
  const savedView = localStorage.getItem('taber-view');
  if (savedView) document.querySelector(`[data-view="${savedView}"]`)?.click();
} catch {}
await load();
let startPanel = 'tabs';
try { startPanel = localStorage.getItem('taber-panel') || 'tabs'; } catch {}
showPanel(panelRenderers[startPanel] ? startPanel : 'tabs');
