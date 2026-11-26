// Smart keep: learn which sites and tabs you use most, so cleanup keeps them.
import { api, isWebUrl, siteOf, topUsedSites, usageScore } from '../shared.js';
import { sessionGet, updateLocal, updateSession } from './util.js';

const MAX_SITES = 300;
const KEEP_SITES_AFTER_PRUNE = 200;
const TAB_RETURN_WINDOW_MS = 7 * 864e5; // a tab you kept returning to, but not for a week, is no longer kept

/* ---------- site use: switching to a tab or opening a page in it ---------- */

const pending = new Map();
let timer;

export function noteUse(url) {
  if (!isWebUrl(url)) return;
  const site = siteOf(url);
  if (!site) return;
  pending.set(site, (pending.get(site) || 0) + 1);
  clearTimeout(timer);
  timer = setTimeout(flushUses, 2000);
}

export function flushUses() {
  clearTimeout(timer);
  if (!pending.size) return Promise.resolve();
  const batch = new Map(pending);
  pending.clear();
  return updateLocal('usage', {}, (u) => {
    const now = Date.now();
    for (const [site, n] of batch) u[site] = { score: usageScore(u[site], now) + n, at: now };
    const sites = Object.keys(u);
    if (sites.length > MAX_SITES) {
      sites.sort((a, b) => usageScore(u[b], now) - usageScore(u[a], now));
      for (const site of sites.slice(KEEP_SITES_AFTER_PRUNE)) delete u[site];
    }
  });
}

/* ---------- tab returns: how often you switched to one tab ---------- */

export function noteTabReturn(tabId) {
  return updateSession('tabUses', {}, (u) => { u[tabId] = (u[tabId] || 0) + 1; });
}

export function forgetTabUses(tabId) {
  return updateSession('tabUses', {}, (u) => { delete u[tabId]; });
}

/* ---------- the test cleanup uses ---------- */

// Returns a function that says whether a tab is one you use a lot.
export async function keeper(settings) {
  if (!settings.smartKeep) return () => false;
  await flushUses();
  const { usage = {} } = await api.storage.local.get('usage');
  const top = new Set(topUsedSites(usage, settings.smartKeepSites));
  const uses = await sessionGet('tabUses', {});
  const recent = Date.now() - TAB_RETURN_WINDOW_MS;
  return (t) => top.has(siteOf(t.url)) ||
    ((uses[t.id] || 0) >= settings.smartKeepReturns && (t.lastAccessed ?? 0) > recent);
}
