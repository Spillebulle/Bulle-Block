# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Bulle Block**: a Manifest V3 ad blocker for Chromium browsers (the owner uses
Vivaldi) and Firefox from one folder. Three layers:

1. **Network blocking** with `declarativeNetRequest` static rulesets compiled
   from EasyList, EasyPrivacy and the owner's Pi-hole lists (StevenBlack,
   OISD big, HaGeZi Ultimate / Threat Intelligence / Gambling).
2. **Element hiding** from EasyList's `##` rules, inserted per frame by the
   background at user origin.
3. **Facebook sponsored posts**: a MAIN-world script that filters the feed's
   GraphQL data. Paid posts only; "Suggested for you" and Reels stay, by the
   owner's choice.

Layout and release flow follow `../Pictureframe` (same author); UI follows
`../Design-Principles/STYLE-GUIDE.md` (the `§` numbers in CSS comments point
into it).

## Building

The extension runs from this folder, but `rules/` is **generated and
gitignored**, so compile once before loading it:

```sh
python tools/build_rules.py            # download the lists in tools/lists.json and compile
python tools/build_rules.py --offline  # recompile from tools/.cache
python tools/package.py                # dist/chrome, dist/firefox and a zip of each
python tools/make_icons.py             # icons/ from one SVG via headless Chrome
```

Then `vivaldi://extensions` (or `chrome://extensions`) → Developer mode →
Load unpacked → this folder. After editing, reload the extension card and the
page. Chrome writes an indexed copy of the rules into `_metadata/` here
(gitignored, about 85 MB; safe to delete).

**`manifest.json` is the Chromium manifest**, kept free of Firefox keys so
Vivaldi loads it without warnings. `tools/package.py` derives Firefox's:
`background.scripts` instead of `service_worker` (Firefox has no extension
service worker) plus `browser_specific_settings.gecko`, which lives only in
`package.py`. For Firefox, run `package.py --no-zip` and load
`dist/firefox/manifest.json` in `about:debugging`.

`build_rules.py` also **rewrites `manifest.json`'s
`declarative_net_request.rule_resources`**: a list over 4.5 MB is split into
`<id>-1.json`, `<id>-2.json`, … because addons.mozilla.org's linter refuses to
parse files over 5 MB, so the number of files follows the lists' sizes. Never
edit `rule_resources` by hand. The build fails if more than 50 ruleset files
come out (the browsers' cap on enabled static rulesets).

Limits that shape the compiler: Chrome guarantees 30,000 static rules per
extension and the cap counts **rules, not domains**, so domain lists are
packed 10,000 domains per rule in `requestDomains` (3.1 M domains ≈ 200 rules;
EasyList + EasyPrivacy ≈ 19,000). Subdomains of a listed domain are dropped
since `requestDomains` already covers them. EasyList syntax that DNR cannot
express (regex rules, `$popup`, `$redirect`, `$csp`, `$removeparam`, procedural
cosmetics, `example.*` entities) is skipped and counted in the build output.

## Verifying a change

`test.html`, served over http (`python -m http.server 8765`), checks two ad
requests, one ordinary request and three element-hiding cases. **The owner's
network runs Pi-hole with the same lists**, so ad requests fail even without
the extension: judge network results by error code (`ERR_BLOCKED_BY_CLIENT`
= extension, `ERR_ADDRESS_INVALID` = Pi-hole), not by the page's verdict.
Firefox is not installed on the owner's machine; `npx web-ext@8 lint` on a
packaged copy is the only Firefox check available locally.

The Facebook filter has only been tested against a synthetic GraphQL response
(normal edge, `category: "SPONSORED"` edge, nested `sponsored_data`, and
streamed `path: [..., "edges", n]` lines). Facebook changes this format; when
sponsored posts come back, capture a real `/api/graphql/` response and adjust
`isSponsoredEdge()`.

## Releasing

Like Pictureframe, but a zip per browser: bump `version` in `manifest.json`, add `## X.Y.Z` to
`CHANGELOG.md`, commit, `git tag vX.Y.Z && git push --tags`. The workflow
compiles **fresh lists** (so every release ships that day's lists), runs
`tools/package.py`, lints `dist/firefox`, makes the GitHub release with both
zips, then submits the Chrome zip to the Chrome Web Store and `dist/firefox` to
AMO once their secrets exist (see the header of `release.yml`). `RUNTIME` in
`package.py` lists the runtime paths; a new top-level runtime file must be
added there.

Expected `web-ext lint` warnings: `setExtensionActionOptions` and `getMatchedRules` (both
feature-detected), and `COINMINER_USAGE_DETECTED` on `easyprivacy.json`,
which names coin-miner domains in order to block them.

Gecko ID `bulleblock@spillebulle` is permanent once uploaded to AMO.
`docs/privacy.md` must stay true: no network calls, no data collection.

## Architecture

```
tools/lists.json      the lists: id, name, url, format (hosts | domains | adblock), documents, enabled
tools/build_rules.py  → rules/<id>[-n].json (DNR), rules/<id>.css.json (hiding), rules/index.json
background.js         rulesets on/off, pause rules, insertCSS for hiding, badge count
content/cosmetic.js   every frame, document_start: sends FRAME_START {host}; relays the Facebook switch
content/facebook.js   MAIN world, facebook.com: XHR + fetch GraphQL filter, plus a :has() CSS backstop
content/picker.js     injected on demand by the popup's "Ad got through": element picker + report panel
popup/                the only UI; settings apply live (§9)
```

**Settings** live in `chrome.storage.sync`: `enabled`, `cosmetic`, `facebook`,
`lists {id: bool}` (absent = the list's default from `index.json`), `paused
[host]`. `DEFAULT_SETTINGS` is duplicated in `background.js` and
`popup/popup.js`; change both. `background.js` reapplies rulesets and pause
rules on every storage change.

**Pausing a site** is one dynamic `allowAllRequests` rule per host at
priority 100 (compiled rules use 1 to 3: block 1, allow 2, `$important` 3), and
the background skips element hiding for that host.

**Element hiding** goes through `scripting.insertCSS({origin: 'USER'})` so a
page's own `!important` cannot override it. One rule per selector, so a
selector the browser cannot parse drops only itself. Generic CSS per list is
built once and cached in the worker.

**Facebook's switch** cannot be read from the MAIN world, so
`cosmetic.js` sets `data-bulleblock-facebook="off"` on `<html>`. The XHR
filter is prefix-stable (complete lines only, appended once) because Facebook
reads streaming responses incrementally by offset; keep it that way.

**Reporting** mirrors Pictureframe's misfire reporter: reports are plain text
copied to the clipboard, then `ISSUES_URL/new` opens with a title and a label
(`ad got through` / `site broken`, which exist in the repo). "Ad got through"
injects `content/picker.js` into the top frame only; a full-page transparent
sheet takes the pointer and `elementsFromPoint` looks under it, so ad iframes
are picked whole. Like Pictureframe's viewer, the picker's Shadow DOM uses
literal hexes (dark palette, accent `#5E9DD1`). "Site broken" lists the
matched rules, resolving EasyList-style rule ids to their `urlFilter` by
reading the ruleset file.

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
`shield-ban`, rendered by `tools/make_icons.py`. Copy is British, sentences
with full stops, no em dashes (§12). Logging is prefixed `[Bulle Block]`.
