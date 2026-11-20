// Shared helpers for background, popup, options and the duplicate page.
// Chrome MV3 and Firefox both return promises; `browser` exists in Firefox only.
export const api = globalThis.browser ?? globalThis.chrome;
export const isFirefox = typeof api?.runtime?.getBrowserInfo === 'function';

export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

export const DEFAULT_TOPICS = [
  { name: 'Dev', color: 'blue', sites: ['github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'developer.mozilla.org', 'npmjs.com', 'pypi.org', 'docs.python.org', 'readthedocs.io', 'readthedocs.org', 'devdocs.io', 'codepen.io', 'codesandbox.io', 'vercel.com', 'netlify.com', 'render.com', 'railway.app', 'fly.io', 'heroku.com', 'supabase.com', 'replit.com', 'leetcode.com', 'neetcode.io', 'hackerrank.com', 'codewars.com', 'codeforces.com', 'codechef.com', 'atcoder.jp', 'hackerearth.com', 'exercism.org', 'geeksforgeeks.org', 'kaggle.com', 'localhost'] },
  { name: 'AI', color: 'purple', sites: ['chatgpt.com', 'openai.com', 'claude.ai', 'anthropic.com', 'gemini.google.com', 'perplexity.ai', 'huggingface.co', 'grok.com', 'x.ai', 'copilot.microsoft.com', 'deepseek.com', 'mistral.ai', 'meta.ai', 'poe.com', 'character.ai', 'aistudio.google.com', 'notebooklm.google.com', 'chat.qwen.ai', 'kimi.com', 'openrouter.ai', 'groq.com', 'together.ai', 'replicate.com', 'midjourney.com', 'ideogram.ai', 'leonardo.ai', 'runwayml.com', 'elevenlabs.io', 'suno.com', 'lovable.dev', 'bolt.new', 'v0.dev', 'v0.app', 'cursor.com'] },
  { name: 'Mail & Chat', color: 'green', sites: ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'proton.me', 'web.whatsapp.com', 'web.telegram.org', 'discord.com', 'slack.com', 'teams.microsoft.com'] },
  { name: 'Work', color: 'cyan', sites: ['docs.google.com', 'drive.google.com', 'calendar.google.com', 'notion.so', 'figma.com', 'trello.com', 'atlassian.net', 'airtable.com'] },
  { name: 'Video', color: 'red', sites: ['youtube.com', 'netflix.com', 'twitch.tv', 'vimeo.com', 'primevideo.com', 'disneyplus.com'] },
  { name: 'Social', color: 'pink', sites: ['x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'reddit.com', 'linkedin.com', 'tiktok.com', 'threads.net', 'threads.com', 'pinterest.com', 'snapchat.com', 'tumblr.com', 'bsky.app', 'mastodon.social'] },
  { name: 'Shopping', color: 'orange', sites: ['amazon.com', 'ebay.com', 'aliexpress.com', 'etsy.com', 'walmart.com', 'temu.com'] },
  { name: 'News', color: 'grey', sites: ['news.google.com', 'news.ycombinator.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com', 'reuters.com', 'apnews.com'] },
];

export const DEFAULTS = {
  // Duplicate tabs
  dupCheck: true,
  dupAction: 'close', // 'close' = keep the open tab, close the new copy | 'ask'
  dupIgnoreHash: true,
  dupIgnoreQuery: false,

  // Join tabs into groups
  autoGroup: true,
  groupMinTabs: 2,
  topicGroups: true,
  topics: DEFAULT_TOPICS,
  collapseInactiveGroups: true,
  tidyGroups: true, // groups side by side, loose tabs after them

  // Close tabs whose page failed to load
  closeErrorTabs: true,

  // Sleep (unload) idle tabs
  sleepEnabled: true,
  sleepMinutes: 60,

  // Close old tabs
  autoClose: true,
  autoCloseMinutes: 1440,
  autoCloseKeepGrouped: false,
  whitelist: [],

  // Tab limit per window
  tabLimitEnabled: true,
  tabLimit: 30,
  tabLimitAction: 'sleep', // 'sleep' | 'close'

  // CPU-heavy tabs
  heavyEnabled: true,
  heavyThreshold: 50, // % of the page's main thread busy
  heavySeconds: 60, // for this long
  heavyAction: 'sleep', // 'sleep' | 'close'

  undoNotice: true,
  closedLogSize: 200,
};

/* ---------- settings (local, optionally mirrored to storage.sync) ---------- */

let cache = null;
api?.storage?.onChanged?.addListener((changes) => {
  if (changes.settings || changes.syncSettings) cache = null;
});

export async function isSyncOn() {
  const { syncSettings = true } = await api.storage.local.get('syncSettings');
  return syncSettings && !!api.storage.sync;
}

export async function getSettings() {
  if (cache) return cache;
  let { settings: stored } = await api.storage.local.get('settings');
  if (await isSyncOn()) {
    try {
      const { settings: remote } = await api.storage.sync.get('settings');
      if (remote) stored = remote;
    } catch { /* sync unavailable */ }
  }
  cache = { ...DEFAULTS, ...(stored || {}) };
  return cache;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await api.storage.local.set({ settings: next });
  if (await isSyncOn()) {
    try { await api.storage.sync.set({ settings: next }); } catch (e) { console.warn('Taber: sync failed', e); }
  }
  cache = next;
  return next;
}

export async function setSync(on) {
  const current = await getSettings();
  await api.storage.local.set({ syncSettings: on, settings: current });
  cache = null;
  if (on && api.storage.sync) {
    const { settings: remote } = await api.storage.sync.get('settings');
    if (!remote) await api.storage.sync.set({ settings: current });
  }
}

/* ---------- URLs, sites, topics ---------- */

export function isWebUrl(url) {
  return typeof url === 'string' && /^(https?|ftp|file):/i.test(url);
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_eid|igshid|ref_src)$/i;

// Two URLs that normalize to the same string count as the same page.
export function normalizeUrl(url, settings = DEFAULTS) {
  try {
    const u = new URL(url);
    if (settings.dupIgnoreHash) u.hash = '';
    if (settings.dupIgnoreQuery) {
      u.search = '';
    } else {
      for (const key of [...u.searchParams.keys()]) {
        if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
      }
      u.searchParams.sort();
    }
    // http/https, www./no www., and a trailing "/" all count as the same page.
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      u.hostname = u.hostname.replace(/^www\./, '');
      const path = u.pathname.replace(/\/+$/, '');
      return `${u.host}${path}${u.search}${u.hash}`;
    }
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.href;
  } catch {
    return url;
  }
}

export function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local files';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// "google.com" matches google.com and any subdomain of it.
export function matchSite(site, pattern) {
  return site === pattern || site.endsWith('.' + pattern);
}

export function isWhitelisted(url, settings) {
  const site = siteOf(url);
  return settings.whitelist.some((w) => matchSite(site, w));
}

export function groupsSupported() {
  return typeof api.tabs?.group === 'function' && !!api.tabGroups;
}

export function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

// Which group a tab belongs in: its topic if one matches, else its site.
export function groupKeyFor(url, settings) {
  const site = siteOf(url);
  if (settings.topicGroups) {
    for (const t of settings.topics) {
      if (t.sites.some((p) => matchSite(site, p))) {
        return { title: t.name, color: GROUP_COLORS.includes(t.color) ? t.color : colorFor(t.name) };
      }
    }
  }
  return { title: site, color: colorFor(site) };
}

// Text format, one topic per line:  Dev (blue): github.com, stackoverflow.com
export function parseTopics(text) {
  const topics = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:(]+?)\s*(?:\(\s*([a-z]+)\s*\))?\s*:\s*(.*)$/i);
    if (!m) continue;
    const sites = m[3].split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    if (!sites.length) continue;
    const color = (m[2] || '').toLowerCase();
    topics.push({ name: m[1].trim(), color: GROUP_COLORS.includes(color) ? color : colorFor(m[1].trim()), sites });
  }
  return topics;
}

export function formatTopics(topics) {
  return topics.map((t) => `${t.name} (${t.color}): ${t.sites.join(', ')}`).join('\n');
}

/* ---------- misc ---------- */

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Monday of the given date's week, as YYYY-MM-DD (local time).
export function weekKey(date = new Date()) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function safeFavicon(url) {
  return typeof url === 'string' && /^(https?|data):/i.test(url) ? url : '';
}

// Popup and pages talk to the background through this.
export function send(type, payload = {}) {
  return api.runtime.sendMessage({ type, ...payload });
}
