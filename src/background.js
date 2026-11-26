// Tabora background: wires browser events to the feature modules.
import { api, getSettings, isFirefox, isWebUrl, saveSettings, siteOf } from './shared.js';
import { countVisit, closeTabsLogged, restoreEntries, sessionGet, updateSession } from './bg/util.js';
import { onBeforeNavigate, onUrlChanged, forgetTab, dupSwitch, dupOpenAnyway, closeDuplicates } from './bg/duplicates.js';
import { groupAll, ungroupAll, mergeWindows, scheduleAutoGroup, collapseInactive } from './bg/grouping.js';
import { onNavigationError, cancelErrorClose } from './bg/errors.js';
import { noteUse, noteTabReturn, forgetTabUses } from './bg/usage.js';
import { sweep, closeOldNow, sleepOthers, scheduleTabLimit, onProbe, forgetHeavy } from './bg/cleanup.js';
import {
  saveSession, openSession, deleteSession, snoozeTab, wakeSnoozed, cancelSnooze,
  rescheduleSnoozes, importData,
} from './bg/sessions.js';

const SWEEP_ALARM = 'taber-sweep';

/* ---------- lifecycle ---------- */

// Re-creating an alarm restarts its timer, so only create it when missing.
async function ensureAlarm() {
  const existing = await api.alarms.get(SWEEP_ALARM);
  if (!existing || existing.periodInMinutes !== 1) api.alarms.create(SWEEP_ALARM, { periodInMinutes: 1 });
}

// Content scripts only load into pages opened after install; add the CPU
// probe to pages that were already open.
async function injectProbes() {
  if (!api.scripting) return;
  const tabs = await api.tabs.query({});
  for (const t of tabs) {
    if (!isWebUrl(t.url) || t.discarded) continue;
    api.scripting.executeScript({ target: { tabId: t.id }, files: ['src/probe.js'] }).catch(() => {});
  }
}

// Saved settings keep their own copy of the topics. Bring older copies up to
// date without undoing the user's own edits.
// topicsVersion 2: YouTube moved from Video to Social.
async function migrateSettings() {
  const s = await getSettings();
  if ((s.topicsVersion ?? 1) >= 2) return;
  const topics = structuredClone(s.topics);
  const video = topics.find((t) => t.name === 'Video');
  const social = topics.find((t) => t.name === 'Social');
  if (video?.sites.includes('youtube.com') && social) {
    video.sites = video.sites.filter((x) => x !== 'youtube.com');
    for (const x of ['youtube.com', 'youtu.be']) if (!social.sites.includes(x)) social.sites.push(x);
  }
  await saveSettings({ topics, topicsVersion: 2 });
}

api.runtime.onInstalled.addListener(() => {
  migrateSettings().catch((e) => console.warn('Tabora: settings update failed', e));
  ensureAlarm();
  updateBadge();
  injectProbes();
  rescheduleSnoozes();
});
api.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
  rescheduleSnoozes();
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sweep().catch((e) => console.warn('Tabora: sweep failed', e));
  else if (alarm.name.startsWith('snooze:')) wakeSnoozed(alarm.name.slice(7));
});

/* ---------- badge: live tab count ---------- */

let badgeTimer;
function updateBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    const tabs = await api.tabs.query({});
    await api.action.setBadgeText({ text: String(tabs.length) });
    await api.action.setBadgeBackgroundColor({ color: '#4338ca' });
    api.action.setBadgeTextColor?.({ color: '#ffffff' });
  }, 250);
}

/* ---------- tab and navigation events ---------- */

api.tabs.onCreated.addListener(() => {
  updateBadge();
  scheduleTabLimit();
});

api.tabs.onRemoved.addListener((tabId) => {
  updateBadge();
  forgetTab(tabId);
  forgetHeavy(tabId);
  forgetTabUses(tabId);
  cancelErrorClose(tabId);
});

api.tabs.onActivated.addListener(({ tabId, windowId }) => {
  collapseInactive(tabId, windowId);
  scheduleTabLimit(); // a woken tab counts as awake again
  noteTabReturn(tabId);
  api.tabs.get(tabId).then((t) => noteUse(t.url), () => {});
});

api.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && isWebUrl(info.url)) {
    scheduleAutoGroup(tab.windowId);
    onUrlChanged(tabId);
  }
});

api.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) cancelErrorClose(d.tabId); // a new load or retry started
  onBeforeNavigate(d).catch((e) => console.warn('Tabora: duplicate check failed', e));
});

api.webNavigation.onErrorOccurred.addListener(onNavigationError);

api.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !isWebUrl(d.url) || d.documentLifecycle === 'prerender') return;
  if (d.transitionType === 'reload' || d.transitionQualifiers?.includes('forward_back')) return;
  countVisit(siteOf(d.url));
  noteUse(d.url);
});

/* ---------- notifications: undo, snooze wake ---------- */

async function undo(notificationId) {
  const ids = await updateSession('undo', {}, (u) => {
    const list = u[notificationId];
    delete u[notificationId];
    return list;
  });
  if (ids?.length) await restoreEntries(ids);
  api.notifications.clear(notificationId);
}

api.notifications.onClicked.addListener(async (id) => {
  if (id.startsWith('undo:')) {
    // Chrome has an Undo button; Firefox has no buttons, so a click undoes.
    if (isFirefox) await undo(id);
    else api.notifications.clear(id);
  } else if (id.startsWith('wake:')) {
    const tabId = Number(id.slice(5));
    try {
      const tab = await api.tabs.update(tabId, { active: true });
      await api.windows.update(tab.windowId, { focused: true });
    } catch { /* tab closed */ }
    api.notifications.clear(id);
  } else {
    api.notifications.clear(id);
  }
});

api.notifications.onButtonClicked?.addListener((id) => {
  if (id.startsWith('undo:')) undo(id);
});

/* ---------- messages from popup, pages and the probe ---------- */

const handlers = {
  // duplicate prompt page
  dupSwitch: (m, s) => dupSwitch(s.tab, m.existingId, m.fresh),
  dupOpenAnyway: (m, s) => dupOpenAnyway(s.tab, m.url),

  // probe.js
  probe: async (m, s) => { await onProbe(s.tab, m.ratio, m.seconds); return { ok: true }; },

  // popup actions
  groupAll: () => groupAll(),
  ungroupAll: () => ungroupAll(),
  mergeWindows: () => mergeWindows(),
  closeOld: () => closeOldNow(),
  closeDuplicates: () => closeDuplicates(closeTabsLogged),
  sleepOthers: (m) => sleepOthers(m.windowId),
  closeTabs: async (m) => {
    const tabs = (await Promise.all(m.tabIds.map((id) => api.tabs.get(id).catch(() => null)))).filter(Boolean);
    await closeTabsLogged(tabs, 'manual');
    return { ok: true };
  },
  restore: async (m) => ({ ok: true, restored: await restoreEntries([m.id]) }),
  clearLog: async () => { await api.storage.local.set({ closedLog: [] }); return { ok: true }; },

  // sessions and snooze
  saveSession: (m) => saveSession(m),
  openSession: (m) => openSession(m.id),
  deleteSession: (m) => deleteSession(m.id),
  snooze: (m) => snoozeTab(m.tabId, m.wakeAt),
  wakeNow: (m) => wakeSnoozed(m.id, { active: true, notify: false }),
  cancelSnooze: (m) => cancelSnooze(m.id),
  importData: (m) => importData(m.data),

  heavyState: () => sessionGet('heavy', {}),
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // keep the channel open for the async answer
});

ensureAlarm();
