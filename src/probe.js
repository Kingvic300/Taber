// Runs in every web page. Measures how much of the time the page keeps the
// browser's main thread busy, and reports busy pages to Taber.
// Browsers give extensions no real per-tab CPU number, so this is an estimate:
// Chrome reports "long tasks" (>50 ms); Firefox gets timer lag instead.
// Work in Web Workers is not seen.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // Flag per version, so an update can add a fresh probe next to the old,
  // disconnected one.
  const flag = `__taberProbe_${api.runtime.getManifest().version}`;
  if (window[flag] || window.top !== window) return;
  window[flag] = true;
  const WINDOW_MS = 10_000;
  const TICK_MS = 1000;

  let busyMs = 0;
  let tickBusy = 0; // busy ms in the current 1 s tick
  const recent = []; // last ~10 s of ticks: { busy, span }
  let windowStart = performance.now();
  let lastTick = windowStart;
  let reportedHigh = false;
  let useLongTasks = false;

  try {
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { busyMs += e.duration; tickBusy += e.duration; }
      }).observe({ type: 'longtask' });
      useLongTasks = true;
    }
  } catch { /* not supported */ }

  setInterval(() => {
    const now = performance.now();
    if (!useLongTasks) {
      const lag = now - lastTick - TICK_MS;
      // Over 5 s is the computer sleeping or heavy throttling, not page work.
      if (lag > 50 && lag < 5000) { busyMs += lag; tickBusy += lag; }
    }
    recent.push({ busy: tickBusy, span: now - lastTick });
    tickBusy = 0;
    let total = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      total += recent[i].span;
      if (total > WINDOW_MS) { recent.splice(0, i); break; }
    }
    lastTick = now;

    const elapsed = now - windowStart;
    if (elapsed < WINDOW_MS) return;
    const ratio = Math.min(1, busyMs / elapsed);
    busyMs = 0;
    windowStart = now;

    // Only talk to the background when busy, plus one "calm again" report.
    const high = ratio >= 0.2;
    if (high || reportedHigh) {
      try {
        api.runtime.sendMessage({ type: 'probe', ratio, seconds: elapsed / 1000 }).catch(() => {});
      } catch { /* extension reloaded; this old copy is orphaned */ }
    }
    reportedHigh = high;
  }, TICK_MS);

  // Share of the last ~10 s this page kept the main thread busy (0..1).
  const recentRatio = () => {
    let busy = 0, span = 0;
    for (const r of recent) { busy += r.busy; span += r.span; }
    return span >= 1000 ? Math.min(1, busy / span) : null;
  };

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'taber-cpu') { sendResponse({ ratio: recentRatio() }); return false; }
    if (msg?.type !== 'taber-heap') return false;
    const mem = performance.memory;
    sendResponse({ mb: mem ? mem.usedJSHeapSize / 1048576 : null });
    return false;
  });
})();
