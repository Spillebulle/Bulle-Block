// Bulle Block - background (service worker in Chrome, event page in Firefox).
//
// Owns everything content scripts cannot do: switching the compiled rulesets
// on and off, the per-site pause rules, and inserting element-hiding CSS into
// each frame at user origin so a page's own !important cannot undo it.

const DEFAULT_SETTINGS = {
  enabled: true,        // the master switch in the popup
  cosmetic: true,       // hide the empty boxes and walls ads leave behind
  facebook: true,       // drop sponsored posts from the Facebook feed
  popups: true,         // close new tabs that ads open
  lists: {},            // ruleset id -> bool; missing means the list's default
  paused: [],           // hostnames (no leading www.) where nothing is blocked
  noRedirect: []        // domains (no leading www.) pages may not redirect to
};

const PAUSE_PRIORITY = 100; // above every compiled rule (1 to 3)

// rules/index.json is written by tools/build_rules.py and lists every ruleset.
let indexPromise = null;
function getIndex() {
  indexPromise ??= fetch(chrome.runtime.getURL('rules/index.json')).then(r => r.json());
  return indexPromise;
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(null)) };
}

function listOn(settings, entry) {
  return settings.lists[entry.id] ?? entry.enabled;
}

function stripWww(host) {
  return host.replace(/^www\./, '');
}

function isPaused(settings, host) {
  host = stripWww(host);
  return settings.paused.some(p => host === p || host.endsWith('.' + p));
}

// ── Network rules ──────────────────────────────────────────────────────────

async function applyRulesets(settings) {
  const index = await getIndex();
  // A big list is split across several ruleset files; they switch together.
  const want = new Set(settings.enabled ? index.filter(e => listOn(settings, e)).flatMap(e => e.rulesets) : []);
  const have = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = [...want].filter(id => !have.has(id));
  const disableRulesetIds = [...have].filter(id => !want.has(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    } catch (err) {
      console.warn('[Bulle Block] Could not switch rulesets.', err);
    }
  }
}

// One allowAllRequests rule per paused site: it trusts the page and every
// request the page makes, in every frame, which is what "pause here" means.
async function applyPauses(settings) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = settings.paused.map((host, i) => ({
    id: i + 1,
    priority: PAUSE_PRIORITY,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [host], resourceTypes: ['main_frame', 'sub_frame'] }
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map(r => r.id),
    addRules
  });
}

async function applyAll() {
  const settings = await getSettings();
  await applyRulesets(settings);
  await applyPauses(settings);
}

// ── Element hiding ─────────────────────────────────────────────────────────

const cosmeticCache = new Map(); // list id -> parsed rules/<id>.css.json
async function getCosmetic(id) {
  if (!cosmeticCache.has(id)) {
    cosmeticCache.set(id, fetch(chrome.runtime.getURL(`rules/${id}.css.json`)).then(r => r.json()));
  }
  return cosmeticCache.get(id);
}

// sub.example.com -> [sub.example.com, example.com, com]
function hostSuffixes(host) {
  const parts = host.split('.');
  return parts.map((_, i) => parts.slice(i).join('.'));
}

const genericCss = new Map(); // list id -> CSS for its generic selectors, built once
function cssFor(selectors) {
  // One rule per selector: a selector this browser cannot parse then drops
  // only itself instead of taking a whole comma-separated group with it.
  return selectors.map(s => `${s}{display:none!important}`).join('\n');
}

async function hidingCss(settings, host) {
  const index = await getIndex();
  const suffixes = hostSuffixes(host);
  const parts = [];
  for (const entry of index) {
    if (entry.hiding === undefined || !listOn(settings, entry)) continue;
    const c = await getCosmetic(entry.id);
    if (suffixes.some(s => c.elemhide.includes(s))) continue;

    const exceptions = new Set(suffixes.flatMap(s => c.exceptions[s] ?? []));
    if (!suffixes.some(s => c.generichide.includes(s))) {
      if (exceptions.size === 0) {
        if (!genericCss.has(entry.id)) genericCss.set(entry.id, cssFor(c.generic));
        parts.push(genericCss.get(entry.id));
      } else {
        parts.push(cssFor(c.generic.filter(s => !exceptions.has(s))));
      }
    }
    const specific = suffixes.flatMap(s => c.specific[s] ?? []).filter(s => !exceptions.has(s));
    if (specific.length) parts.push(cssFor(specific));
  }
  return parts.join('\n');
}

// ── Pop-ups ────────────────────────────────────────────────────────────────
// The lists' $popup rules. DNR cannot express them: a blocking rule cannot
// tell a pop-up from a page the user opened, and would leave an error tab
// besides. So a tab opened by a page is watched briefly and closed if it lands
// on a listed address; ordinary browsing is never looked at.

