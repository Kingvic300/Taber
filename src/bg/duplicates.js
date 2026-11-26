// "This page is already open": go to the open tab, or open a new copy.
import { api, getSettings, isWebUrl, normalizeUrl } from '../shared.js';
import { bumpStat, closeTabsLogged, isQuiet, sessionGet, tabNames, updateSession } from './util.js';

const DUP_PAGE = api.runtime.getURL('src/duplicate.html');

// onBeforeNavigate fires before the page commits, so swapping the tab to
// the prompt page leaves no history entry for the duplicate URL.
export async function onBeforeNavigate(details) {
  if (details.frameId !== 0 || details.tabId < 0) return;
  if (details.documentLifecycle === 'prerender') return;
  if (!isWebUrl(details.url)) return;

  const settings = await getSettings();
  if (!settings.dupCheck || await isQuiet()) return;

  const tabId = details.tabId;
  const norm = normalizeUrl(details.url, settings);

  // "Open new copy" was chosen for this URL in this tab: allow until it leaves.
  const allowed = await updateSession('bypass', {}, (b) => {
    if (b[tabId] === norm) return true;
    delete b[tabId];
    return false;
  });
  if (allowed) return;

  let self;
  try { self = await api.tabs.get(tabId); } catch { return; }

  // Reload or in-page navigation of the same page is not a new duplicate.
  if (isWebUrl(self.url) && normalizeUrl(self.url, settings) === norm) return;

  const tabs = await api.tabs.query({});
  const copies = tabs.filter((t) =>
    t.id !== tabId &&
    t.incognito === self.incognito &&
    isWebUrl(t.url) &&
    normalizeUrl(t.url, settings) === norm);
  if (!copies.length) return;
  const existing = copies.find((t) => t.pinned) ?? copies[0];

  // "Fresh" = a new tab (blank or new-tab page).
  const fresh = !isWebUrl(self.url);

  if (settings.dupAction !== 'ask') {
    if (fresh) {
      // New tab for a page that is already open: close it, keep the open tab.
      try { await api.tabs.remove(tabId); } catch { return; }
      if (self.active) await focusTab(existing);
      bumpStat('dup_avoided');
    } else {
      // An older tab moves to a page open elsewhere: keep this tab (the user
      // is navigating in it) and close the other copies. Pinned ones stay.
      await closeCopies(copies.filter((t) => !t.pinned));
    }
    return;
  }

  // Ask: on "go to open tab" a fresh tab closes; an older tab goes back to
  // the page it showed before.
  const params = new URLSearchParams({
    url: details.url,
    existing: String(existing.id),
    fresh: fresh ? '1' : '0',
  });
  try {
    await api.tabs.update(tabId, { url: `${DUP_PAGE}?${params}` });
    bumpStat('dup_prompts');
  } catch { /* tab closed meanwhile */ }
}

async function focusTab(tab) {
  await api.tabs.update(tab.id, { active: true }).catch(() => {});
  await api.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

async function closeCopies(victims) {
  if (!victims.length) return;
  const n = victims.length;
  const message = `Closed ${n} duplicate tab${n === 1 ? '' : 's'}: ${tabNames(victims)}.`;
  await closeTabsLogged(victims, 'duplicate', { notify: true, message });
}

/* ---------- copies that skip onBeforeNavigate ---------- */

// "Duplicate tab", tabs opened straight to a URL, and in-page (history API)
// navigation never pass through the check above. Catch them once the URL
// changes: keep the tab the user is on, else the copy that was open first.
const changed = new Set();
let changedTimer;
export function onUrlChanged(tabId) {
  changed.add(tabId);
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => dedupeChanged().catch((e) => console.warn('Tabora: duplicate check failed', e)), 1000);
}

async function dedupeChanged() {
  const ids = new Set(changed);
  changed.clear();
  const settings = await getSettings();
  if (!settings.dupCheck || settings.dupAction === 'ask' || await isQuiet()) return;
  const bypass = await sessionGet('bypass', {});
  const tabs = await api.tabs.query({});
  const victims = new Map();
  for (const id of ids) {
    const self = tabs.find((t) => t.id === id);
    if (!self || victims.has(id) || !isWebUrl(self.url)) continue;
    const norm = normalizeUrl(self.url, settings);
    if (bypass[id] === norm) continue;
    const copies = tabs.filter((t) =>
      t.id !== id && !victims.has(t.id) &&
      t.incognito === self.incognito &&
      isWebUrl(t.url) &&
      normalizeUrl(t.url, settings) === norm &&
      bypass[t.id] !== norm);
    if (!copies.length) continue;
    if (self.active || self.pinned) {
      for (const t of copies) if (!t.pinned && !t.active) victims.set(t.id, t);
    } else {
      victims.set(id, self);
    }
  }
  if (victims.size) {
    await closeCopies([...victims.values()]);
  }
}

export async function forgetTab(tabId) {
  await updateSession('bypass', {}, (b) => { delete b[tabId]; });
}

export async function dupSwitch(selfTab, existingId, fresh) {
  let existing;
  try { existing = await api.tabs.get(existingId); } catch { return { gone: true }; }
  await api.tabs.update(existing.id, { active: true });
  await api.windows.update(existing.windowId, { focused: true });
  if (selfTab) {
    if (fresh) await api.tabs.remove(selfTab.id);
    else await api.tabs.goBack(selfTab.id).catch(() => api.tabs.remove(selfTab.id));
  }
  bumpStat('dup_avoided');
  return { ok: true };
}

export async function dupOpenAnyway(selfTab, url) {
  const settings = await getSettings();
  const norm = normalizeUrl(url, settings);
  await updateSession('bypass', {}, (b) => { b[selfTab.id] = norm; });
  await api.tabs.update(selfTab.id, { url });
  return { ok: true };
}

export async function closeDuplicates(closeTabsLogged) {
  const settings = await getSettings();
  const tabs = await api.tabs.query({});
  const buckets = new Map();
  for (const t of tabs) {
    if (!isWebUrl(t.url)) continue;
    const key = `${t.incognito}|${normalizeUrl(t.url, settings)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const victims = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    // Keep the pinned, active or most recently used copy.
    list.sort((a, b) =>
      (b.pinned - a.pinned) || (b.active - a.active) || ((b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)));
    victims.push(...list.slice(1).filter((t) => !t.pinned));
  }
  await closeTabsLogged(victims, 'duplicate');
  return { ok: true, closed: victims.length };
}
