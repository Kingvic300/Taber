import {
  api, getSettings, saveSettings, groupsSupported, isSyncOn, setSync,
  parseTopics, formatTopics, DEFAULT_TOPICS, send,
} from './shared.js';

const $ = (id) => document.getElementById(id);

let savedTimer;
function flash(text = 'Saved') {
  $('saved').textContent = text;
  $('saved').classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1400);
}
async function save(patch) {
  await saveSettings(patch);
  flash();
}

function clampInt(input, min, max, fallback) {
  const n = Math.max(min, Math.min(max, parseInt(input.value, 10) || fallback));
  input.value = n;
  return n;
}

function splitMinutes(min) {
  if (min % 1440 === 0) return [min / 1440, 1440];
  if (min % 60 === 0) return [min / 60, 60];
  return [min, 1];
}

const s = await getSettings();

/* ---------- checkboxes and selects ---------- */

for (const id of ['dupCheck', 'dupIgnoreHash', 'dupIgnoreQuery', 'autoGroup', 'collapseInactiveGroups', 'tidyGroups', 'topicGroups', 'closeErrorTabs',
  'sleepEnabled', 'heavyEnabled', 'tabLimitEnabled', 'autoClose', 'autoCloseKeepGrouped', 'undoNotice']) {
  $(id).checked = !!s[id];
  $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
}
for (const id of ['dupAction', 'heavyAction', 'tabLimitAction']) {
  $(id).value = s[id];
  $(id).addEventListener('change', () => save({ [id]: $(id).value }));
}

/* ---------- numbers ---------- */

const numbers = {
  groupMinTabs: [2, 20],
  heavyThreshold: [10, 100],
  heavySeconds: [20, 3600],
  tabLimit: [5, 500],
};
for (const [id, [min, max]] of Object.entries(numbers)) {
  $(id).value = s[id];
  $(id).addEventListener('change', () => save({ [id]: clampInt($(id), min, max, s[id]) }));
}

function durationField(valueId, unitId, key) {
  const [v, unit] = splitMinutes(s[key]);
  $(valueId).value = v;
  $(unitId).value = String(unit);
  const handler = () => save({ [key]: clampInt($(valueId), 1, 100000, 1) * Number($(unitId).value) });
  $(valueId).addEventListener('change', handler);
  $(unitId).addEventListener('change', handler);
}
durationField('sleepValue', 'sleepUnit', 'sleepMinutes');
durationField('ageValue', 'ageUnit', 'autoCloseMinutes');

/* ---------- lists ---------- */

$('groupNote').hidden = groupsSupported();

$('topics').value = formatTopics(s.topics);
$('topics').addEventListener('change', () => {
  const topics = parseTopics($('topics').value);
  $('topics').value = formatTopics(topics);
  save({ topics });
});
$('resetTopics').addEventListener('click', () => {
  $('topics').value = formatTopics(DEFAULT_TOPICS);
  save({ topics: DEFAULT_TOPICS });
});

$('whitelist').value = s.whitelist.join('\n');
$('whitelist').addEventListener('change', () => {
  const list = $('whitelist').value
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const unique = [...new Set(list)];
  $('whitelist').value = unique.join('\n');
  save({ whitelist: unique });
});

/* ---------- website access (needed for the CPU probe) ---------- */

const ALL_SITES = { origins: ['<all_urls>'] };
async function checkPermission() {
  const ok = await api.permissions.contains(ALL_SITES);
  $('permNotice').hidden = ok;
}
$('grantPerm').addEventListener('click', async () => {
  if (await api.permissions.request(ALL_SITES)) flash('Access granted');
  checkPermission();
});
checkPermission();

/* ---------- sync ---------- */

$('syncSettings').checked = await isSyncOn();
$('syncSettings').disabled = !api.storage.sync;
$('syncSettings').addEventListener('change', async () => {
  await setSync($('syncSettings').checked);
  flash($('syncSettings').checked ? 'Sync on' : 'Sync off');
});

/* ---------- backup ---------- */

$('exportBtn').addEventListener('click', async () => {
  const local = await api.storage.local.get(['sessions', 'snoozed', 'closedLog', 'stats']);
  const windows = await api.windows.getAll({ windowTypes: ['normal'], populate: true });
  const data = {
    app: 'taber',
    version: api.runtime.getManifest().version,
    exportedAt: Date.now(),
    settings: await getSettings(),
    sessions: local.sessions ?? [],
    snoozed: local.snoozed ?? [],
    closedLog: local.closedLog ?? [],
    stats: local.stats ?? null,
    openTabs: windows.map((w) => ({
      tabs: w.tabs.filter((t) => /^(https?|ftp|file):/i.test(t.url))
        .map((t) => ({ url: t.url, title: t.title, pinned: t.pinned })),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `taber-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'taber') throw new Error('This is not a Taber backup file.');
    if (data.settings && typeof data.settings === 'object') {
      const known = Object.fromEntries(Object.entries(data.settings).filter(([k]) => k in s));
      await saveSettings(known);
    }
    const r = await send('importData', { data });
    if (r?.ok === false) throw new Error(r.error);
    $('importResult').textContent =
      `Imported settings, ${r.sessions} session(s) and ${r.snoozed} snoozed tab(s). Reloading…`;
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    $('importResult').textContent = `Import failed: ${e.message}`;
  }
});
