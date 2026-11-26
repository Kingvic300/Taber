// Sleep idle tabs, close old tabs, enforce the tab limit, calm CPU-heavy tabs.
import { api, getSettings, isWebUrl, isWhitelisted } from '../shared.js';
import { addMemory, bumpStat, closeTabsLogged, measureHeap, tabNames, updateSession } from './util.js';
import { closeErrorTabs } from './errors.js';
import { tidyAll } from './grouping.js';
import { keeper } from './usage.js';

const isGrouped = (t) => t.groupId !== undefined && t.groupId !== -1;

// Tabs Tabora never sleeps or closes on its own.
function isProtected(t, settings) {
  return t.pinned || t.active || t.audible || !isWebUrl(t.url) || isWhitelisted(t.url, settings);
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function durationText(min) {
  if (min % 1440 === 0) return plural(min / 1440, 'day');
  if (min % 60 === 0) return plural(min / 60, 'hour');
  return plural(min, 'minute');
}

/* ---------- sleep = unload the page, keep the tab ---------- */

export async function sleepTabs(tabs, statField = 'slept') {
  let count = 0;
  let mb = 0;
  for (const t of tabs) {
    if (t.discarded || t.active || t.autoDiscardable === false) continue;
    const heap = await measureHeap(t.id);
    try {
      await api.tabs.discard(t.id);
      count++;
      mb += heap;
    } catch { /* tab busy or gone */ }
  }
  await bumpStat(statField, count);
  await addMemory(mb);
  return count;
}

export async function sleepOthers(windowId) {
  const settings = await getSettings();
  const tabs = await api.tabs.query(windowId ? { windowId } : {});
  const n = await sleepTabs(tabs.filter((t) => !isProtected(t, settings)));
  return { ok: true, slept: n };
}

/* ---------- close old tabs ---------- */

export async function closeOld(settings, notify) {
  const cutoff = Date.now() - settings.autoCloseMinutes * 60_000;
  const tabs = await api.tabs.query({});
  const kept = await keeper(settings); // tabs you use most stay open
  const victims = tabs.filter((t) =>
    !isProtected(t, settings) && !kept(t) &&
    t.lastAccessed && t.lastAccessed < cutoff &&
    !(settings.autoCloseKeepGrouped && isGrouped(t)));
  await closeTabsLogged(victims, 'stale', {
    notify,
    message: `Closed ${plural(victims.length, 'tab')} you had not used for ${durationText(settings.autoCloseMinutes)}: ${tabNames(victims)}.`,
  });
  return victims.length;
}

export async function closeOldNow() {
  const settings = await getSettings();
  return { ok: true, closed: await closeOld(settings, false) };
}

/* ---------- tab limit per window ---------- */

export async function enforceTabLimit() {
  const settings = await getSettings();
  if (!settings.tabLimitEnabled) return;
  const windows = await api.windows.getAll({ windowTypes: ['normal'], populate: true });
  const closing = settings.tabLimitAction === 'close';
  const kept = await keeper(settings);
  const toClose = [];
  for (const w of windows) {
    // When sleeping, the limit counts awake tabs; when closing, all tabs.
    const counted = w.tabs.filter((t) => !t.pinned && (closing || !t.discarded));
    const excess = counted.length - settings.tabLimit;
    if (excess <= 0) continue;
    // Tabs you use most are never closed, and are the last to be put to sleep.
    const oldest = counted
      .filter((t) => !isProtected(t, settings) && !(closing && kept(t)))
      .sort((a, b) => kept(a) - kept(b) || (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0))
      .slice(0, excess);
    if (closing) toClose.push(...oldest);
    else await sleepTabs(oldest, 'slept_limit');
  }
  if (toClose.length) {
    await closeTabsLogged(toClose, 'limit', {
      notify: true,
      message: `Closed ${plural(toClose.length, 'tab')} to stay under ${settings.tabLimit} tabs per window: ${tabNames(toClose)}.`,
    });
  }
}

let limitTimer;
export function scheduleTabLimit() {
  clearTimeout(limitTimer);
  limitTimer = setTimeout(() => enforceTabLimit().catch(console.warn), 1500);
}

/* ---------- periodic sweep (every minute) ---------- */

export async function sweep() {
  const settings = await getSettings();
  await closeErrorTabs(settings);
  if (settings.autoClose) await closeOld(settings, true);
  if (settings.sleepEnabled) {
    // Tabs you use most stay awake twice as long.
    const now = Date.now();
    const idleMs = settings.sleepMinutes * 60_000;
    const kept = await keeper(settings);
    const tabs = await api.tabs.query({});
    await sleepTabs(tabs.filter((t) =>
      !isProtected(t, settings) && !t.discarded && t.lastAccessed &&
      t.lastAccessed < now - (kept(t) ? 2 * idleMs : idleMs)));
  }
  await enforceTabLimit();
  await tidyAll(settings);
}

/* ---------- CPU-heavy tabs ---------- */

// probe.js in each page reports how busy the page kept the main thread.
export async function onProbe(tab, ratio, seconds) {
  if (!tab || typeof ratio !== 'number') return;
  const settings = await getSettings();
  const busy = ratio * 100 >= settings.heavyThreshold;
  const rec = await updateSession('heavy', {}, (h) => {
    const r = h[tab.id] ?? { busySeconds: 0 };
    r.ratio = ratio;
    r.at = Date.now();
    r.busySeconds = busy ? r.busySeconds + seconds : 0;
    h[tab.id] = r;
    return { ...r };
  });
  if (!settings.heavyEnabled || rec.busySeconds < settings.heavySeconds) return;

  let current;
  try { current = await api.tabs.get(tab.id); } catch { return; }
  if (isProtected(current, settings)) return;

  await updateSession('heavy', {}, (h) => { delete h[tab.id]; });
  const title = (current.title || current.url).slice(0, 60);
  const kept = await keeper(settings);
  if (settings.heavyAction === 'close' && !kept(current)) {
    await closeTabsLogged([current], 'heavy', {
      notify: true,
      message: `Closed "${title}": it used a lot of CPU.`,
    });
  } else if (await sleepTabs([current], 'slept_heavy')) {
    if (settings.undoNotice) {
      api.notifications.create(`info:${crypto.randomUUID()}`, {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/icon-128.png'),
        title: 'Tabora',
        message: `Put "${title}" to sleep: it used a lot of CPU. Click the tab to wake it.`,
      });
    }
  }
}

export async function forgetHeavy(tabId) {
  await updateSession('heavy', {}, (h) => { delete h[tabId]; });
}
