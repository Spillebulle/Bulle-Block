# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The rule above all others: universal, not site by site

**Bulle Block must work on every site, including sites nobody has reported.
Every fix should be as universal as it can possibly be, and site-specific
fixes should be as few as possible.** A rule that names one domain fixes one
page today and rots when that site redesigns; a rule that targets the *thing
that makes it an ad* fixes that page and every other page built the same way.
The owner has asked for this explicitly and repeatedly. Treat a site-specific
fix as a failure to find the general one, to be accepted only when the
ladder below has been honestly climbed.

When an "Ad got through" or "Site broken" report arrives, work down this
ladder and stop at the **first** rung that fixes it:

1. **The compiler.** Is the ad already covered by a list we ship, but the
   rule was skipped or mistranslated by `tools/build_rules.py`? The build
   prints what it skips. Fixing the compiler fixes every site that rule
   family touches.
2. **A general mechanism in code.** Can the extension behave better
   everywhere? For example: collapsing a container left empty once its ad is
   hidden, or spotting a pattern every ad of a kind shares. This is the best
   kind of fix and should be the first thing considered after rung 1.
3. **A maintained community list.** Does a well-kept list already cover
   this, and the region or category it belongs to? Add it to
   `tools/lists.json` (e.g. Dandelion Sprout's Nordic filters was added for
   Norwegian sites). Other people keep it current; we do not.
4. **A generic rule keyed on the ad system, not the site,** in
   `tools/fixes.txt` with no domain in front. Look through the report for
   the vendor behind the markup: class or id prefixes, data attributes,
   iframe and script hosts. Example: VG and Aftenbladet both reported empty
   boxes classed `advertory-vg-…` and `advertory-sa-…`; the fix was one rule
   on Schibsted's ad system, `##[class^="advertory-"][class*="-wrapper"]`,
   which covers every site that uses it, reported or not.
5. **A site-specific rule. Last resort.** Only when the markup has nothing
   general to hold on to. It goes in `tools/fixes.txt` with the domain
   prefixed and a comment saying why nothing more general worked.

Before writing any rule, ask: *would this also fix the same ad on a site we
have never seen?* If not, keep climbing.

Two further cautions:

- **Matching on visible text is site-specific in disguise.** Text changes
  with the page's language and the site's wording. Prefer structure,
  attributes, ARIA roles and request patterns. The Facebook feed hider's
  English `aria-label^="Open ad link"` is a known, documented compromise, not
  a pattern to copy.
- **No new per-site modules.** `content/facebook.js` exists because the owner
  explicitly asked for Facebook's sponsored posts (and a module for YouTube
  would need the same explicit request). Do not create modules for other
  sites; climb the ladder instead.

## What this is

**Bulle Block**: a Manifest V3 ad blocker for Chromium browsers (the owner uses
Vivaldi) and Firefox, built from one folder. Three layers:

1. **Network blocking** with `declarativeNetRequest` static rulesets compiled
   from EasyList, EasyPrivacy, Dandelion Sprout's Nordic filters, our own
   `tools/fixes.txt`, and the owner's Pi-hole lists (StevenBlack, OISD big,
   HaGeZi Ultimate / Threat Intelligence / Gambling).
2. **Element hiding** from the lists' `##` rules, inserted per frame by the
   background at user origin.
3. **Facebook sponsored posts** (`content/facebook.js`). Paid posts only;
   "Suggested for you" and Reels stay, by the owner's choice.

Layout and release flow follow `../Pictureframe` (same author); UI follows
`../Design-Principles/STYLE-GUIDE.md` (the `§` numbers in CSS comments point
into it). The repository is https://github.com/Spillebulle/Bulle-Block.

## Every change bumps the version

The owner tests by reloading the unpacked extension and tells builds apart by
the version in the popup's footer and in every report's header. So **every
change handed back bumps the patch version** in `manifest.json` (0.1.2 →
0.1.3) and adds a `## X.Y.Z` section to `CHANGELOG.md` (3–8 user-facing
bullets, house voice). State the new number when reporting back. A bump
releases nothing; only a pushed `v*` tag does, and never tag unasked.

## Building

`rules/` is **generated and gitignored**, so compile before loading:

```sh
python tools/build_rules.py            # download the lists in tools/lists.json and compile
python tools/build_rules.py --offline  # recompile from tools/.cache (and tools/fixes.txt)
python tools/package.py                # dist/chrome, dist/firefox and a zip of each
python tools/make_icons.py             # icons/ from one SVG via headless Chrome
```

