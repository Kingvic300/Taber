// Close tabs whose page failed to load ("Problem loading page" in Firefox,
// "This site can't be reached" in Chrome).
import { api, getSettings, isWebUrl, isWhitelisted } from '../shared.js';
import { closeTabsLogged, tabNames } from './util.js';

// Wait this long after a failed load before closing, so a retry can win.
const DELAY_MS = 2000;

// Firefox's error page title (English). Used for error tabs that were already
// open, for example after a restart. Chrome error pages keep the site as title.
const ERROR_TITLES = new Set(['Problem loading page', 'Server Not Found']);

// Errors that do not show an error page: the load was stopped, replaced by
// another load, or turned into a download.
const IGNORED = [
  /ERR_ABORTED/i,
  /NS_BINDING_(ABORTED|REDIRECTED|RETARGETED)/i,
  /NS_ERROR_ABORT/i,
  /\b(2152398850|2152398851|2152398852|2147500036)\b/, // the same Firefox codes as numbers
];

// Certificate warnings: the user may want to continue to the site, so keep them.
function isCertError(error) {
  if (/ERR_(CERT|SSL)_|SEC_ERROR|SSL_ERROR|MOZILLA_PKIX/i.test(error)) return true;
  const code = Number(error.match(/\b(\d{10})\b/)?.[1]);
  return code >= 0x805A0000 && code <= 0x805AFFFF; // Firefox security module
}

function shouldIgnore(error = '') {
  return IGNORED.some((re) => re.test(error)) || isCertError(error);
}

// A dropped connection fails every tab at once. Closing them all would lose them.
const online = () => globalThis.navigator?.onLine !== false;

function closable(t, settings) {
  return !t.pinned && !t.audible && isWebUrl(t.url) && !isWhitelisted(t.url, settings);
}

const pending = new Map(); // tabId -> timer

export function cancelErrorClose(tabId) {
  clearTimeout(pending.get(tabId));
  pending.delete(tabId);
}

export function onNavigationError(d) {
  if (d.frameId !== 0 || !isWebUrl(d.url) || shouldIgnore(d.error)) return;
  cancelErrorClose(d.tabId);
  pending.set(d.tabId, setTimeout(() => {
    pending.delete(d.tabId);
    closeFailed(d.tabId, d.url).catch((e) => console.warn('Taber: close error tab failed', e));
  }, DELAY_MS));
}

async function closeFailed(tabId, url) {
  const settings = await getSettings();
  if (!settings.closeErrorTabs || !online()) return;
  let tab;
  try { tab = await api.tabs.get(tabId); } catch { return; }
  if (tab.url !== url || !closable(tab, settings)) return;
  await closeTabsLogged([tab], 'error', {
    notify: true,
    message: `Closed "${(tab.title || tab.url).slice(0, 60)}": the page did not load.`,
  });
}

// Sweep: error tabs that were already open (Firefox only; matched by title).
export async function closeErrorTabs(settings) {
  if (!settings.closeErrorTabs || !online()) return 0;
  const tabs = await api.tabs.query({});
  const victims = tabs.filter((t) =>
    ERROR_TITLES.has(t.title) && t.status === 'complete' && !pending.has(t.id) && closable(t, settings));
  await closeTabsLogged(victims, 'error', {
    notify: true,
    message: `Closed ${victims.length} tab${victims.length === 1 ? '' : 's'} that did not load: ${tabNames(victims)}.`,
  });
  return victims.length;
}
