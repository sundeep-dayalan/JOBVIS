// JOBVIS — Background Service Worker (MV3)
// Handles privileged operations that content scripts cannot perform directly,
// such as reading HttpOnly cookies (JSESSIONID is required for Voyager API CSRF).

chrome.runtime.onInstalled.addListener(() => {
  console.log('[JOBVIS] Extension installed / updated (v2 — two-phase Voyager API)');
});

// ─── Message handler ─────────────────────────────────────────
// Receives messages from the content script and responds with privileged data.

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // getCookie: read an HttpOnly cookie by name for a given URL.
  // Content scripts cannot access HttpOnly cookies via document.cookie,
  // but the service worker can via chrome.cookies.get().
  if (msg.action === 'getCookie') {
    const { url, name } = msg;
    chrome.cookies.get({ url, name }, (cookie) => {
      reply({ ok: true, value: cookie?.value ?? null });
    });
    return true; // Keep message channel open for async reply
  }
});
