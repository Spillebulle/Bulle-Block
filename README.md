<p align="center">
  <img alt="Bulle Block" src="icons/icon128.png" width="96">
</p>

<p align="center">
  A browser extension that <b>blocks ads, trackers and malware</b> on every site, with your own block lists.
  <br>
  Manifest V3 · Vivaldi, Chrome, Edge, Brave and Firefox · Nothing leaves your browser
</p>

> Bulle Block is new and not in any store yet. See [What is not there yet](#what-is-not-there-yet).

## Install

The block lists are compiled, not committed, so build them once first (Python 3, no packages needed):

```sh
python tools/build_rules.py
```

| Browser | How |
| :--- | :--- |
| Vivaldi, Chrome, Edge, Brave | Open `vivaldi://extensions` (or `chrome://extensions`), turn on **Developer mode**, choose **Load unpacked** and pick the folder. |
| Firefox 140 or later | Run `python tools/package.py --no-zip`, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on** and pick `dist/firefox/manifest.json`. Firefox removes it when it restarts. |

The first install takes a few seconds while the browser indexes three million domains. In Firefox, if the popup says Bulle Block has no site access, choose **Allow on all sites**.

## What it blocks

- **Ads and trackers** from EasyList and EasyPrivacy.
- **Ad, tracking and malware domains** from the same lists a Pi-hole uses: StevenBlack, OISD big and HaGeZi Ultimate.
- **Dangerous and gambling sites** from HaGeZi Threat Intelligence and Gambling. These two also stop you visiting the sites, not only loading from them.
- **The spaces ads leave behind**: empty boxes, banners and placeholders are hidden, at a priority pages cannot override.
- **Facebook sponsored posts.** Paid posts are taken out of the feed before Facebook draws them. Suggested posts and Reels are left alone.

Every list can be switched off in the popup. If a site breaks, turn off **Block on this site** for it.

## Reporting a problem

Choose **Ad got through** in the toolbar popup and click the ad: the page never sees that click. Bulle Block copies a report of the element and the addresses it loads from. **Site broken** copies a report of what was blocked on the page. Paste either into the [new issue](https://github.com/Spillebulle/Bulle-Block/issues/new) that opens. Query strings are removed from page addresses.

## What is not there yet

- **Not in the stores.** Install it unpacked for now.
- **Lists update with releases.** Each release ships that day's lists; the extension does not download lists itself, because Manifest V3 only lets an extension add a few thousand rules at run time.
- **YouTube ads are not handled.** They come from YouTube itself, like Facebook's, and need their own module.
- **Firefox is untested in a real browser.** It passes Mozilla's linter.
- **The Facebook filter will need upkeep.** Facebook changes its feed format every few months.

## Licence

GPL-3.0, see [LICENSE](LICENSE). Includes Archivo (SIL Open Font License, `fonts/OFL.txt`), icon geometry from Lucide (ISC), and compiled rules from EasyList and EasyPrivacy (GPL-3.0 / CC BY-SA 3.0), StevenBlack hosts (MIT), HaGeZi (GPL-3.0) and OISD (terms at oisd.nl).
