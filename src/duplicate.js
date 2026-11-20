import { api, send, siteOf } from './shared.js';

const params = new URLSearchParams(location.search);
const url = params.get('url');
const existingId = Number(params.get('existing'));
const fresh = params.get('fresh') === '1';

const $ = (id) => document.getElementById(id);

async function init() {
  $('url').textContent = url;
  let existing;
  try { existing = await api.tabs.get(existingId); } catch { /* closed */ }

  if (!existing) {
    // The other copy is gone; just load the page.
    openAnyway();
    return;
  }

  $('title').textContent = existing.title || url;
  document.title = `Already open: ${existing.title || siteOf(url)}`;
  const current = await api.tabs.getCurrent();
  if (current && current.windowId !== existing.windowId) {
    $('where').textContent = 'You have this page open in another window.';
  }
  const fav = $('fav');
  fav.textContent = (siteOf(url)[0] || '•').toUpperCase();
  if (existing.favIconUrl && /^(https?|data):/i.test(existing.favIconUrl)) {
    const img = new Image(16, 16);
    img.alt = '';
    img.onload = () => fav.replaceChildren(img);
    img.src = existing.favIconUrl;
  }
  $('switch').focus();
}

async function switchToExisting() {
  const r = await send('dupSwitch', { existingId, fresh });
  if (r?.gone) openAnyway();
}

function openAnyway() {
  send('dupOpenAnyway', { url });
}

$('switch').addEventListener('click', switchToExisting);
$('open').addEventListener('click', openAnyway);
$('settings').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLButtonElement && e.key === 'Enter') return; // button handles it
  if (e.key === 'Enter') switchToExisting();
  if (e.key.toLowerCase() === 'n') openAnyway();
});

init();