const POPUP_WATCH_MS = 10_000; // long enough for an ad's chain of redirects
const SEPARATOR = '(?:[^\\w.%-]|$)'; // the ^ of EasyList patterns

function patternRegex(rule) {
  const flags = rule.isUrlFilterCaseSensitive ? '' : 'i';
  if (rule.regex) return new RegExp(rule.urlFilter.slice(1, -1), flags);
  let pattern = rule.urlFilter, start = '', end = '';
  if (pattern.startsWith('||')) {
    start = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?';
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('|')) {
    start = '^';
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith('|')) {
    end = '$';
    pattern = pattern.slice(0, -1);
  }
  const body = pattern.replace(/[\\^$.*+?()[\]{}|]/g, c => c === '*' ? '.*' : c === '^' ? SEPARATOR : `\\${c}`);
  return new RegExp(start + body + end, flags);
}

function compilePopupRules(rules) {
  return rules.flatMap(rule => {
    try {
      return [{ ...rule, re: patternRegex(rule) }];
    } catch {
      return []; // a pattern this browser's regex engine will not take
    }
  });
}

const popupLists = new Map(); // list id -> { hosts, block, allow }, built once
function getPopupList(id) {
  if (!popupLists.has(id)) {
    popupLists.set(id, fetch(chrome.runtime.getURL(`rules/${id}.popup.json`)).then(r => r.json()).then(raw => ({
      hosts: new Set(raw.hosts),
      block: compilePopupRules(raw.block),
      allow: compilePopupRules(raw.allow)
    })));
  }
  return popupLists.get(id);
}

// Close enough for "third party": a.co.uk and b.co.uk count as one site, so
// the error is a pop-up left open, never a good one closed.
const siteOf = host => host.split('.').slice(-2).join('.');

function ruleApplies(rule, url, host, opener) {
  const openers = hostSuffixes(opener);
  if (rule.initiatorDomains && !rule.initiatorDomains.some(d => openers.includes(d))) return false;
  if (rule.excludedInitiatorDomains?.some(d => openers.includes(d))) return false;
  if (rule.domainType) {
    const third = siteOf(host) !== siteOf(opener);
    if (third !== (rule.domainType === 'thirdParty')) return false;
  }
  return rule.re.test(url);
}

async function isAdPopup(settings, url, opener) {
  const host = new URL(url).hostname;
  const suffixes = hostSuffixes(host);
  let hit = false;
  for (const entry of await getIndex()) {
    if (!entry.popups || !listOn(settings, entry)) continue;
    const list = await getPopupList(entry.id);
    if (list.allow.some(r => ruleApplies(r, url, host, opener))) return false;
    hit ||= suffixes.some(s => list.hosts.has(s)) || list.block.some(r => ruleApplies(r, url, host, opener));
  }
  return hit;
}

const watchedPopups = new Map(); // tab id -> { opener: Promise<host>, until }

async function popupMayClose(tabId) {
  const watch = watchedPopups.get(tabId);
  if (!watch) return null;
  if (Date.now() > watch.until) {
    watchedPopups.delete(tabId);
    return null;
  }
  const settings = await getSettings();
  const opener = await watch.opener;
  if (!settings.enabled || !opener || isPaused(settings, opener)) return null;
  return { settings, opener };
}

// ── Stopped redirects ──────────────────────────────────────────────────────
// A page may not send the tab to a domain on the user's "Stop redirects to"
// list, nor to any whole domain an enabled list blocks. content/cosmetic.js
// holds the tab the page is in and asks here; a new tab a page opens is
// checked by the pop-up watcher below. The pop-up switch does not gate this.

// rules/domains/NN.bin, written by tools/build_rules.py (write_domain_table):
// sorted 8-byte entries, sha256 bytes 1..6 of the domain then 16 list bits.
const DOMAIN_SHARDS = 64;
const domainShards = new Map(); // shard number -> Promise<DataView>
function getDomainShard(n) {
  if (!domainShards.has(n)) {
    const name = n.toString(16).padStart(2, '0');
    domainShards.set(n, fetch(chrome.runtime.getURL(`rules/domains/${name}.bin`))
      .then(r => r.arrayBuffer())
      .then(buf => new DataView(buf))
      .catch(() => new DataView(new ArrayBuffer(0)))); // an old build without the table
  }
  return domainShards.get(n);
}

