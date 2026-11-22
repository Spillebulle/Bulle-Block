// Bulle Block - element hiding, in every frame at document_start.
//
// The CSS itself is inserted by background.js (scripting.insertCSS at user
// origin, which page styles cannot override); this script only says which
// site the frame is on, and passes the Facebook switch to content/facebook.js
// in the page's own world through an attribute on <html>. It also stops pages
// redirecting to the domains listed under "Stop redirects to" in the popup,
// and to every domain the block lists block.

(() => {
  if (window.__bulleblock_cosmetic) return;
  window.__bulleblock_cosmetic = true;

  let host = location.hostname;
  if (!host) {
    // about:blank and srcdoc frames inherit their parent's origin; ad
    // scripts write into such frames, so hide by the parent's rules.
    try { host = window.parent.location.hostname; } catch { /* cross-origin */ }
  }
  if (!host) return;

  // ── Stopped redirects ────────────────────────────────────────────────────
  // A page may not send the tab, unless the user clicked a link, to a domain
  // on the user's list or to any whole domain the enabled block lists block.
  // That is three million names, so the background looks them up. Since
  // preventDefault() has to be called synchronously, every cross-site
  // redirect is held, checked, and sent on again if allowed. A redirect made
  // by the server never reaches this: there is no page left to stay on.
  let active = true;    // false once the background says this site is paused
  let released = null;  // the URL just let through, so it is not held twice
  let latest = 0;       // only the most recent held redirect may go ahead

  // The Navigation API sees location changes, meta refreshes and top.location
  // writes from iframes alike. Browsers without it simply do not stop these.
  if (window === window.top && window.navigation) {
    window.navigation.addEventListener('navigate', event => {
      if (!active || !event.cancelable || event.userInitiated || event.navigationType === 'traverse') return;
      if (event.formData || event.downloadRequest !== null) return;
      const dest = new URL(event.destination.url);
      if (!/^https?:$/.test(dest.protocol) || dest.hostname === location.hostname) return;
      if (dest.href === released) {
        released = null;
        return;
      }
      event.preventDefault();
      const replace = event.navigationType === 'replace';
      const turn = ++latest;
      chrome.runtime.sendMessage({ type: 'CHECK_REDIRECT', url: dest.href, from: location.hostname })
        .catch(() => ({ stop: false })) // extension reloaded under the page
        .then(reply => {
          if (turn !== latest) return;
          if (reply?.stop) {
            console.info(`[Bulle Block] Stopped a redirect to ${dest.hostname}.`);
            return;
          }
          released = dest.href;
          if (replace) location.replace(dest.href); else location.assign(dest.href);
        });
    });
  }

  chrome.runtime.sendMessage({ type: 'FRAME_START', host }).then(reply => {
    if (window === window.top && reply && !reply.facebook) {
      document.documentElement.setAttribute('data-bulleblock-facebook', 'off');
    }
    active = reply?.stopRedirects ?? false;
  }).catch(() => { active = false; }); // extension reloaded under the page
})();
