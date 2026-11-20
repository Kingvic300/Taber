// Runs the background code against a fake browser API and checks the main flows.
// Usage: node tools/smoke-test.mjs
import assert from 'node:assert/strict';

const evt = () => {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => Promise.all(fns.map((f) => f(...a))), fns };
};
const area = () => {
  let data = {};
  return {
    async get(k) {
      if (k == null) return structuredClone(data);
      const keys = Array.isArray(k) ? k : [k];
      return structuredClone(Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, data[x]])));
    },
    async set(o) { Object.assign(data, structuredClone(o)); },
    _data: () => data,
  };
};

const DAY = 864e5;
let nextTabId = 1;
let nextGroupId = 100;
const tabs = new Map();
const groups = new Map();
const notifications = [];
const alarms = new Map();
const windows = new Set([1]);

function makeTab(p) {
  const t = {
    id: nextTabId++, windowId: 1, index: tabs.size, url: 'about:blank', title: '', active: false,
    pinned: false, audible: false, discarded: false, incognito: false, groupId: -1,
    lastAccessed: Date.now(), favIconUrl: '', ...p,
  };
  tabs.set(t.id, t);
  return t;
}
const reindex = () => {
  for (const w of windows) [...tabs.values()].filter((t) => t.windowId === w).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
};

const onMessage = evt();
const chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://taber/${p}`,
    onMessage, onInstalled: evt(), onStartup: evt(),
    getManifest: () => ({ version: 'test' }),
  },
  storage: { local: area(), session: area(), sync: area(), onChanged: evt() },
  alarms: {
    async get(n) { return alarms.get(n); },
    create(n, o) { alarms.set(n, { name: n, ...o }); },
    async clear(n) { return alarms.delete(n); },
    onAlarm: evt(),
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
  notifications: {
    async create(id, o) { notifications.push({ id, ...o }); return id; },
    clear() {}, onClicked: evt(), onButtonClicked: evt(),
  },
  webNavigation: { onBeforeNavigate: evt(), onCommitted: evt(), onErrorOccurred: evt() },
  scripting: { executeScript: async () => [] },
  windows: {
    async getAll({ populate } = {}) { return [...windows].map((id) => ({ id, incognito: false, tabs: populate ? [...tabs.values()].filter((t) => t.windowId === id).sort((a, b) => a.index - b.index).map((t) => ({ ...t })) : undefined })); },
    async get(id, { populate } = {}) { return (await this.getAll({ populate })).find((w) => w.id === id); },
    async getLastFocused() { return { id: 1, incognito: false }; },
    async create() { const id = Math.max(...windows) + 1; windows.add(id); makeTab({ windowId: id, url: 'chrome://newtab/', active: true }); return { id }; },
    async update() {},
  },
  tabs: {
    async query(q = {}) {
      return [...tabs.values()].filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || t.active === q.active)).sort((a, b) => a.windowId - b.windowId || a.index - b.index).map((t) => ({ ...t }));
    },
    async get(id) { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
    async update(id, p) { const t = tabs.get(id); if (!t) throw new Error('no tab'); Object.assign(t, p); return { ...t }; },
    async remove(ids) { for (const id of [].concat(ids)) tabs.delete(id); reindex(); },
    async discard(id) { const t = tabs.get(id); if (t.active) throw new Error('active'); t.discarded = true; return { ...t }; },
    async create(p) { const t = makeTab({ windowId: p.windowId ?? 1, url: p.url ?? 'chrome://newtab/', pinned: !!p.pinned, active: !!p.active, index: 9999 }); reindex(); return { ...t }; },
    async group({ tabIds, groupId, createProperties }) {
      const gid = groupId ?? nextGroupId++;
      if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: createProperties?.windowId ?? 1, title: '', color: 'grey', collapsed: false });
      for (const id of tabIds) tabs.get(id).groupId = gid;
      return gid;
    },
    async ungroup(ids) { for (const id of ids) tabs.get(id).groupId = -1; },
    async move() {},
    async goBack() {},
    async sendMessage() { return { mb: 50 }; },
    onCreated: evt(), onRemoved: evt(), onActivated: evt(), onUpdated: evt(),
  },
  tabGroups: {
    async query({ windowId }) { return [...groups.values()].filter((g) => g.windowId === windowId && [...tabs.values()].some((t) => t.groupId === g.id)).map((g) => ({ ...g })); },
    async update(id, p) { Object.assign(groups.get(id), p); },
    async move(gid, { index }) {
      const g = groups.get(gid);
      const row = [...tabs.values()].filter((t) => t.windowId === g.windowId).sort((a, b) => a.index - b.index);
      const moving = row.filter((t) => t.groupId === gid);
      const rest = row.filter((t) => t.groupId !== gid);
      rest.splice(index, 0, ...moving);
      rest.forEach((t, i) => { t.index = i; });
    },
  },
};
globalThis.chrome = chrome;

