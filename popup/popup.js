// Bulle Block - popup. Every change is written to chrome.storage.sync at
// once (§9: settings apply live); background.js watches storage and switches
// rulesets and pause rules to match.

const DEFAULT_SETTINGS = {
  enabled: true,
  cosmetic: true,
  facebook: true,
  lists: {},
  paused: []
};

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-GB');
const stripWww = host => host.replace(/^www\./, '');

document.addEventListener('DOMContentLoaded', async () => {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(null)) };
  const index = await (await fetch(chrome.runtime.getURL('rules/index.json'))).json();
  const save = patch => chrome.storage.sync.set(patch);

  $('version').textContent = `v${chrome.runtime.getManifest().version} · GPL-3.0`;

  // ── Master switch ──────────────────────────────────────────────────────
  const enabled = $('enabled');
  enabled.checked = settings.enabled;
  document.body.classList.toggle('off', !settings.enabled);
  enabled.addEventListener('change', () => {
    document.body.classList.toggle('off', !enabled.checked);
    save({ enabled: enabled.checked });
  });

  // ── Firefox site access ────────────────────────────────────────────────
  const ALL_SITES = { origins: ['<all_urls>'] };
  if (chrome.permissions && !(await chrome.permissions.contains(ALL_SITES))) {
    $('accessBlock').hidden = false;
  }
  $('grantAccess').addEventListener('click', async () => {
    // Straight from the click: Firefox closes the popup when its prompt opens.
    if (await chrome.permissions.request(ALL_SITES)) $('accessBlock').hidden = true;
  });

  // ── This page ──────────────────────────────────────────────────────────
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    const url = new URL(tab?.url || '');
    if (url.protocol === 'http:' || url.protocol === 'https:') host = url.hostname;
  } catch { /* no URL we may read */ }

  const siteOn = $('siteOn');
  if (!host) {
    $('host').textContent = 'Nothing to block on this page.';
    siteOn.closest('.row').hidden = true;
  } else {
    const site = stripWww(host);
    $('host').textContent = site;
    $('host').title = host;
    const pausedHere = () => settings.paused.some(p => site === p || site.endsWith('.' + p));
    siteOn.checked = !pausedHere();
    siteOn.addEventListener('change', () => {
      if (siteOn.checked) {
        // Resume: drop this site and any parent domain that covered it.
        settings.paused = settings.paused.filter(p => !(site === p || site.endsWith('.' + p)));
      } else if (!pausedHere()) {
        settings.paused = [...settings.paused, site];
      }
      save({ paused: settings.paused });
      $('reloadNote').hidden = false;
    });
  }

  // Requests stopped in this tab. getMatchedRules reports rule ids, not
  // actions, so leave out the allow rules and the pause rules.
  let matched = null; // the blocking matches, kept for a "Site broken" report
  if (host && chrome.declarativeNetRequest.getMatchedRules) {
    try {
      const allow = new Map(index.flatMap(e => Object.entries(e.allow)).map(([id, ids]) => [id, new Set(ids)]));
      const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
      matched = rulesMatchedInfo.filter(m => {
        const { rulesetId, ruleId } = m.rule;
        return rulesetId !== '_dynamic' && rulesetId !== '_session' && !allow.get(rulesetId)?.has(ruleId);
      });
      $('blockedCount').textContent = `${fmt(matched.length)} blocked`;
    } catch {
      // Quota exceeded, or this browser wants a permission we do not ask for.
    }
  }

  // ── Report a problem ───────────────────────────────────────────────────
  // Plain text for a GitHub issue. The body goes through the clipboard (a
  // report is too long to trust to a query string); query strings and
  // fragments are stripped from the page address.
  const ISSUES_URL = 'https://github.com/Spillebulle/Bulle-Block/issues';
  const brand = navigator.userAgentData?.brands?.filter(b => !/Not.A.Brand|Chromium/i.test(b.brand)).map(b => `${b.brand} ${b.version}`).join(', ')
    || navigator.userAgent.match(/(Firefox|Vivaldi|Edg|Chrome)\/[\d.]+/)?.[0] || navigator.userAgent;
  const pageUrl = (() => {
    try { const u = new URL(tab.url); return u.origin + u.pathname; } catch { return ''; }
  })();
  const header = kind => [
    `### ${kind}`,
    '',
    `Bulle Block ${chrome.runtime.getManifest().version} on ${brand}`,
    `Lists on: ${index.filter(e => settings.lists[e.id] ?? e.enabled).map(e => e.name).join(', ') || 'none'}`,
    `Hide ad spaces: ${settings.cosmetic ? 'on' : 'off'}. Facebook sponsored posts: ${settings.facebook ? 'on' : 'off'}.`,
    `Blocking on this site: ${siteOn.checked ? 'on' : 'paused'}.`
  ].join('\n');
  const showNote = text => { $('reportNote').textContent = text; $('reportNote').hidden = false; };
  const openIssue = (title, label) => chrome.tabs.create({
    url: `${ISSUES_URL}/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(label)}`
  });

  if (!host) {
    $('reportBlock').querySelectorAll('button').forEach(b => {
      b.disabled = true;
      b.title = 'Open the page with the problem first.';
    });
  }

  $('reportAd').addEventListener('click', async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: c => { window.__bulleblock_pickContext = c; },
        args: [{ header: `${header('Ad got through')}`, issuesUrl: ISSUES_URL }]
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/picker.js'] });
      window.close(); // get out of the way so the next click lands on the page
    } catch {
      showNote('This page does not allow extensions to run on it.');
    }
  });

  $('reportBroken').addEventListener('click', async () => {
    const lines = [header('Site broken'), '', `Page: ${pageUrl}`, '', 'Blocked on this page:'];
    if (!matched) {
      lines.push('  unknown (this browser does not tell extensions)');
    } else if (!matched.length) {
      lines.push('  nothing');
    } else {
      // Name the rule for EasyList-style lists; domain lists only hold domains.
      const byId = new Map();
      for (const e of index) {
        if (e.hiding === undefined) continue;
        for (const rid of e.rulesets) {
          const rules = await (await fetch(chrome.runtime.getURL(`rules/${rid}.json`))).json();
          byId.set(rid, new Map(rules.map(r => [r.id, r.condition.urlFilter || JSON.stringify(r.condition)])));
        }
      }
      const counts = new Map();
      for (const m of matched) {
        const { rulesetId, ruleId } = m.rule;
        const what = byId.get(rulesetId)?.get(ruleId) ?? 'a listed domain';
        const key = `${rulesetId}: ${what}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
        lines.push(`  ${n} × ${key}`);
      }
    }
    lines.push('', 'What broke:', '  (describe it here)');
    await navigator.clipboard.writeText(lines.join('\n'));
    showNote('Report copied. Paste it into the issue.');
    openIssue(`Site broken: ${stripWww(host)}`, 'site broken');
  });

  // ── Feature switches ───────────────────────────────────────────────────
  for (const key of ['cosmetic', 'facebook']) {
    const box = $(key);
    box.checked = settings[key];
    box.addEventListener('change', () => {
      save({ [key]: box.checked });
      if (host) $('reloadNote').hidden = false;
    });
  }

  // ── Block lists ────────────────────────────────────────────────────────
  const tpl = $('listRow');
  for (const entry of index) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const box = row.querySelector('input');
    const id = `list-${entry.id}`;
    box.id = id;
    row.querySelector('.label').textContent = entry.name;
    row.querySelector('.label').htmlFor = id;
    row.querySelector('.about').textContent = entry.about;
    row.querySelector('.count').textContent = entry.hiding !== undefined
      ? `${fmt(entry.rules)} rules, ${fmt(entry.hiding)} to hide`
      : `${fmt(entry.domains)} domains`;
    box.checked = settings.lists[entry.id] ?? entry.enabled;
    box.addEventListener('change', () => {
      settings.lists = { ...settings.lists, [entry.id]: box.checked };
      save({ lists: settings.lists });
    });
    $('lists').appendChild(row);
  }
});