async function domainBits(domain) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(domain)));
  const key = h[1] * 2 ** 40 + h[2] * 2 ** 32 + ((h[3] << 24) >>> 0) + (h[4] << 16) + (h[5] << 8) + h[6];
  const view = await getDomainShard(h[0] % DOMAIN_SHARDS);
  let lo = 0, hi = view.byteLength / 8 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, at = mid * 8;
    const k = view.getUint16(at) * 2 ** 32 + view.getUint32(at + 2);
    if (k === key) return view.getUint16(at + 6);
    if (k < key) lo = mid + 1; else hi = mid - 1;
  }
  return 0;
}

async function blockListed(settings, host) {
  let mask = 0;
  for (const entry of await getIndex()) {
    if (entry.domainBit !== undefined && listOn(settings, entry)) mask |= 1 << entry.domainBit;
  }
  if (!mask) return false;
  // Every suffix with a dot: the lists name parents, and cover their subdomains.
  for (const s of hostSuffixes(host).slice(0, -1)) {
    if (await domainBits(s) & mask) return true;
  }
  return false;
}

// from: the site the page is on. Staying on one host is never a redirect.
async function isStoppedRedirect(settings, url, from) {
  const host = stripWww(new URL(url).hostname);
  if (!host || host === stripWww(from)) return false;
  return settings.noRedirect.some(d => host === d || host.endsWith('.' + d)) ||
    await blockListed(settings, host);
}

function closePopup(tabId, why) {
  watchedPopups.delete(tabId);
  console.info(`[Bulle Block] Closed a pop-up: ${why}.`);
  chrome.tabs.remove(tabId).catch(() => {}); // the user got there first
}

async function checkPopup(tabId, url) {
  if (!/^(https?|data):/.test(url)) return; // about:blank, before the ad fills it in
  const ok = await popupMayClose(tabId);
  if (!ok) return;
  if (await isStoppedRedirect(ok.settings, url, ok.opener) ||
      (ok.settings.popups && await isAdPopup(ok.settings, url, ok.opener))) {
    closePopup(tabId, new URL(url).hostname || 'inline page');
  }
}

chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
  // Set before anything is awaited: the new tab's navigation events are close behind.
  watchedPopups.set(tabId, {
    until: Date.now() + POPUP_WATCH_MS,
    opener: chrome.tabs.get(sourceTabId).then(t => new URL(t.url).hostname).catch(() => '')
  });
  checkPopup(tabId, url);
});

for (const event of [chrome.webNavigation.onBeforeNavigate, chrome.webNavigation.onCommitted]) {
  event.addListener(({ tabId, frameId, url }) => {
    if (frameId === 0) checkPopup(tabId, url);
  });
}

// A pop-up to a site the "blocks visiting" lists stop would stay as an error tab.
chrome.webNavigation.onErrorOccurred.addListener(async ({ tabId, frameId, error, url }) => {
  if (frameId !== 0 || !/BLOCKED_BY_CLIENT/.test(error)) return;
  const ok = await popupMayClose(tabId);
  if (ok?.settings.popups) closePopup(tabId, new URL(url).hostname);
});

// ── Messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FRAME_START' && sender.tab) {
    (async () => {
      const settings = await getSettings();
      const host = msg.host || '';
      const active = settings.enabled && !isPaused(settings, host);
      const reply = { facebook: active && settings.facebook, stopRedirects: active };
      if (active && settings.cosmetic && host) {
        const css = await hidingCss(settings, host);
        if (css) {
          await chrome.scripting.insertCSS({
            target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
            css,
            origin: 'USER'
          }).catch(() => {}); // the frame navigated away first
        }
      }
      sendResponse(reply);
    })();
    return true; // async sendResponse
  }
  if (msg?.type === 'CHECK_REDIRECT' && sender.tab) {
    (async () => {
      const settings = await getSettings();
      const from = msg.from || '';
      const stop = settings.enabled && !isPaused(settings, from) &&
        await isStoppedRedirect(settings, msg.url, from).catch(() => false);
      sendResponse({ stop });
    })();
    return true;
  }
  return false;
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(null);
  const seed = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[k] === undefined) seed[k] = v;
  }
  if (Object.keys(seed).length) await chrome.storage.sync.set(seed);
  await applyAll();
});

chrome.runtime.onStartup.addListener(applyAll);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled || changes.lists || changes.paused) applyAll();
});

// Per-tab count of blocked requests on the toolbar icon.
try {
  chrome.declarativeNetRequest.setExtensionActionOptions?.({ displayActionCountAsBadgeText: true });
  // Literals: the badge API takes no CSS variables. Dark --control-hover and --text-strong.
  chrome.action.setBadgeBackgroundColor({ color: '#26282B' });
  chrome.action.setBadgeTextColor?.({ color: '#E6E7E9' });
} catch (err) {
  console.warn('[Bulle Block] No badge count in this browser.', err);
}
