// Bulle Block - "Ad got through" picker. Injected on demand by the popup into
// the top frame of the active tab (never declared in the manifest), after the
// popup has set window.__bulleblock_pickContext = {header, issuesUrl}.
//
// A transparent sheet covers the page and takes every pointer event, so the
// page never sees the pick click, and iframes (where most ads live) can be
// picked as a whole: elementsFromPoint looks underneath the sheet.
//
// Like Pictureframe's viewer, this renders inside arbitrary pages, so its
// Shadow DOM redeclares the house dark palette as literal hexes.

(() => {
  if (window.__bulleblock_picking) return;
  window.__bulleblock_picking = true;
  const ctx = window.__bulleblock_pickContext || { header: '', issuesUrl: '' };

  const host = document.createElement('bulleblock-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .sheet { position: fixed; inset: 0; cursor: crosshair; }
      .box { position: fixed; pointer-events: none; border: 2px solid #5E9DD1; background: rgba(94, 157, 209, 0.12); border-radius: 3px; display: none; }
      .tag { position: fixed; pointer-events: none; background: #17181A; color: #E6E7E9; border: 1px solid #26282B; border-radius: 3px; padding: 2px 6px; font: 10.5px ui-monospace, Consolas, monospace; display: none; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hint, .panel { position: fixed; left: 50%; transform: translateX(-50%); background: #17181A; color: #C9CBCE; border: 1px solid #2C2E32; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); font: 12px "Archivo", system-ui, "Segoe UI", sans-serif; }
      .hint { top: 12px; padding: 8px 12px; }
      .hint b { color: #E6E7E9; font-weight: 600; }
      .panel { top: 12px; width: min(560px, 92vw); padding: 12px; display: none; flex-direction: column; gap: 8px; }
      .panel h2 { font-size: 13px; font-weight: 600; color: #E6E7E9; }
      .panel p { color: #9A9DA2; font-size: 11px; }
      textarea { width: 100%; height: 180px; resize: vertical; background: #111214; color: #C9CBCE; border: 1px solid #26282B; border-radius: 5px; padding: 6px 8px; font: 10.5px ui-monospace, Consolas, monospace; }
      .row { display: flex; gap: 6px; justify-content: flex-end; }
      button { height: 26px; padding: 0 10px; border-radius: 5px; border: 1px solid #26282B; background: #1F2023; color: #E6E7E9; font: 500 11.5px "Archivo", system-ui, "Segoe UI", sans-serif; cursor: pointer; }
      button:hover { background: #26282B; }
      button.primary { background: #5E9DD1; border-color: #5E9DD1; color: #111214; font-weight: 600; }
    </style>
    <div class="sheet"></div>
    <div class="box"></div>
    <div class="tag"></div>
    <div class="hint"><b>Click the ad that got through.</b> Esc cancels.</div>
    <div class="panel">
      <h2>Report copied</h2>
      <p>Paste it into the issue that opens. Page addresses have their query strings removed.</p>
      <textarea readonly></textarea>
      <div class="row">
        <button class="cancel">Close</button>
        <button class="copy">Copy again</button>
        <button class="primary open">Open GitHub issue</button>
      </div>
    </div>`;
  const $ = s => root.querySelector(s);
  const sheet = $('.sheet');
  document.documentElement.appendChild(host);

  let current = null;

  function under(x, y) {
    return document.elementsFromPoint(x, y).find(el => el !== host && !host.contains(el)) || null;
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    for (const c of el.classList) s += '.' + c;
    return s;
  }

  // data: and blob: images are drawn in the page; they name no address.
  const inline = url => /^(data|blob|javascript):/i.test(url);

  function strip(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin + u.pathname;
    } catch {
      return String(url).split(/[?#]/)[0];
    }
  }

  function onMove(e) {
    const el = under(e.clientX, e.clientY);
    if (!el || el === document.documentElement || el === document.body) {
      $('.box').style.display = $('.tag').style.display = 'none';
      current = null;
      return;
    }
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign($('.box').style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const tag = $('.tag');
    tag.textContent = `${describe(el)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
    Object.assign(tag.style, { display: 'block', left: Math.max(4, r.left) + 'px', top: Math.max(4, r.top - 22) + 'px' });
  }

  function buildReport(el) {
    const chain = [];
    for (let n = el; n && n !== document.documentElement && chain.length < 8; n = n.parentElement) {
      chain.push('  ' + describe(n));
    }
    const resources = new Set();
    const collect = n => {
      const src = n.currentSrc || n.src || n.getAttribute?.('data-src');
      if (src && typeof src === 'string' && !inline(src)) resources.add(`  ${n.tagName.toLowerCase()} ${strip(src)}`);
      if (n.tagName === 'A' && n.href) resources.add(`  a ${strip(n.href)}`);
      const bg = n.nodeType === 1 && getComputedStyle(n).backgroundImage;
      const m = bg && bg.match(/url\(["']?([^"')]+)/);
      if (m && !inline(m[1])) resources.add(`  background ${strip(m[1])}`);
    };
    collect(el);
    el.querySelectorAll('iframe, img, video, source, a, [style*="background"], embed, object').forEach(collect);
    const r = el.getBoundingClientRect();
    let html = el.outerHTML.replace(/\s+/g, ' ');
    if (html.length > 800) html = html.slice(0, 800) + ' …';

    return [
      ctx.header,
      '',
      `Page: ${strip(location.href)}`,
      `Element (${Math.round(r.width)} × ${Math.round(r.height)}), innermost first:`,
      ...chain,
      'Loads from:',
      ...(resources.size ? [...resources].slice(0, 25) : ['  nothing visible (a script may have drawn it)']),
      ...facebookDiagnosis(el),
      '',
      'HTML (first 800 characters):',
      '```html',
      html,
      '```'
    ].join('\n');
  }

  // On Facebook, ask content/facebook.js (page world) what the feed filter
  // saw, and match its items to the picked post by the page links inside it.
  function facebookDiagnosis(el) {
    if (!/(^|\.)facebook\.com$/.test(location.hostname)) return [];
    document.documentElement.removeAttribute('data-bulleblock-fb-diag');
    document.dispatchEvent(new CustomEvent('bulleblock-fb-diagnose'));
    let diag;
    try {
      diag = JSON.parse(document.documentElement.getAttribute('data-bulleblock-fb-diag'));
    } catch {
      diag = null;
    }
    if (!diag) {
      return ['', 'Facebook filter: did not answer. Reload the Facebook tab: after Bulle Block is updated or reloaded, the old copy of the filter keeps running in an open tab until the page reloads.'];
    }
    const { stats, seen } = diag;
    const links = new Set([...el.querySelectorAll('a[href]')].map(a => strip(a.href)));
    const match = seen.filter(s => s.links.some(l => links.has(l)));
    const where = el.closest('#right_rail_container, [role="complementary"]') ? 'the right column'
      : el.closest('[role="feed"]') ? 'the feed'
      : el.closest('[role="main"]') ? 'the main column' : 'neither column';
    const types = Object.entries(stats.xhrGraphqlTypes || {}).map(([t, n]) => `${t} ×${n}`).join(', ');
    const lines = [
      '',
      `Facebook filter: ${stats.items} feed items seen in ${stats.html} page blocks, ${stats.xhr} XHR and ${stats.fetch} fetch responses; ${stats.removed} removed; hidden on the page: ${stats.feed ?? 0} feed posts, ${stats.rail ?? 0} right-column ads.`,
      `Hooks saw: ${stats.xhrOpened} XHR opened (${stats.xhrGraphql} to /api/graphql/${types ? `, read as ${types}` : ''}), ${stats.fetchCalls} fetch calls (${stats.fetchGraphql} to /api/graphql/), workers started: ${stats.workers?.length ? stats.workers.join(', ') : 'none'}.`,
      ...requestSummary(),
      `Picked element is in ${where}.`,
      ...postLinks(el)
    ];
    if (match.length) {
      lines.push('Feed items matching this post:');
      for (const s of match) {
        lines.push(`  [${s.source}${s.cut ? ', removed' : ''}] category=${s.category} type=${s.type} ${s.links.slice(0, 2).join(' ')}`);
        lines.push(`    marks: ${s.marks.length ? s.marks.join('; ') : 'none'}`);
      }
    } else {
      // Kinds only. Other items' links are other people's profiles, and a
      // report is meant for a public issue tracker.
      const kinds = new Map();
      for (const s of seen) {
        const k = `${s.source}/${s.type}${s.category ? `/${s.category}` : ''}`;
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
      lines.push(seen.length ? 'No feed item matched this post. Kinds seen (last 80):' : 'No feed items seen at all.');
      for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`  ${n} × ${k}`);
    }
    return lines;
  }

  // Requests this page has made to facebook.com, by path, from the browser's
  // own resource timing. Requests made in a worker or another frame are not
  // in this document's timing, which is itself worth knowing.
  function requestSummary() {
    const counts = new Map();
    for (const e of performance.getEntriesByType('resource')) {
      if (e.initiatorType !== 'xmlhttprequest' && e.initiatorType !== 'fetch' && e.initiatorType !== 'beacon') continue;
      let u;
      try { u = new URL(e.name); } catch { continue; }
      if (!/(^|\.)facebook\.com$/.test(u.hostname)) continue;
      const key = `${e.initiatorType} ${u.hostname === location.hostname ? '' : u.hostname}${u.pathname}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) return ['Page requests to facebook.com: none in this page\'s timing.'];
    return ['Page requests to facebook.com:', ...[...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `  ${n} × ${k}`)];
  }

  // The first links in the post, in page order: the header comes first,
  // with the advertiser and the "Sponsored" link. Query values are left out
  // except __tn__, Facebook's code for what kind of link it is.
  function postLinks(el) {
    const out = [];
    for (const a of el.querySelectorAll('a')) {
      if (out.length >= 8) break;
      const raw = a.getAttribute('href') || '';
      let desc;
      try {
        const u = new URL(raw, location.href);
        const keys = [...new Set([...u.searchParams.keys()])];
        const tn = u.searchParams.get('__tn__');
        desc = `${raw.startsWith('#') ? raw.slice(0, 12) : u.hostname === location.hostname ? u.pathname : u.hostname + u.pathname}`
          + (keys.length ? ` ?${keys.join('&')}` : '') + (tn ? ` __tn__=${tn}` : '');
      } catch {
        desc = raw.slice(0, 40);
      }
      const label = a.getAttribute('aria-label');
      out.push(`  a ${desc || '(no href)'}${label && label.length <= 40 ? ` aria-label="${label}"` : ''}`);
    }
    return out.length ? ['First links in the post:', ...out] : [];
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = $('textarea');
      ta.focus();
      ta.select();
      document.execCommand('copy');
    }
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function finish() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__bulleblock_picking = false;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      swallow(e);
      finish();
    }
  }

  sheet.addEventListener('mousemove', onMove);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu']) {
    sheet.addEventListener(type, swallow);
  }
  sheet.addEventListener('click', async e => {
    swallow(e);
    const el = current || under(e.clientX, e.clientY);
    if (!el) return;
    const report = buildReport(el);
    sheet.style.display = $('.box').style.display = $('.tag').style.display = $('.hint').style.display = 'none';
    $('textarea').value = report;
    $('.panel').style.display = 'flex';
    await copy(report);

    const title = `Ad got through on ${location.hostname.replace(/^www\./, '')}`;
    $('.copy').onclick = () => copy(report);
    $('.cancel').onclick = finish;
    $('.open').onclick = () => {
      window.open(`${ctx.issuesUrl}/new?title=${encodeURIComponent(title)}&labels=ad+got+through`, '_blank', 'noopener');
      finish();
    };
  });
  window.addEventListener('keydown', onKey, true);
})();
