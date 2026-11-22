# Changelog

## 0.1.6

- Stop redirects to now covers everything the block lists block, about 2.6 million domains, as well as the ones you add yourself.
- A page that tries to send you to an ad, tracker, scam or gambling site keeps you where you are instead.
- New tabs a page opens on those domains are closed too, as with your own list.
- Only lists you have switched on count, and pausing a site still lets everything through. Links you click still work.
- Redirects the website's server makes before a page loads still cannot be stopped.

## 0.1.5

- Stop redirects to now covers new tabs as well. A tab a page opens on a domain from your list is closed straight away.
- Before, the list only stopped the tab you were in from being sent away, so an ad opened in a second tab got through.
- This works even with Close ad pop-ups switched off, since the list is your own. Pausing a site still lets everything through.
- A link to a listed domain that you open in a new tab yourself is closed too. Remove the domain from the list to visit it that way.

## 0.1.4

- New tabs opened by ads are now closed straight away, using about 3,000 pop-up rules from EasyList and the Nordic filters.
- It follows the ad through its redirects, so a pop-up that starts blank or hops between addresses is caught too.
- Pop-ups to sites the threat and gambling lists stop close too, instead of leaving an error tab.
- Only tabs opened by a page are affected. Turn it off with Close ad pop-ups in the popup, or pause the site.

## 0.1.3

- New in the popup: Stop redirects to. Add a domain and pages can no longer send you there, so you stay on the page you were reading.
- Links you click yourself still work, and pausing a site lets its redirects through.
- Redirects made by a site's server cannot be stopped this way, only those made by the page.

## 0.1.2

- The empty boxes left by ads on VG, Stavanger Aftenblad and other Schibsted sites are removed, so the page closes up.
- New list: Nordic filters by Dandelion Sprout, for ads on Norwegian and Danish sites.
- New list: Bulle Block fixes, our own rules for ads the other lists miss, written from your reports.

## 0.1.1

- Facebook: sponsored posts in the feed are hidden where they appear, by their "Open ad link" label. English Facebook only for now.
- Facebook: the Sponsored box in the right column is hidden.
- Facebook: sponsored posts written into the page when it first loads are filtered out too.
- Ad reports from Facebook say what the filter saw, without naming other people's profiles.
- Ad reports no longer list inline images as addresses.

## 0.1.0

- Blocks ads, trackers and malware on every site with EasyList, EasyPrivacy and five DNS block lists, over three million domains in all.
- Hides the empty boxes and banners ads leave behind, at a priority pages cannot override.
- Removes paid sponsored posts from the Facebook feed. Suggestions and Reels stay.
- Turn blocking off for one site from the popup when it breaks, or switch any list off.
- The toolbar icon counts what was blocked on the page.
- Report a problem from the popup: click an ad that got through, or report a broken site, and paste the copied report into a GitHub issue.
