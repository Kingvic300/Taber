# Tabora — Smart Tab Manager for Chrome and Firefox

One extension, one manifest, for both browsers (Chrome 121+, Firefox 121+; tab groups need Firefox 139+).

## What it does on its own

| Feature | How |
|---|---|
| **Reads your tabs** | The popup lists every tab in every window, with search, duplicate markers and "last used" time. The toolbar badge shows how many tabs are open. |
| **Shows CPU use** | Every awake tab shows its CPU use for the last 10 seconds, updated every 2 seconds while the popup is open. Each window or group header shows the total for its tabs. **Most CPU** sorts the heaviest tabs to the top. Values of 30 % or more are red (60 % for a group). |
| **Joins tabs** | Related tabs go into one tab group. Topics come first (Dev, AI, Mail & Chat, Work, Video, Social, Shopping, News; you can edit them). YouTube and X count as Social. Other tabs are grouped by site once 2 or more are open. Groups you are not using fold up. |
| **Keeps groups side by side** | No loose tab sits between two groups: groups line up after the pinned tabs, loose tabs go after the last group. |
| **Closes tabs that did not load** | A tab showing "Problem loading page" (Firefox) or "This site can't be reached" (Chrome) closes after 2 s, with **Undo**. A retry within that time keeps it. Certificate warnings, stopped loads, pinned tabs and times when you are offline are skipped. |
| **Stops duplicate tabs** | Opening a page that is already open keeps one tab and closes the copy: a new tab closes and the open tab comes to the front; a tab you navigate in stays and the other copy closes (with **Undo**). `http`/`https`, `www.` and a trailing `/` count as the same page. Pinned tabs are kept. Settings can switch this to a prompt instead: **Go to open tab** (Enter) or **Open new copy** (N). |
| **Sleeps idle tabs** | Tabs unused for 1 hour are unloaded. They stay in the tab bar, use no memory or CPU, and load again when clicked. |
| **Calms CPU-heavy tabs** | A background tab that keeps the browser busy ≥ 50 % of the time for 60 s is put to sleep. |
| **Tab limit** | More than 30 awake tabs in a window: the least recently used ones are put to sleep. |
| **Closes old tabs** | Tabs unused for 1 day are closed. A notice with **Undo** appears, and every closed tab stays in **Recently closed** in the popup. |
| **Smart keep** | Tabora learns which sites and tabs you use most. It never closes them on its own: cleanup puts them to sleep instead, and they stay awake twice as long. Use fades after about a week. |

Pinned tabs, the tab you are on, tabs playing sound and sites on your "never sleep or close" list are never touched automatically.

Also in the popup:
- **Sessions:** save a window or all windows by name, optionally close them, and reopen them later.
- **Snooze:** use the clock button on a tab. The tab closes and opens again later today, tomorrow, at the weekend or next week.
- **Stats:** tabs slept or closed this week, duplicate tabs avoided, memory freed, and your most visited sites.

On the settings page you can change every option, sync settings across your computers, and export or import a backup file.

Shortcut: `Alt+Shift+T` opens the popup.

### About the CPU check

Browsers do not give extensions real per-tab CPU numbers. Chrome's `processes` API only works in its developer channel. Instead, `src/probe.js` runs in each page and measures how long the page keeps the main thread busy. Chrome measures this with long tasks; Firefox measures timer lag. This catches most runaway pages, but work done in Web Workers is not seen. The check needs the "access all websites" permission. In Firefox, grant it from the settings page if asked.

Memory freed is measured from the page's JavaScript heap. This works in Chrome only.

## Install (development)

**Chrome / Edge / Brave**
1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder

**Firefox**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json`

Firefox removes temporary add-ons on restart. For a permanent install, sign the `.xpi` on addons.mozilla.org.

## Build and test

```sh
./build.sh                     # dist/tabora-<version>-chrome.zip and -firefox.xpi
node tools/smoke-test.mjs      # runs the background against a fake browser API
python3 tools/make_icons.py    # regenerate icons
```

## Files

```
manifest.json          shared MV3 manifest (service_worker for Chrome, scripts for Firefox)
src/background.js      wires browser events to the modules below
src/bg/duplicates.js   duplicate-tab prompt
src/bg/grouping.js     topic/site groups, collapse, merge windows
src/bg/cleanup.js      sleep idle tabs, close old tabs, tab limit, CPU-heavy tabs
src/bg/errors.js       close tabs whose page did not load
src/bg/sessions.js     saved sessions, snooze, import
src/bg/util.js         storage helpers, closed-tab log, Undo notices, stats
src/probe.js           in-page CPU estimate
src/shared.js          settings (with sync), URL and topic helpers
src/popup.*            toolbar popup
src/duplicate.*        "already open" prompt page
src/options.*          settings page
```
