// Bulle Block - Facebook sponsored posts. Runs in the page's own world (MAIN)
// at document_start on facebook.com, before Facebook's scripts.
//
// Sponsored posts come from facebook.com itself, so no network rule can touch
// them, and the "Sponsored" label is scrambled to defeat text matching. But
// the feed arrives as GraphQL data in which a paid post is plainly marked, so
// this filters that data before Facebook reads it. Only paid posts go:
// "Suggested for you", Reels and the like are left alone on purpose.
//
// The switch lives in content/cosmetic.js (this world cannot reach
// chrome.storage): it sets data-bulleblock-facebook="off" on <html>.

(() => {
  if (window.__bulleblock_facebook) return;
  window.__bulleblock_facebook = true;

  const off = () => document.documentElement?.getAttribute('data-bulleblock-facebook') === 'off';
  const isGraphql = url => /\/api\/graphql\/?/.test(url || '');
  let removed = 0;

  // ── What counts as an ad ────────────────────────────────────────────────

  // A paid post carries category "SPONSORED" on its feed edge, or a non-null
  // sponsored_data somewhere inside its story. Walk a few levels for the
  // latter: Facebook moves it around, never very deep.
  function hasSponsoredData(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return false;
    if (obj.sponsored_data) return true;
    for (const key in obj) {
      const v = obj[key];
      if (v && typeof v === 'object' && hasSponsoredData(v, depth + 1)) return true;
    }
    return false;
  }

  function isSponsoredEdge(edge) {
    if (!edge || typeof edge !== 'object') return false;
    if (edge.category === 'SPONSORED' || edge.node?.category === 'SPONSORED') return true;
    return hasSponsoredData(edge.node, 0);
  }

  // Remove sponsored entries from every `edges` array in a response.
  // Returns true if anything was taken out.
  function scrub(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 40) return false;
    let changed = false;
    if (Array.isArray(obj.edges)) {
      const kept = obj.edges.filter(e => !isSponsoredEdge(e));
      if (kept.length !== obj.edges.length) {
        removed += obj.edges.length - kept.length;
        obj.edges = kept;
        changed = true;
      }
    }
    for (const key in obj) {
      const v = obj[key];
      if (v && typeof v === 'object' && scrub(v, depth + 1)) changed = true;
    }
    return changed;
  }

  // One line of a GraphQL response: a whole JSON object, sometimes behind
  // Facebook's "for (;;);" guard. Streamed feed items arrive as their own
  // line with a path ending in edges/<n>; a sponsored one is dropped whole.
  // Returns the line to keep, or null to drop it.
  function filterLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const guard = trimmed.startsWith('for (;;);') ? 'for (;;);' : '';
    let data;
    try {
      data = JSON.parse(trimmed.slice(guard.length));
    } catch {
      return line;
    }
    if (Array.isArray(data?.path) && data.path.includes('edges') && isSponsoredEdge(data.data)) {
      removed++;
      return null;
    }
    return scrub(data) ? guard + JSON.stringify(data) : line;
  }

  // Prefix-stable: Facebook reads a streaming response in pieces and keeps
  // its own offset into it, so what we return must only ever grow. Complete
  // lines are filtered once and appended; a partial last line is held back
  // until its newline (or the end of the response) arrives.
  function makeFilter() {
    let done = 0;
    let out = '';
    return (raw, finished) => {
      let end = finished ? raw.length : raw.lastIndexOf('\n') + 1;
      if (end > done) {
        const chunk = raw.slice(done, end);
        const lines = chunk.split('\n');
        const last = lines.pop(); // '' when the chunk ends in a newline
        for (const line of lines) {
          const kept = filterLine(line);
          if (kept !== null) out += kept + '\n';
        }
        if (last) {
          const kept = filterLine(last);
          if (kept !== null) out += kept;
        }
        done = end;
        if (removed) console.debug(`[Bulle Block] Sponsored posts removed: ${removed}.`);
      }
      return out;
    };
  }

  // ── XMLHttpRequest (what Facebook's feed uses) ─────────────────────────

  const XHR = XMLHttpRequest.prototype;
  const urls = new WeakMap();
  const filters = new WeakMap();
  const origOpen = XHR.open;
  XHR.open = function (method, url) {
    urls.set(this, String(url));
    filters.delete(this);
    return origOpen.apply(this, arguments);
  };

  function filtered(xhr, raw) {
    if (typeof raw !== 'string' || !isGraphql(urls.get(xhr))) return raw;
    let f = filters.get(xhr);
    if (!f) {
      if (off()) return raw; // decide once per response, so it stays consistent
      f = makeFilter();
      filters.set(xhr, f);
    }
    return f(raw, xhr.readyState === 4);
  }

  const textDesc = Object.getOwnPropertyDescriptor(XHR, 'responseText');
  const respDesc = Object.getOwnPropertyDescriptor(XHR, 'response');
  Object.defineProperty(XHR, 'responseText', {
    configurable: true,
    enumerable: textDesc.enumerable,
    get() { return filtered(this, textDesc.get.call(this)); }
  });
  Object.defineProperty(XHR, 'response', {
    configurable: true,
    enumerable: respDesc.enumerable,
    get() {
      const r = respDesc.get.call(this);
      return (this.responseType === '' || this.responseType === 'text') ? filtered(this, r) : r;
    }
  });

  // ── fetch (some Facebook surfaces use it) ──────────────────────────────

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    if (off() || !isGraphql(url) || !res.body) return res;
    const f = makeFilter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let raw = '';
    let sent = 0;
    const body = res.body.pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        raw += decoder.decode(chunk, { stream: true });
        const out = f(raw, false);
        if (out.length > sent) { ctl.enqueue(encoder.encode(out.slice(sent))); sent = out.length; }
      },
      flush(ctl) {
        raw += decoder.decode();
        const out = f(raw, true);
        if (out.length > sent) ctl.enqueue(encoder.encode(out.slice(sent)));
      }
    }));
    const copy = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(copy, 'url', { value: res.url });
    return copy;
  };

  // ── Backstop in the page ───────────────────────────────────────────────
  // If a sponsored post gets through the data filter anyway, its "why am I
  // seeing this ad" link still gives it away.
  const style = document.createElement('style');
  style.textContent = '[role="feed"] > div:has(a[href*="/ads/about"]) { display: none !important; }';
  const addStyle = () => {
    if (off()) return;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addStyle, { once: true });
  else addStyle();
})();
