// Storage helpers, closed-tab log, undo notifications and stats.
import { api, getSettings, isFirefox, isWebUrl, safeFavicon, weekKey } from '../shared.js';

/* ---------- serialized read-modify-write (avoids lost updates) ---------- */

let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// `mutate` changes `value` in place and may return a result. Keep it free of
// other updateArea calls, or the queue deadlocks.
function updateArea(area, key, fallback, mutate) {
  return serial(async () => {
    const r = await api.storage[area].get(key);
    const value = r[key] ?? structuredClone(fallback);
    const out = await mutate(value);
    await api.storage[area].set({ [key]: value });
    return out;
  });
}
export const updateSession = (key, fallback, mutate) => updateArea('session', key, fallback, mutate);
export const updateLocal = (key, fallback, mutate) => updateArea('local', key, fallback, mutate);

export async function sessionGet(key, fallback) {
  const r = await api.storage.session.get(key);
  return r[key] ?? fallback;
}

// Tabora itself opens tabs (undo, sessions, snooze): skip the duplicate prompt meanwhile.
export async function quiet(ms) {
  await api.storage.session.set({ quietUntil: Date.now() + ms });
}
export async function isQuiet() {
  return Date.now() < (await sessionGet('quietUntil', 0));
}

/* ---------- stats ---------- */

const STATS_FALLBACK = { since: 0, weeks: {}, sites: {}, memoryFreedMB: 0 };

export function bumpStat(field, n = 1) {
  if (!n) return Promise.resolve();
  return updateLocal('stats', STATS_FALLBACK, (st) => {
    st.since ||= Date.now();
    const key = weekKey();
    st.weeks[key] ??= {};
    st.weeks[key][field] = (st.weeks[key][field] || 0) + n;
    const keys = Object.keys(st.weeks).sort();
    for (const old of keys.slice(0, Math.max(0, keys.length - 12))) delete st.weeks[old];
  });
}

export function addMemory(mb) {
  if (!mb) return Promise.resolve();
  return updateLocal('stats', STATS_FALLBACK, (st) => {
    st.memoryFreedMB = (st.memoryFreedMB || 0) + mb;
  });
}

const pendingVisits = new Map();
let visitTimer;
export function countVisit(site) {
  if (!site) return;
  pendingVisits.set(site, (pendingVisits.get(site) || 0) + 1);
  clearTimeout(visitTimer);
  visitTimer = setTimeout(flushVisits, 2000);
}
function flushVisits() {
  const batch = new Map(pendingVisits);
  pendingVisits.clear();
  updateLocal('stats', STATS_FALLBACK, (st) => {
    st.since ||= Date.now();
    for (const [site, n] of batch) st.sites[site] = (st.sites[site] || 0) + n;
    const entries = Object.entries(st.sites);
    if (entries.length > 500) {
      st.sites = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 300));
    }
  });
}

/* ---------- page memory (Chrome exposes JS heap size; Firefox does not) ---------- */

export async function measureHeap(tabId) {
  try {
    const r = await Promise.race([
      api.tabs.sendMessage(tabId, { type: 'taber-heap' }),
      new Promise((res) => setTimeout(() => res(null), 400)),
    ]);
    return typeof r?.mb === 'number' ? r.mb : 0;
  } catch {
    return 0;
  }
}

/* ---------- closing tabs with log + undo ---------- */

export async function logClosed(tabs, reason) {
  const web = tabs.filter((t) => isWebUrl(t.url));
  if (!web.length) return [];
  const settings = await getSettings();
  const now = Date.now();
  const entries = web.map((t) => ({
    id: crypto.randomUUID(),
    url: t.url,
    title: t.title || t.url,
    favIconUrl: safeFavicon(t.favIconUrl),
    windowId: t.windowId,
    index: t.index,
    pinned: !!t.pinned,
    closedAt: now,
    reason,
  }));
  await updateLocal('closedLog', [], (log) => {
    log.unshift(...entries);
    log.splice(settings.closedLogSize);
  });
  await bumpStat(`closed_${reason}`, entries.length);
  return entries;
}

// '"A", "B", "C" and 2 more' — tab names for close notices.
export function tabNames(tabs, max = 3) {
  const names = tabs.map((t) => `"${(t.title || t.url || 'Untitled').slice(0, 40)}"`);
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export async function closeTabsLogged(tabs, reason, { notify = false, message = '' } = {}) {
  if (!tabs.length) return [];
  const heap = await Promise.all(tabs.map((t) => (t.discarded ? 0 : measureHeap(t.id))));
  const entries = await logClosed(tabs, reason);
  await api.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  await addMemory(heap.reduce((a, b) => a + b, 0));
  if (notify) await notifyUndo(entries, message);
  return entries;
}

export async function notifyUndo(entries, message) {
  const settings = await getSettings();
  if (!settings.undoNotice || !entries.length) return;
  const id = `undo:${crypto.randomUUID()}`;
  await updateSession('undo', {}, (u) => {
    u[id] = entries.map((e) => e.id);
    const keys = Object.keys(u);
    for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete u[k];
  });
  const options = {
    type: 'basic',
    iconUrl: api.runtime.getURL('icons/icon-128.png'),
    title: 'Tabora',
    // Firefox notifications have no buttons: clicking the notice itself undoes.
    message: isFirefox ? `${message} Click to undo.` : message,
  };
  if (!isFirefox) options.buttons = [{ title: 'Undo' }];
  await api.notifications.create(id, options);
}

export async function restoreEntries(ids) {
  const wanted = new Set(ids);
  const entries = await updateLocal('closedLog', [], (log) => {
    const picked = log.filter((e) => wanted.has(e.id));
    const keep = log.filter((e) => !wanted.has(e.id));
    log.splice(0, log.length, ...keep);
    return picked;
  });
  if (!entries.length) return 0;
  await quiet(5000);
  const windows = new Set((await api.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id));
  entries.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const e of entries) {
    const props = { url: e.url, active: entries.length === 1, pinned: !!e.pinned };
    if (windows.has(e.windowId)) {
      props.windowId = e.windowId;
      if (typeof e.index === 'number') props.index = e.index;
    }
    await api.tabs.create(props).catch(() => api.tabs.create({ url: e.url }));
  }
  return entries.length;
}
