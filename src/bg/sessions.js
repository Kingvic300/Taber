// Saved sessions, snoozed tabs, import.
import { api, groupsSupported, isFirefox, isWebUrl, safeFavicon } from '../shared.js';
import { bumpStat, quiet, updateLocal } from './util.js';

/* ---------- saved sessions ---------- */

export async function saveSession({ name, windowId, scope, close }) {
  const windows = scope === 'all'
    ? await api.windows.getAll({ windowTypes: ['normal'], populate: true })
    : [await api.windows.get(windowId, { populate: true })];

  const saved = [];
  const closeIds = [];
  for (const w of windows) {
    const groups = groupsSupported() ? await api.tabGroups.query({ windowId: w.id }) : [];
    const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
    const tabs = w.tabs.filter((t) => isWebUrl(t.url)).map((t) => ({
      url: t.url,
      title: t.title || t.url,
      favIconUrl: safeFavicon(t.favIconUrl),
      pinned: !!t.pinned,
      group: groupIndex.has(t.groupId) ? groupIndex.get(t.groupId) : null,
    }));
    if (!tabs.length) continue;
    saved.push({
      tabs,
      groups: groups.map((g) => ({ title: g.title ?? '', color: g.color, collapsed: !!g.collapsed })),
    });
    closeIds.push(...w.tabs.filter((t) => isWebUrl(t.url) && !t.pinned).map((t) => t.id));
  }
  if (!saved.length) return { ok: false, error: 'No web pages to save' };

  const count = saved.reduce((n, w) => n + w.tabs.length, 0);
  const session = {
    id: crypto.randomUUID(),
    name: name?.trim() || `${count} tabs · ${new Date().toLocaleString()}`,
    createdAt: Date.now(),
    windows: saved,
  };
  await updateLocal('sessions', [], (list) => { list.unshift(session); });

  if (close && closeIds.length) {
    // Keep one tab open so the browser does not quit.
    await api.tabs.create({ windowId: windows[0].id, active: true });
    await api.tabs.remove(closeIds).catch(() => {});
  }
  return { ok: true, count };
}

export async function openSession(id) {
  const { sessions = [] } = await api.storage.local.get('sessions');
  const session = sessions.find((s) => s.id === id);
  if (!session) return { ok: false, error: 'Session not found' };
  await quiet(10_000);

  for (const w of session.windows) {
    const win = await api.windows.create({ focused: true });
    const [blank] = await api.tabs.query({ windowId: win.id });
    const created = [];
    for (const [i, t] of w.tabs.entries()) {
      const props = { windowId: win.id, url: t.url, pinned: t.pinned, active: i === 0 };
      // Firefox can create tabs unloaded; they load when clicked.
      if (isFirefox && i > 0 && !t.pinned) Object.assign(props, { discarded: true, title: t.title });
      try {
        created.push({ tab: await api.tabs.create(props), group: t.group });
      } catch {
        try { created.push({ tab: await api.tabs.create({ windowId: win.id, url: t.url }), group: t.group }); } catch { /* blocked URL */ }
      }
    }
    if (blank && created.length) await api.tabs.remove(blank.id).catch(() => {});

    if (groupsSupported()) {
      for (const [gi, g] of (w.groups ?? []).entries()) {
        const ids = created.filter((c) => c.group === gi && !c.tab.pinned).map((c) => c.tab.id);
        if (!ids.length) continue;
        try {
          const groupId = await api.tabs.group({ tabIds: ids, createProperties: { windowId: win.id } });
          await api.tabGroups.update(groupId, { title: g.title, color: g.color, collapsed: g.collapsed });
        } catch { /* groups unsupported here */ }
      }
    }
  }
  return { ok: true };
}

export async function deleteSession(id) {
  await updateLocal('sessions', [], (list) => {
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list.splice(i, 1);
  });
  return { ok: true };
}

/* ---------- snooze ---------- */

const alarmName = (id) => `snooze:${id}`;

export async function snoozeTab(tabId, wakeAt) {
  const tab = await api.tabs.get(tabId);
  if (!isWebUrl(tab.url)) return { ok: false, error: 'Only web pages can be snoozed' };
  const item = {
    id: crypto.randomUUID(),
    url: tab.url,
    title: tab.title || tab.url,
    favIconUrl: safeFavicon(tab.favIconUrl),
    wakeAt,
    snoozedAt: Date.now(),
  };
  await updateLocal('snoozed', [], (list) => { list.push(item); });
  await api.alarms.create(alarmName(item.id), { when: wakeAt });
  await api.tabs.remove(tabId);
  await bumpStat('snoozed');
  return { ok: true };
}

export async function wakeSnoozed(id, { active = false, notify = true } = {}) {
  await api.alarms.clear(alarmName(id));
  const item = await updateLocal('snoozed', [], (list) => {
    const i = list.findIndex((s) => s.id === id);
    return i >= 0 ? list.splice(i, 1)[0] : null;
  });
  if (!item) return { ok: false };
  await quiet(3000);
  const tab = await api.tabs.create({ url: item.url, active });
  if (notify) {
    api.notifications.create(`wake:${tab.id}`, {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.png'),
      title: 'Back from snooze',
      message: item.title,
    });
  }
  return { ok: true };
}

export async function cancelSnooze(id) {
  await api.alarms.clear(alarmName(id));
  await updateLocal('snoozed', [], (list) => {
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) list.splice(i, 1);
  });
  return { ok: true };
}

// Firefox drops alarms on restart; Chrome may too after updates.
export async function rescheduleSnoozes() {
  const { snoozed = [] } = await api.storage.local.get('snoozed');
  const now = Date.now();
  for (const item of snoozed) {
    if (item.wakeAt <= now) await wakeSnoozed(item.id);
    else await api.alarms.create(alarmName(item.id), { when: item.wakeAt });
  }
}

/* ---------- import (from options page backup file) ---------- */

export async function importData(data) {
  let sessions = 0;
  let snoozed = 0;
  const incoming = Array.isArray(data.sessions) ? data.sessions.filter(validSession) : [];
  if (Array.isArray(data.openTabs) && data.openTabs.length) {
    const windows = data.openTabs
      .map((w) => ({ tabs: (w.tabs ?? []).filter((t) => isWebUrl(t.url)).map((t) => ({ ...t, group: null })), groups: [] }))
      .filter((w) => w.tabs.length);
    if (windows.length) {
      incoming.push({
        id: crypto.randomUUID(),
        name: `Imported tabs · ${new Date(data.exportedAt || Date.now()).toLocaleString()}`,
        createdAt: Date.now(),
        windows,
      });
    }
  }
  await updateLocal('sessions', [], (list) => {
    const have = new Set(list.map((s) => s.id));
    for (const s of incoming) if (!have.has(s.id)) { list.push(s); sessions++; }
    list.sort((a, b) => b.createdAt - a.createdAt);
  });
  if (Array.isArray(data.snoozed)) {
    await updateLocal('snoozed', [], (list) => {
      const have = new Set(list.map((s) => s.id));
      for (const s of data.snoozed) {
        if (s?.id && isWebUrl(s.url) && typeof s.wakeAt === 'number' && !have.has(s.id)) { list.push(s); snoozed++; }
      }
    });
    await rescheduleSnoozes();
  }
  return { ok: true, sessions, snoozed };
}

function validSession(s) {
  return s && typeof s.id === 'string' && Array.isArray(s.windows) &&
    s.windows.every((w) => Array.isArray(w.tabs) && w.tabs.every((t) => isWebUrl(t.url)));
}
