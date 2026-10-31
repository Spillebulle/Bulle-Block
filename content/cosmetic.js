// Bulle Block - element hiding, in every frame at document_start.
//
// The CSS itself is inserted by background.js (scripting.insertCSS at user
// origin, which page styles cannot override); this script only says which
// site the frame is on, and passes the Facebook switch to content/facebook.js
// in the page's own world through an attribute on <html>.

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

  chrome.runtime.sendMessage({ type: 'FRAME_START', host }).then(reply => {
    if (window === window.top && reply && !reply.facebook) {
      document.documentElement.setAttribute('data-bulleblock-facebook', 'off');
    }
  }).catch(() => { /* extension reloaded under the page */ });
})();