Then `vivaldi://extensions` → Developer mode → Load unpacked → this folder.
After editing, reload the extension card **and** the page. MAIN-world scripts
(`facebook.js`) keep running in an open tab until it is reloaded, so a stale
tab runs the old code. Chrome writes an indexed copy of the rules into
`_metadata/` here (gitignored, about 85 MB; safe to delete).

**`manifest.json` is the Chromium manifest**, free of Firefox keys so Vivaldi
loads it without warnings. `tools/package.py` derives Firefox's
(`background.scripts` instead of `service_worker`, plus
`browser_specific_settings.gecko`, which lives only there). For Firefox, run
`package.py --no-zip` and load `dist/firefox/manifest.json` in
`about:debugging`.

`build_rules.py` **rewrites `manifest.json`'s
`declarative_net_request.rule_resources`**: a list over 4.5 MB is split into
`<id>-1.json`, `<id>-2.json`, … because addons.mozilla.org's linter refuses
files over 5 MB. Never edit `rule_resources` by hand. The build fails above 50
ruleset files (the browsers' cap on enabled static rulesets).

Compiler limits: Chrome guarantees 30,000 static rules per extension and
counts **rules, not domains**, so domain lists are packed 10,000 domains per
rule in `requestDomains` (3.1 M domains ≈ 200 rules; the adblock-format lists
≈ 20,000). Subdomains of a listed domain are dropped. Syntax DNR cannot
express (regex rules, `$redirect`, `$csp`, `$removeparam`,
scriptlets `##+js(…)`, procedural cosmetics, `example.*` entities) is skipped
and counted; that count is where rung 1 of the ladder starts. A list with only
hiding rules compiles to an empty network ruleset, which is fine.

## Verifying a change

`test.html`, served over http (`python -m http.server 8765`), checks two ad
requests, one ordinary request and three element-hiding cases. **The owner's
network runs Pi-hole with the same lists**, so ad requests fail even without
the extension: judge by error code (`ERR_BLOCKED_BY_CLIENT` = extension,
`ERR_ADDRESS_INVALID` = Pi-hole), not by the page's verdict.

Real sites can be checked headlessly: `puppeteer-core` driving the installed
Chrome or Vivaldi with `enableExtensions: [repoPath]` loads the unpacked
extension (branded Chrome ignores `--load-extension`). This is how the
`advertory` fix was confirmed on vg.no and aftenbladet.no. Facebook cannot be
tested this way (it needs a login), so Facebook changes are tested on
synthetic pages and then by the owner's reports.

Firefox is not installed on the owner's machine; `npx web-ext@8 lint
--source-dir dist/firefox` is the only Firefox check. Expected warnings:
`setExtensionActionOptions` and `getMatchedRules` (both feature-detected) and
`COINMINER_USAGE_DETECTED` on `easyprivacy.json`, which names coin-miner
domains in order to block them.

## Releasing

Commit, then `git tag vX.Y.Z && git push --tags` (the version and changelog
section must already match). The workflow compiles **fresh lists** (every
release ships that day's lists), runs `tools/package.py`, lints
`dist/firefox`, makes the GitHub release with both zips, then submits to the
Chrome Web Store and AMO once their secrets exist (see the header of
`release.yml`). `RUNTIME` in `package.py` lists the runtime paths; a new
top-level runtime file must be added there. The gecko ID
`bulleblock@spillebulle` is permanent once on AMO. `docs/privacy.md` must
stay true: no network calls, no data collection.

## Architecture

```
tools/lists.json      the lists: id, name, url (or path), format (hosts | domains | adblock), documents, enabled
tools/fixes.txt       our own EasyList-syntax rules (rungs 4 and 5 above); one comment per rule: what, why, when
tools/build_rules.py  → rules/<id>[-n].json (DNR), rules/<id>.css.json (hiding), rules/index.json
background.js         rulesets on/off, pause rules, insertCSS for hiding, badge count
content/cosmetic.js   every frame, document_start: sends FRAME_START {host}; relays the Facebook switch
content/facebook.js   MAIN world on facebook.com (see below)
content/picker.js     injected on demand by the popup's "Ad got through": element picker + report panel
popup/                the only UI; settings apply live (§9)
```

**Settings** live in `chrome.storage.sync`: `enabled`, `cosmetic`, `facebook`,
`lists {id: bool}` (absent = the list's default from `index.json`), `paused
[host]`, `noRedirect [domain]`. `DEFAULT_SETTINGS` is duplicated in `background.js` and
`popup/popup.js`; change both. `background.js` reapplies rulesets and pause
rules on every storage change.

**Pausing a site** is one dynamic `allowAllRequests` rule per host at
priority 100 (compiled rules use 1 to 3: block 1, allow 2, `$important` 3), and
the background skips element hiding for that host.

**Stopped redirects** (`content/cosmetic.js`, top frame): the Navigation API's
`navigate` event. Every cross-site navigation the user did not click is
cancelled at once and sent to the background as `CHECK_REDIRECT`; if allowed,
the content script re-issues it (`assign` or `replace`, as the original). The
background stops it when the destination is on the user's `noRedirect` list
or is a whole domain any enabled list blocks. That second check reads
`rules/domains/NN.bin` (written by `build_rules.py`'s `write_domain_table`):
64 shards of sorted 8-byte entries, sha256 bytes 1..6 then 16 list bits
(`domainBit` in `index.json`), one shard read per host suffix. Server-side
redirects cannot be stopped this way.

**Pop-ups** (`background.js`): the lists' `$popup` rules compile to
`rules/<id>.popup.json`, not DNR, because a DNR rule cannot tell a pop-up from
a page the user opened. A tab from `webNavigation.onCreatedNavigationTarget` is
watched for 10 seconds and closed if it lands on a listed address, or if a
"documents" list blocked it. Exceptions from any enabled list win. A watched
tab that lands where a redirect would be stopped (a `noRedirect` domain or a
blocked whole domain) is closed too, whatever the pop-up switch says: the
content script can only hold the tab the page is in.

**Element hiding** goes through `scripting.insertCSS({origin: 'USER'})` so a
page's own `!important` cannot override it. One rule per selector, so a
selector the browser cannot parse drops only itself. Generic CSS per list is
built once and cached in the worker.

**Facebook** (`content/facebook.js`), four parts, because Facebook's data has
proved a moving target:

- *Data filter*: drops sponsored edges (`category: "SPONSORED"` or a
  non-null `sponsored_data`) from GraphQL responses read through hooked
  `XMLHttpRequest`/`fetch`, and from the `<script type="application/json">`
  blocks the first posts arrive in. The XHR filter is prefix-stable
  (complete lines only, appended once) because Facebook reads streaming
  responses by offset. Facebook enforces Trusted Types, so embedded blocks
  are rewritten through their text node, never `script.textContent`.
  Reports have shown the feed's `/api/graphql/` requests opened but never
  read through these hooks, so in practice the next two parts do the work.
- *Feed hider*: a post whose link carries `aria-label^="Open ad link"` (or an
  `/ads/about` link) is hidden. The post is found by climbing to the element
  whose parent holds at least three post-sized children (≥ 150 px tall,
  ≥ 400 px wide), so carousel cards are not mistaken for the feed.
- *Right-column hider*: links through `l.facebook.com/l.php` inside
  `#right_rail_container` mark the Sponsored box; the largest block without
  an ordinary section beside it is hidden.
- *Diagnostics*: counts of hooks, requests, workers and feed items seen,
  returned on a `bulleblock-fb-diagnose` DOM event through the
  `data-bulleblock-fb-diag` attribute, for the picker's report.

The MAIN world cannot read `chrome.storage`, so `cosmetic.js` sets
`data-bulleblock-facebook="off"` on `<html>` when the switch is off.

**Reporting** mirrors Pictureframe's misfire reporter: plain text copied to
the clipboard, then `ISSUES_URL/new` opens with a title and a label (`ad got
through` / `site broken`, both exist in the repo). The picker covers the page
with a transparent sheet and looks under it with `elementsFromPoint`, so ad
iframes are picked whole. **Reports go to a public issue tracker**: page URLs
lose their query strings, inline `data:` images are left out, and the
Facebook section lists other feed items by kind only, never their profile
links. Keep it that way when adding to a report. Like Pictureframe's viewer,
the picker's Shadow DOM uses literal hexes (dark palette, accent `#5E9DD1`).

**Blocked count**: the badge uses `displayActionCountAsBadgeText`; the popup
uses `getMatchedRules` (granted by `activeTab`) and leaves out the allow rule
ids that `index.json` lists per ruleset.

## Styling

`tokens.css` is a vendored copy of `../Design-Principles/tokens.css` with only
`--accent-h: 245` (steel blue) changed, picked for the widest gap between
siblings' real hues: Brokey 18, Windup 28, Umber 68, Muster 200, Pictureframe
289 (its hard-coded `#6a4cce`; its tokens comment says 254, which is wrong),
HomeLab 349. Measure a sibling's actual colour, not its comment. Re-copy and
re-apply that one edit when the house file changes. No raw hex in popup CSS.
The icon is the accent square (light-theme accent `#3977A8`) with Lucide's
`shield-ban`, rendered by `tools/make_icons.py`; icons are Lucide only. Copy
is British, sentences with full stops, no em dashes (§12). Logging is
prefixed `[Bulle Block]`.
