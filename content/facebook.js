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

  // ── Diagnostics for the "Ad got through" report ────────────────────────
  // A summary of every feed item the filter has looked at, so a report on a
  // sponsored post that slipped through says how Facebook marked it this
  // time. content/picker.js asks for it with a "bulleblock-fb-diagnose"
  // event (DOM events cross between worlds) and reads the answer from the
  // data-bulleblock-fb-diag attribute on <html>. Nothing leaves the page.
  const stats = {
    xhr: 0, fetch: 0, html: 0, items: 0, removed: 0, rail: 0, feed: 0,
    // What the page asked for, filtered or not: tells a report whether the
    // feed went past these hooks some other way (a worker, a frame).
    xhrOpened: 0, xhrGraphql: 0, xhrGraphqlTypes: {}, fetchCalls: 0, fetchGraphql: 0, workers: []
  };
  const seen = [];
  const MARKER = /sponsor|^ad_?id$|^is_ad|ad_client|ads?_info|^ad_preferences|why_am_i_seeing/i;

  function interestingKeys(obj, path, depth, out) {
    if (!obj || typeof obj !== 'object' || depth > 12 || out.length >= 12) return out;
    for (const key in obj) {
      const v = obj[key];
      if (MARKER.test(key) && v !== null && v !== false && v !== '') {
        const shown = typeof v === 'object' ? (Array.isArray(v) ? '[…]' : '{…}') : JSON.stringify(v).slice(0, 40);
        out.push(`${path}${key}=${shown}`);
      }
      if (v && typeof v === 'object') interestingKeys(v, `${path}${key}.`, depth + 1, out);
    }
    return out;
  }

  function pageLinks(obj, depth = 0, out = new Set()) {
    if (!obj || typeof obj !== 'object' || depth > 12 || out.size >= 4) return out;
    for (const key in obj) {
      const v = obj[key];
      if (typeof v === 'string' && /^https:\/\/www\.facebook\.com\/[^/?#]+/.test(v)) {
        out.add(v.split(/[?#]/)[0]);
      } else if (v && typeof v === 'object') {
        pageLinks(v, depth + 1, out);
      }
    }
    return out;
  }

  function note(edge, source, cut) {
    stats.items++;
    if (cut) stats.removed++;
    seen.push({
      source,
      cut,
      category: edge?.category ?? edge?.node?.category ?? null,
      type: edge?.node?.__typename ?? null,
      links: [...pageLinks(edge)],
      marks: interestingKeys(edge, '', 0, [])
    });
    if (seen.length > 80) seen.shift();
  }

  document.addEventListener('bulleblock-fb-diagnose', () => {
    document.documentElement.setAttribute('data-bulleblock-fb-diag', JSON.stringify({ stats, seen }));
  });

  // Remove sponsored entries from every `edges` array in a response.
  // Returns true if anything was taken out.
  function scrub(obj, source, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 40) return false;
    let changed = false;
    if (Array.isArray(obj.edges)) {
      const kept = obj.edges.filter(e => {
        const cut = isSponsoredEdge(e);
        if (e?.node) note(e, source, cut);
        return !cut;
      });
      if (kept.length !== obj.edges.length) {
        removed += obj.edges.length - kept.length;
        obj.edges = kept;
        changed = true;
      }
    }
    for (const key in obj) {
      const v = obj[key];
      if (v && typeof v === 'object' && scrub(v, source, depth + 1)) changed = true;
    }
    return changed;
  }

  // One line of a GraphQL response: a whole JSON object, sometimes behind
  // Facebook's "for (;;);" guard. Streamed feed items arrive as their own
  // line with a path ending in edges/<n>; a sponsored one is dropped whole.
  // Returns the line to keep, or null to drop it.
  function filterLine(line, source) {
    const trimmed = line.trim();
    if (!trimmed) return line;
    const guard = trimmed.startsWith('for (;;);') ? 'for (;;);' : '';
    let data;
    try {
      data = JSON.parse(trimmed.slice(guard.length));
    } catch {
      return line;
    }
    if (Array.isArray(data?.path) && data.path.includes('edges') && data.data && typeof data.data === 'object') {
      const cut = isSponsoredEdge(data.data);
      if (data.data.node) note(data.data, source + ' stream', cut);
      if (cut) {
        removed++;
        return null;
      }
    }
    return scrub(data, source) ? guard + JSON.stringify(data) : line;
  }

  // Prefix-stable: Facebook reads a streaming response in pieces and keeps
  // its own offset into it, so what we return must only ever grow. Complete
  // lines are filtered once and appended; a partial last line is held back
  // until its newline (or the end of the response) arrives.
  function makeFilter(source) {
    let done = 0;
    let out = '';
    return (raw, finished) => {
      let end = finished ? raw.length : raw.lastIndexOf('\n') + 1;
      if (end > done) {
        const chunk = raw.slice(done, end);
        const lines = chunk.split('\n');
        const last = lines.pop(); // '' when the chunk ends in a newline
        for (const line of lines) {
          const kept = filterLine(line, source);
          if (kept !== null) out += kept + '\n';
        }
        if (last) {
          const kept = filterLine(last, source);
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
    stats.xhrOpened++;
    if (isGraphql(String(url))) stats.xhrGraphql++;
    urls.set(this, String(url));
    filters.delete(this);
    return origOpen.apply(this, arguments);
  };

  function filtered(xhr, raw) {
    if (typeof raw !== 'string' || !isGraphql(urls.get(xhr))) return raw;
    let f = filters.get(xhr);
    if (!f) {
      if (off()) return raw; // decide once per response, so it stays consistent
      f = makeFilter('xhr');
      stats.xhr++;
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
      const type = this.responseType || 'text';
      if (type !== 'text' && isGraphql(urls.get(this))) {
        stats.xhrGraphqlTypes[type] = (stats.xhrGraphqlTypes[type] || 0) + 1;
      }
      return type === 'text' ? filtered(this, r) : r;
    }
  });

  // ── fetch (some Facebook surfaces use it) ──────────────────────────────

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = input instanceof Request ? input.url : String(input);
    stats.fetchCalls++;
    if (isGraphql(url)) stats.fetchGraphql++;
    const res = await origFetch.apply(this, arguments);
    if (off() || !isGraphql(url) || !res.body) return res;
    const f = makeFilter('fetch');
    stats.fetch++;
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

  // ── Workers ────────────────────────────────────────────────────────────
  // Requests made from a worker never pass the hooks above. Count the
  // workers the page starts, by script path, so a report can say so.
  for (const name of ['Worker', 'SharedWorker']) {
    const Orig = window[name];
    if (typeof Orig !== 'function') continue;
    const Wrapped = function (url, opts) {
      try { stats.workers.push(`${name} ${new URL(String(url), location.href).pathname}`); } catch { /* odd URL */ }
      return new Orig(url, opts);
    };
    Wrapped.prototype = Orig.prototype;
    window[name] = Wrapped;
  }

  // ── Feed data embedded in the page ─────────────────────────────────────
  // The first posts of a fresh page load are not fetched at all: they arrive
  // inside the HTML as <script type="application/json"> blocks that
  // Facebook's code reads later. Scrub each as the parser adds it; a
  // MutationObserver callback runs before the next script on the page does.
  // (Before content/cosmetic.js has relayed the switch, this runs as if it
  // were on: the setting arrives a moment after the first blocks.)
  // A script can be reported twice (on its own, and inside a parent added in
  // the same batch), so each is scrubbed once.
  const scrubbed = new WeakSet();
  function scrubScript(node) {
    if (node.nodeName !== 'SCRIPT' || node.type !== 'application/json' || off()) return;
    if (scrubbed.has(node)) return;
    const text = node.textContent;
    if (!text.includes('"edges"')) return; // may still be empty mid-parse; checked again then
    scrubbed.add(node);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    stats.html++;
    if (!scrub(data, 'html')) return;
    // Facebook enforces Trusted Types, which refuses script.textContent =
    // anything. Rewriting the text node inside is allowed: the policy guards
    // scripts that run, and a JSON block never runs.
    const json = JSON.stringify(data);
    if (node.childNodes.length === 1 && node.firstChild.nodeType === Node.TEXT_NODE) {
      node.firstChild.data = json;
    } else {
      try { node.textContent = json; } catch (err) { console.debug('[Bulle Block] Could not rewrite feed data.', err); }
    }
  }
  new MutationObserver(records => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.nodeName === 'SCRIPT') scrubScript(n);
        else if (n.nodeType === Node.TEXT_NODE && r.target.nodeName === 'SCRIPT') scrubScript(r.target);
        else if (n.querySelectorAll) n.querySelectorAll('script[type="application/json"]').forEach(scrubScript);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  // ── Right column ───────────────────────────────────────────────────────
  // The Sponsored box in the right column. Its ads link out through
  // l.facebook.com/l.php, which nothing else there does (contacts, birthdays
  // and group chats stay on facebook.com). From each such link, climb to the
  // largest block that holds no ordinary section beside it, so the box's
  // "Sponsored" heading goes too, and hide that. (First reported 2026-10-31.)
  const AD_LINK = 'a[href*="l.facebook.com/l.php"], a[href*="/ads/about"]';
  function hideRailAds() {
    if (off()) return;
    const rail = document.getElementById('right_rail_container') || document.querySelector('[role="complementary"]');
    if (!rail) return;
    for (const a of rail.querySelectorAll(AD_LINK)) {
      let el = a;
      while (el.parentElement && el.parentElement !== rail) {
        const others = [...el.parentElement.children].filter(c => c !== el);
        if (others.some(c => c.offsetHeight >= 80 && !c.querySelector(AD_LINK))) break;
        el = el.parentElement;
      }
      if (!el.hasAttribute('data-bulleblock-hidden')) {
        el.setAttribute('data-bulleblock-hidden', 'rail');
        el.style.setProperty('display', 'none', 'important');
        stats.rail++;
      }
    }
  }
  // ── Feed ───────────────────────────────────────────────────────────────
  // Facebook's feed data has proved a moving target (reports show the feed
  // requests are opened but never read through the hooks above), so feed ads
  // are also caught where they are drawn. A sponsored post's outbound link
  // is labelled for screen readers "Open ad link to <site>"; an ordinary
  // post's is not. The label is in the account's language, so this catches
  // English Facebook only; add other languages' wording here as reports show
  // it. The /ads/about link ("Why am I seeing this ad?") is kept as a second
  // sign. (Reported 2026-10-31.)
  const FEED_AD = [
    'a[aria-label^="Open ad link"]',
    'a[href*="/ads/about"]'
  ].join(', ');

  // From a link inside a post, climb to the post: the element whose parent
  // is the feed list, recognised as a parent holding at least three
  // post-sized children (tall and nearly full width). A carousel's cards are
  // too narrow to count, so a carousel ad is not mistaken for the feed.
  function postOf(link, main) {
    for (let el = link; el.parentElement && el !== main; el = el.parentElement) {
      const posts = [...el.parentElement.children].filter(c => c.offsetHeight >= 150 && c.offsetWidth >= 400);
      if (posts.length >= 3 && posts.includes(el)) return el;
    }
    return null;
  }

  function hideFeedAds() {
    if (off()) return;
    const main = document.querySelector('[role="main"]');
    if (!main) return;
    for (const a of main.querySelectorAll(FEED_AD)) {
      if (a.closest('[data-bulleblock-hidden]')) continue;
      const post = postOf(a, main);
      if (!post) continue;
      post.setAttribute('data-bulleblock-hidden', 'feed');
      post.style.setProperty('display', 'none', 'important');
      stats.feed++;
    }
  }

  let railQueued = false;
  const queueRail = () => {
    if (railQueued) return;
    railQueued = true;
    requestAnimationFrame(() => { railQueued = false; hideRailAds(); hideFeedAds(); });
  };
  const watchRail = () => {
    new MutationObserver(queueRail).observe(document.body, { childList: true, subtree: true });
    queueRail(); // what is already there
  };
  if (document.body) watchRail();
  else document.addEventListener('DOMContentLoaded', watchRail, { once: true });

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
