// Bulle Block - background (service worker in Chrome, event page in Firefox).
//
// Owns everything content scripts cannot do: switching the compiled rulesets
// on and off, the per-site pause rules, and inserting element-hiding CSS into
// each frame at user origin so a page's own !important cannot undo it.

const DEFAULT_SETTINGS = {
  enabled: true,        // the master switch in the popup
  cosmetic: true,       // hide the empty boxes and walls ads leave behind
  facebook: true,       // drop sponsored posts from the Facebook feed
  lists: {},            // ruleset id -> bool; missing means the list's default
  paused: []            // hostnames (no leading www.) where nothing is blocked
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

// ── Messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FRAME_START' && sender.tab) {
    (async () => {
      const settings = await getSettings();
      const host = msg.host || '';
      const active = settings.enabled && !isPaused(settings, host);
      const reply = { facebook: active && settings.facebook };
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
