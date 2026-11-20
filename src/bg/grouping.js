// Join tabs: group by topic (Dev, Video, …) or by site; collapse inactive groups.
import { api, getSettings, isWebUrl, groupsSupported, groupKeyFor } from '../shared.js';

const isGrouped = (t) => t.groupId !== undefined && t.groupId !== -1;

function keyed(tabs, settings) {
  const map = new Map();
  for (const t of tabs) {
    if (t.pinned || !isWebUrl(t.url)) continue;
    const key = groupKeyFor(t.url, settings);
    if (!map.has(key.title)) map.set(key.title, { ...key, tabs: [] });
    map.get(key.title).tabs.push(t);
  }
  return map;
}

async function findGroup(windowId, title) {
  const groups = await api.tabGroups.query({ windowId });
  return groups.find((g) => g.title === title) ?? null;
}

async function joinGroup(windowId, key, tabIds) {
  const existing = await findGroup(windowId, key.title);
  if (existing) {
    await api.tabs.group({ tabIds, groupId: existing.id });
    return existing.id;
  }
  const groupId = await api.tabs.group({ tabIds, createProperties: { windowId } });
  await api.tabGroups.update(groupId, { title: key.title, color: key.color });
  return groupId;
}

// Groups Taber made: titled with a site name or a topic name.
function isTaberTitle(title, settings) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(title) ||
    title === 'localhost' || title === 'local files' ||
    settings.topics.some((t) => t.name === title);
}

// Without tab groups, "join" means: move same-group tabs next to each other.
async function clusterWindow(windowId, settings) {
  const tabs = await api.tabs.query({ windowId });
  const pinned = tabs.filter((t) => t.pinned).length;
  const order = [];
  const buckets = new Map();
  for (const t of tabs) {
    if (t.pinned) continue;
    const key = isWebUrl(t.url) ? groupKeyFor(t.url, settings).title : '￿';
    if (!buckets.has(key)) { buckets.set(key, []); order.push(key); }
    buckets.get(key).push(t);
  }
  // Clusters first, then tabs that have no partner, so no lone tab sits between clusters.
  if (settings.tidyGroups) {
    const isCluster = (k) => k !== '￿' && buckets.get(k).length >= settings.groupMinTabs;
    order.sort((a, b) => isCluster(b) - isCluster(a));
  }
  let index = pinned;
  for (const key of order) {
    for (const t of buckets.get(key)) {
      if (t.index !== index) await api.tabs.move(t.id, { index }).catch(() => {});
      index++;
    }
  }
}

/* ---------- keep groups side by side ---------- */