const send = (msg, tab) => new Promise((res) => {
  const handled = onMessage.fns[0](msg, { tab }, res);
  if (!handled) res(undefined);
});
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

await import('../src/background.js');

// 0. URL variants count as the same page
const { normalizeUrl } = await import('../src/shared.js');
for (const v of ['http://example.com/page/', 'https://www.example.com/page', 'https://example.com/page/#x', 'https://example.com/page?utm_source=a']) {
  assert.equal(normalizeUrl(v), normalizeUrl('https://example.com/page'), v);
}
assert.equal(normalizeUrl('https://example.com'), normalizeUrl('https://www.example.com/'));
assert.notEqual(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
console.log('ok  http/https, www. and trailing / count as the same page');

// 1. duplicate prompt (ask mode)
await chrome.storage.local.set({ settings: { dupAction: 'ask' } });
await chrome.storage.onChanged.fire({ settings: {} });
const a = makeTab({ url: 'https://example.com/page', title: 'Example', active: true });
const b = makeTab({ url: 'chrome://newtab/' });
await chrome.webNavigation.onBeforeNavigate.fire({ frameId: 0, tabId: b.id, url: 'https://example.com/page?utm_source=x#top' }); await settle(300);
assert.match(tabs.get(b.id).url, /duplicate\.html\?.*existing=1.*fresh=1/, 'duplicate prompt shown');
console.log('ok  duplicate tab shows prompt');

// 2. "open new copy" lets it through
await send({ type: 'dupOpenAnyway', url: 'https://example.com/page' }, { ...tabs.get(b.id) });
assert.equal(tabs.get(b.id).url, 'https://example.com/page');
tabs.get(b.id).url = 'chrome://newtab/';
await chrome.webNavigation.onBeforeNavigate.fire({ frameId: 0, tabId: b.id, url: 'https://example.com/page' }); await settle(300);
assert.equal(tabs.get(b.id).url, 'chrome://newtab/', 'bypass honored');
console.log('ok  "open new copy" is not prompted again');

// 3. "go to open tab" closes the fresh tab
const c = makeTab({ url: 'chrome://newtab/' });
await send({ type: 'dupSwitch', existingId: a.id, fresh: true }, { ...c });
assert.ok(!tabs.has(c.id));
console.log('ok  "go to open tab" closes the new tab');

// 3b. default (close) mode: new tab closes, open tab comes to the front
await chrome.storage.local.set({ settings: {} });
await chrome.storage.onChanged.fire({ settings: {} });
tabs.get(a.id).active = false;
const d = makeTab({ url: 'chrome://newtab/', active: true });
await chrome.webNavigation.onBeforeNavigate.fire({ frameId: 0, tabId: d.id, url: 'http://www.example.com/page/' }); await settle(300);
assert.ok(!tabs.has(d.id), 'new copy closed');
assert.equal(tabs.get(a.id).active, true, 'open tab focused');
console.log('ok  close mode: new copy closed, open tab kept and focused');

// 3c. close mode: navigating an older tab keeps it and closes the other copy
const e = makeTab({ url: 'https://other.example/', active: true });
tabs.get(a.id).active = false;
await chrome.webNavigation.onBeforeNavigate.fire({ frameId: 0, tabId: e.id, url: 'https://example.com/page' }); await settle(300);
assert.ok(tabs.has(e.id) && !tabs.has(a.id), 'navigated tab kept, other copy closed');
console.log('ok  close mode: tab you navigate in is kept, other copy closed');

// 3d. close mode: copies that skip onBeforeNavigate ("Duplicate tab", SPA links)
tabs.get(e.id).url = 'https://example.com/page';
const f = makeTab({ url: 'https://example.com/page/', active: false });
await chrome.tabs.onUpdated.fire(f.id, { url: f.url }, { ...f }); await settle(1500);
assert.ok(!tabs.has(f.id) && tabs.has(e.id), 'background copy closed, active tab kept');
tabs.delete(e.id);
makeTab({ url: 'https://example.com/page', title: 'Example', active: true });
console.log('ok  close mode: duplicate from URL change closed, active tab kept');

// 4. auto-group by topic
tabs.delete(b.id);
const g1 = makeTab({ url: 'https://github.com/x' });
const g2 = makeTab({ url: 'https://stackoverflow.com/q/1' });
await chrome.tabs.onUpdated.fire(g2.id, { url: g2.url }, { ...g2 });
await settle();
assert.equal(tabs.get(g1.id).groupId, tabs.get(g2.id).groupId);
assert.notEqual(tabs.get(g1.id).groupId, -1);
const grp = groups.get(tabs.get(g1.id).groupId);
assert.equal(grp.title, 'Dev');
assert.equal(grp.collapsed, true, 'inactive group collapsed');
console.log('ok  GitHub + Stack Overflow joined into "Dev" group, collapsed while unused');

// 5. sweep: sleep idle, close old with undo notice
const idle = makeTab({ url: 'https://idle.example/', lastAccessed: Date.now() - 2 * 3600e3 });
const old = makeTab({ url: 'https://old.example/', title: 'Old', lastAccessed: Date.now() - 2 * DAY });
const pinnedOld = makeTab({ url: 'https://pinned.example/', pinned: true, lastAccessed: Date.now() - 9 * DAY });
await chrome.alarms.onAlarm.fire({ name: 'taber-sweep' }); await settle(300);
assert.equal(tabs.get(idle.id).discarded, true, 'idle tab asleep');
assert.ok(!tabs.has(old.id), 'old tab closed');
assert.ok(tabs.has(pinnedOld.id), 'pinned kept');
const undoNote = notifications.find((n) => n.id.startsWith('undo:') && n.message.includes('not used'));
assert.ok(undoNote && undoNote.buttons?.[0].title === 'Undo');
console.log('ok  sweep: idle tab asleep, old tab closed, pinned kept, Undo notice shown');

// 6. undo restores
await chrome.notifications.onButtonClicked.fire(undoNote.id, 0); await settle(300);
assert.ok([...tabs.values()].some((t) => t.url === 'https://old.example/'), 'old tab restored');
console.log('ok  Undo reopens the closed tab');

// 7. CPU-heavy tab is put to sleep, not closed
const hog = makeTab({ url: 'https://hog.example/', title: 'Hog' });
for (let i = 0; i < 6; i++) await send({ type: 'probe', ratio: 0.8, seconds: 10 }, { ...tabs.get(hog.id) });
assert.ok(tabs.has(hog.id), 'heavy tab not closed');
assert.equal(tabs.get(hog.id).discarded, true, 'heavy tab asleep');
const calm = makeTab({ url: 'https://calm.example/' });
for (let i = 0; i < 6; i++) await send({ type: 'probe', ratio: 0.1, seconds: 10 }, { ...tabs.get(calm.id) });
assert.equal(tabs.get(calm.id).discarded, false);
console.log('ok  CPU-heavy tab put to sleep after 60 s; calm tab untouched');

// 8. tab limit sleeps oldest
for (let i = 0; i < 35; i++) makeTab({ url: `https://site${i}.example/`, lastAccessed: Date.now() - (100 - i) * 1000 });
await chrome.alarms.onAlarm.fire({ name: 'taber-sweep' }); await settle(300);
const awake = [...tabs.values()].filter((t) => t.windowId === 1 && !t.pinned && !t.discarded).length;
assert.ok(awake <= 30, `awake tabs ${awake} <= 30`);
console.log(`ok  tab limit: ${awake} awake tabs in window (limit 30)`);

// 9. sessions
const r = await send({ type: 'saveSession', name: 'Work', scope: 'window', windowId: 1, close: false });
assert.ok(r.ok && r.count > 30);
const { sessions } = await chrome.storage.local.get('sessions');
const before = tabs.size;
await send({ type: 'openSession', id: sessions[0].id });
assert.ok(tabs.size >= before + r.count, 'session reopened in new window');
console.log(`ok  session saved (${r.count} tabs) and reopened`);

// 10. snooze and wake
const sn = makeTab({ url: 'https://later.example/', title: 'Later' });
await send({ type: 'snooze', tabId: sn.id, wakeAt: Date.now() + 3600e3 });
assert.ok(!tabs.has(sn.id));
const alarm = [...alarms.keys()].find((k) => k.startsWith('snooze:'));
assert.ok(alarm);
await chrome.alarms.onAlarm.fire({ name: alarm }); await settle(300);
assert.ok([...tabs.values()].some((t) => t.url === 'https://later.example/'));
console.log('ok  snoozed tab closes and comes back on time');

// 11. stats recorded
await settle(2500);
const { stats } = await chrome.storage.local.get('stats');
const wk = Object.values(stats.weeks)[0];
assert.ok(wk.slept >= 1 && wk.closed_stale === 1 && wk.slept_heavy === 1 && wk.dup_prompts === 1);
console.log('ok  stats:', JSON.stringify(wk), `memory ${stats.memoryFreedMB} MB`);

// 12. tab that failed to load closes; aborted load and cert warning stay
const bad = makeTab({ url: 'https://nope.invalid/', title: 'Problem loading page', status: 'complete' });
const stopped = makeTab({ url: 'https://stopped.example/', title: 'Stopped' });
const cert = makeTab({ url: 'https://self-signed.example/', title: 'Warning' });
const retry = makeTab({ url: 'https://flaky.example/', title: 'Flaky' });
await chrome.webNavigation.onErrorOccurred.fire({ frameId: 0, tabId: bad.id, url: bad.url, error: 'net::ERR_NAME_NOT_RESOLVED' });
await chrome.webNavigation.onErrorOccurred.fire({ frameId: 0, tabId: stopped.id, url: stopped.url, error: 'net::ERR_ABORTED' });
await chrome.webNavigation.onErrorOccurred.fire({ frameId: 0, tabId: cert.id, url: cert.url, error: 'Error code 2153394164' });
await chrome.webNavigation.onErrorOccurred.fire({ frameId: 0, tabId: retry.id, url: retry.url, error: 'net::ERR_CONNECTION_RESET' });
await chrome.webNavigation.onBeforeNavigate.fire({ frameId: 0, tabId: retry.id, url: retry.url });
await settle(2400);
assert.ok(!tabs.has(bad.id), 'error tab closed');
assert.ok(tabs.has(stopped.id) && tabs.has(cert.id) && tabs.has(retry.id), 'aborted, cert and retried tabs kept');
const { closedLog: cl } = await chrome.storage.local.get('closedLog');
assert.equal(cl[0].reason, 'error');
const stuck = makeTab({ url: 'https://gone.example/', title: 'Problem loading page', status: 'complete' });
await chrome.alarms.onAlarm.fire({ name: 'taber-sweep' }); await settle(300);
assert.ok(!tabs.has(stuck.id), 'already-open error tab closed by sweep');
console.log('ok  tabs that did not load close; aborted loads, cert warnings and retries stay');

// 13. groups side by side, no loose tab between them
for (const t of [...tabs.values()]) tabs.delete(t.id);
['https://github.com/a', 'https://lone1.example/', 'https://github.com/b',
  'https://youtube.com/1', 'https://lone2.example/', 'https://youtube.com/2']
  .map((url, i) => makeTab({ url, index: i, active: i === 0 }));
await send({ type: 'groupAll' }); await settle(100);
const row = [...tabs.values()].sort((a, b) => a.index - b.index);
const seq = row.map((t) => (t.groupId === -1 ? '-' : t.groupId));
const firstLoose = seq.indexOf('-');
assert.ok(seq.slice(firstLoose).every((x) => x === '-'), `loose tabs after groups: ${seq}`);
for (const g of new Set(seq.filter((x) => x !== '-'))) {
  const at = seq.flatMap((x, i) => (x === g ? [i] : []));
  assert.equal(at.at(-1) - at[0] + 1, at.length, `group ${g} side by side`);
}
console.log('ok  groups side by side, loose tabs after the last group:', seq.join(' '));

console.log('\nall smoke tests passed');
process.exit(0);