// Pinned tabs, then every group in its current order, then the loose tabs.
export async function tidyWindow(windowId) {
  if (!groupsSupported()) return;
  const tabs = (await api.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const pinned = tabs.filter((t) => t.pinned).length;
  const order = [];
  for (const t of tabs) if (!t.pinned && isGrouped(t) && !order.includes(t.groupId)) order.push(t.groupId);
  if (!order.length) return;
  const wanted = [
    ...order.flatMap((g) => tabs.filter((t) => t.groupId === g)),
    ...tabs.filter((t) => !t.pinned && !isGrouped(t)),
  ];
  if (wanted.every((t, i) => t.index === pinned + i)) return;
  // Each group moves left (or stays): the slots before `index` hold groups already placed.
  let index = pinned;
  for (const groupId of order) {
    await api.tabGroups.move(groupId, { index }).catch((e) => console.warn('Taber: move group failed', e));
    index += tabs.filter((t) => t.groupId === groupId).length;
  }
}

export async function tidyAll(settings) {
  if (!settings.tidyGroups) return;
  const windows = await api.windows.getAll({ windowTypes: ['normal'] });
  for (const win of windows) {
    if (groupsSupported()) await tidyWindow(win.id).catch(() => {});
    else if (settings.autoGroup) await clusterWindow(win.id, settings).catch(() => {});
  }
}

export async function groupAll() {
  const settings = await getSettings();
  const windows = await api.windows.getAll({ windowTypes: ['normal'] });
  let groups = 0;
  for (const win of windows) {
    if (!groupsSupported()) { await clusterWindow(win.id, settings); continue; }
    const tabs = await api.tabs.query({ windowId: win.id });
    for (const key of keyed(tabs, settings).values()) {
      if (key.tabs.length < settings.groupMinTabs) continue;
      await joinGroup(win.id, key, key.tabs.map((t) => t.id));
      groups++;
    }
    if (settings.tidyGroups) await tidyWindow(win.id);
    await collapseInactiveIn(win.id);
  }
  return { ok: true, groups, native: groupsSupported() };
}

export async function ungroupAll() {
  if (!groupsSupported()) return { ok: true, count: 0 };
  const tabs = await api.tabs.query({});
  const ids = tabs.filter(isGrouped).map((t) => t.id);
  if (ids.length) await api.tabs.ungroup(ids);
  return { ok: true, count: ids.length };
}

/* ---------- automatic grouping after navigation ---------- */

const pendingWindows = new Set();
let autoTimer;
export function scheduleAutoGroup(windowId) {
  pendingWindows.add(windowId);
  clearTimeout(autoTimer);
  autoTimer = setTimeout(runAutoGroup, 500);
}

async function runAutoGroup() {
  const settings = await getSettings();
  const windows = [...pendingWindows];
  pendingWindows.clear();
  if (!settings.autoGroup && !settings.tidyGroups) return;
  for (const windowId of windows) {
    try {
      if (!groupsSupported()) {
        if (settings.autoGroup) await clusterWindow(windowId, settings);
        continue;
      }
      if (!settings.autoGroup) { await tidyWindow(windowId); continue; }
      const tabs = await api.tabs.query({ windowId });
      const titles = new Map((await api.tabGroups.query({ windowId })).map((g) => [g.id, g.title]));
      for (const key of keyed(tabs, settings).values()) {
        if (key.tabs.length < settings.groupMinTabs) continue;
        const target = await findGroup(windowId, key.title);
        // Leave tabs alone that the user put into a group of their own.
        const ids = key.tabs
          .filter((t) => !isGrouped(t) || isTaberTitle(titles.get(t.groupId) ?? '', settings))
          .filter((t) => !target || t.groupId !== target.id)
          .map((t) => t.id);
        if (ids.length) await joinGroup(windowId, key, ids);
      }
      if (settings.tidyGroups) await tidyWindow(windowId);
      await collapseInactiveIn(windowId);
    } catch (e) {
      console.warn('Taber: auto-group failed', e);
    }
  }
}

/* ---------- collapse every group except the one you are in ---------- */

export async function collapseInactive(tabId, windowId) {
  const settings = await getSettings();
  if (!settings.collapseInactiveGroups || !groupsSupported()) return;
  let tab;
  try { tab = await api.tabs.get(tabId); } catch { return; }
  const groups = await api.tabGroups.query({ windowId });
  for (const g of groups) {
    const collapse = g.id !== tab.groupId;
    if (g.collapsed !== collapse) await api.tabGroups.update(g.id, { collapsed: collapse }).catch(() => {});
  }
}

async function collapseInactiveIn(windowId) {
  const [active] = await api.tabs.query({ windowId, active: true });
  if (active) await collapseInactive(active.id, windowId);
}

/* ---------- merge windows ---------- */

export async function mergeWindows() {
  const current = await api.windows.getLastFocused({ windowTypes: ['normal'] });
  const windows = await api.windows.getAll({ windowTypes: ['normal'], populate: true });
  let moved = 0;
  for (const win of windows) {
    if (win.id === current.id || win.incognito !== current.incognito) continue;
    if (groupsSupported()) {
      for (const g of await api.tabGroups.query({ windowId: win.id })) {
        await api.tabGroups.move(g.id, { windowId: current.id, index: -1 }).catch(() => {});
      }
    }
    const rest = (await api.tabs.query({ windowId: win.id })).filter((t) => !t.pinned);
    if (rest.length) await api.tabs.move(rest.map((t) => t.id), { windowId: current.id, index: -1 });
    moved += win.tabs.length;
  }
  return { ok: true, moved };
}
