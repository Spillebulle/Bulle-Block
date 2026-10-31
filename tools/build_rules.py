#!/usr/bin/env python3
"""Compile the block lists in tools/lists.json into what the extension loads.

    python tools/build_rules.py            download every list, then compile
    python tools/build_rules.py --offline  compile from tools/.cache only

Writes, all generated and never edited by hand:

    rules/<id>.json      a declarativeNetRequest ruleset per list; lists too
                         big for one 4.5 MB file become <id>-1.json, <id>-2.json
    rules/<id>.css.json  element hiding for adblock-format lists
    rules/index.json     what the popup shows: names, counts, defaults
    manifest.json        only its declarative_net_request.rule_resources,
                         which therefore follows the lists' sizes

The domain lists (hosts files and DNS blocklists) collapse to a handful of
rules each, because one rule's requestDomains array can hold any number of
domains and Chrome's ruleset cap counts rules, not domains. EasyList's
network patterns map almost one to one onto DNR's urlFilter, which was
modelled on the same syntax; what does not map (regular expressions, redirects,
header and CSP rules, uBO-only options) is skipped and counted.
"""

import argparse
import json
import re
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
OUT = ROOT / "rules"

DOMAIN_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)+$")
SIMPLE_DOMAIN_RULE = re.compile(r"^\|\|([a-z0-9._-]+)\^\|?$")
DOMAINS_PER_RULE = 10_000
# addons.mozilla.org's linter refuses to parse a file over 5 MB and fails the
# upload, so big lists are split across several ruleset files ("parts").
PART_BYTES = 4_500_000

# Hosts files list the machine's own names first; none of them are ads.
HOSTS_IGNORE = {
    "localhost", "localhost.localdomain", "local", "broadcasthost",
    "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix",
    "ip6-allnodes", "ip6-allrouters", "ip6-allhosts", "0.0.0.0",
}

# Everything a page loads, which is what a DNS blocker stops. main_frame is
# added only for lists marked "documents", so a click on a search result still
# goes where it says unless the site itself is dangerous.
SUBRESOURCES = [
    "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "media", "websocket", "other",
]

ABP_TYPES = {
    "script": "script", "image": "image", "stylesheet": "stylesheet", "css": "stylesheet",
    "object": "object", "object-subrequest": "object", "xmlhttprequest": "xmlhttprequest",
    "xhr": "xmlhttprequest", "subdocument": "sub_frame", "frame": "sub_frame",
    "ping": "ping", "beacon": "ping", "media": "media", "font": "font",
    "websocket": "websocket", "other": "other", "document": "main_frame", "doc": "main_frame",
}

# Cosmetic syntax that is not plain CSS: ABP/uBO procedural selectors. Skipped.
PROCEDURAL = re.compile(r":-abp-|:contains\(|:has-text\(|:xpath\(|:upward\(|:style\(|:remove\(|:matches-css|:min-text-length|:watch-attr|:others\(|:matches-path|:matches-attr|:matches-prop")


def fetch(lst, offline):
    path = CACHE / f"{lst['id']}.txt"
    if not offline:
        CACHE.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {lst['url']}")
        req = urllib.request.Request(lst["url"], headers={"User-Agent": "Bulle-Block list compiler"})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    if not path.exists():
        sys.exit(f"No cached copy of {lst['id']}; run once without --offline.")
    return path.read_text(encoding="utf-8", errors="replace")


def collapse_subdomains(domains):
    """requestDomains matches subdomains too, so a.b.com is dead weight when
    b.com is listed. Drop every domain that has a listed parent."""
    keep = []
    for d in domains:
        parts = d.split(".")
        if not any(".".join(parts[i:]) in domains for i in range(1, len(parts) - 1)):
            keep.append(d)
    return sorted(keep)


def domain_rules(domains, start_id, resource_types):
    domains = sorted(domains)
    rules = []
    for i in range(0, len(domains), DOMAINS_PER_RULE):
        rules.append({
            "id": start_id + len(rules),
            "priority": 1,
            "action": {"type": "block"},
            "condition": {"requestDomains": domains[i:i + DOMAINS_PER_RULE], "resourceTypes": resource_types},
        })
    return rules


def parse_hosts(text):
    out = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip().lower()
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ("0.0.0.0", "127.0.0.1", "::", "::1"):
            for host in parts[1:]:
                if host not in HOSTS_IGNORE and DOMAIN_RE.match(host):
                    out.add(host)
    return out


def parse_domain_list(text):
    out = set()
    for line in text.splitlines():
        m = SIMPLE_DOMAIN_RULE.match(line.strip().lower())
        if m and DOMAIN_RE.match(m.group(1)):
            out.add(m.group(1))
    return out


class AdblockCompiler:
    """EasyList syntax to DNR rules plus an element-hiding table."""

    def __init__(self):
        self.simple_block = set()          # ||domain^ with no options
        self.rules = []                    # DNR rules other than the bundled domains
        self.generic = []                  # ##selector
        self.specific = {}                 # domain -> [selector]
        self.exceptions = {}               # domain -> [selector]   (#@#)
        self.generichide = set()           # domains where generic hiding is off
        self.elemhide = set()              # domains where all hiding is off
        self.skipped = Counter()

    def add(self, line):
        line = line.strip()
        if not line or line.startswith("!") or line.startswith("["):
            return
        for sep in ("#@#", "##"):
            if sep in line:
                head, sel = line.split(sep, 1)
                self.cosmetic(head, sel, sep == "#@#")
                return
        if re.search(r"#[?$%@]+#", line):
            self.skipped["procedural or snippet"] += 1
            return
        self.network(line)

    def cosmetic(self, head, sel, exception):
        sel = sel.strip()
        if not sel or PROCEDURAL.search(sel):
            self.skipped["procedural selector"] += 1
            return
        domains = [d.strip().lower() for d in head.split(",") if d.strip()]
        if any(d.endswith(".*") or d.startswith("/") for d in domains):
            self.skipped["wildcard or regex domain"] += 1
            return
        pos = [d for d in domains if not d.startswith("~")]
        neg = [d[1:] for d in domains if d.startswith("~")]
        if exception:
            for d in pos:
                self.exceptions.setdefault(d, []).append(sel)
            if not pos:
                self.skipped["generic exception"] += 1
            return
        if not pos:
            # Generic, perhaps with sites it must not apply to.
            self.generic.append(sel)
            for d in neg:
                self.exceptions.setdefault(d, []).append(sel)
        else:
            for d in pos:
                self.specific.setdefault(d, []).append(sel)

    def network(self, line):
        allow = line.startswith("@@")
        if allow:
            line = line[2:]
        pattern, opts = line, []
        if "$" in line and not (line.startswith("/") and line.rstrip().endswith("/")):
            idx = line.rfind("$")
            pattern, opts = line[:idx], [o.strip() for o in line[idx + 1:].split(",") if o.strip()]
        if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
            self.skipped["regular expression"] += 1
            return

        cond, types, not_types = {}, [], []
        priority = 2 if allow else 1
        cosmetic_only = False
        for o in opts:
            neg = o.startswith("~")
            name, _, value = (o[1:] if neg else o).partition("=")
            name = name.lower()
            if name in ABP_TYPES:
                (not_types if neg else types).append(ABP_TYPES[name])
            elif name in ("third-party", "3p"):
                cond["domainType"] = "firstParty" if neg else "thirdParty"
            elif name in ("first-party", "1p"):
                cond["domainType"] = "thirdParty" if neg else "firstParty"
            elif name == "domain" and value:
                inc = [d.lower() for d in value.split("|") if d and not d.startswith("~")]
                exc = [d[1:].lower() for d in value.split("|") if d.startswith("~")]
                if any(d.endswith(".*") or "/" in d for d in inc + exc):
                    self.skipped["wildcard or regex domain"] += 1
                    return
                if inc:
                    cond["initiatorDomains"] = inc
                if exc:
                    cond["excludedInitiatorDomains"] = exc
            elif name == "match-case":
                cond["isUrlFilterCaseSensitive"] = True
            elif name == "important":
                priority = 3
            elif name == "all":
                types += ["main_frame"] + SUBRESOURCES
            elif name in ("elemhide", "ehide", "generichide", "ghide") and allow:
                cosmetic_only = True
                m = SIMPLE_DOMAIN_RULE.match(pattern.lower())
                if m:
                    (self.elemhide if name in ("elemhide", "ehide") else self.generichide).add(m.group(1))
            elif name == "popup":
                self.skipped["popup"] += 1
                return
            else:
                self.skipped[f"option {name}"] += 1
                return
        if cosmetic_only:
            return

        # The cheap and common case: a bare domain, bundled with its kin.
        if not allow and not opts:
            m = SIMPLE_DOMAIN_RULE.match(pattern.lower())
            if m and DOMAIN_RE.match(m.group(1)):
                self.simple_block.add(m.group(1))
                return

        if pattern in ("", "*", "|", "||"):
            pattern = ""
            if not cond.get("initiatorDomains") and not types:
                self.skipped["matches everything"] += 1
                return
        elif not pattern.isascii():
            self.skipped["non-ASCII pattern"] += 1
            return
        elif len(pattern.strip("*|^")) < 3:
            self.skipped["too short"] += 1
            return
        if pattern:
            cond["urlFilter"] = pattern

        if types:
            cond["resourceTypes"] = sorted(set(types))
        elif not_types:
            cond["excludedResourceTypes"] = sorted(set(not_types))

        action = "allow"
        if allow and "main_frame" in types:
            # @@...$document: the whole page is trusted, everything in it too.
            action = "allowAllRequests"
            cond["resourceTypes"] = ["main_frame", "sub_frame"]
            cond.pop("excludedResourceTypes", None)
        elif not allow:
            action = "block"
        self.rules.append({"priority": priority, "action": {"type": action}, "condition": cond})

    def output(self):
        domains = collapse_subdomains(self.simple_block)
        rules = domain_rules(domains, 1, SUBRESOURCES)
        for r in self.rules:
            r["id"] = len(rules) + 1
            rules.append(r)
        cosmetic = {
            "generic": sorted(set(self.generic)),
            "specific": {d: sorted(set(s)) for d, s in sorted(self.specific.items())},
            "exceptions": {d: sorted(set(s)) for d, s in sorted(self.exceptions.items())},
            "generichide": sorted(self.generichide),
            "elemhide": sorted(self.elemhide),
        }
        return rules, len(domains), cosmetic


def split_parts(rules):
    parts, cur, size = [], [], 0
    for r in rules:
        n = len(json.dumps(r, separators=(",", ":"))) + 1
        if cur and size + n > PART_BYTES:
            parts.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += n
    parts.append(cur)
    return parts


def write_json(path, data):
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=True), encoding="utf-8")
    return path.stat().st_size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="use tools/.cache instead of downloading")
    args = ap.parse_args()

    config = json.loads((ROOT / "tools" / "lists.json").read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.json"):
        old.unlink()

    index = []
    for lst in config["lists"]:
        print(f"{lst['name']}")
        text = fetch(lst, args.offline)
        entry = {k: lst[k] for k in ("id", "name", "about", "enabled")}
        entry["documents"] = bool(lst.get("documents"))
        if lst["format"] == "adblock":
            comp = AdblockCompiler()
            for line in text.splitlines():
                comp.add(line)
            rules, n_domains, cosmetic = comp.output()
            size = write_json(OUT / f"{lst['id']}.css.json", cosmetic)
            entry["hiding"] = len(cosmetic["generic"]) + sum(len(v) for v in cosmetic["specific"].values())
            print(f"  element hiding: {len(cosmetic['generic'])} generic, {len(cosmetic['specific'])} sites ({size / 1e6:.1f} MB)")
            if comp.skipped:
                top = ", ".join(f"{k} {v}" for k, v in comp.skipped.most_common(6))
                print(f"  skipped {sum(comp.skipped.values())}: {top}")
        else:
            domains = parse_hosts(text) if lst["format"] == "hosts" else parse_domain_list(text)
            raw = len(domains)
            domains = collapse_subdomains(domains)
            types = (["main_frame"] if entry["documents"] else []) + SUBRESOURCES
            rules = domain_rules(domains, 1, types)
            n_domains = len(domains)
            print(f"  {raw} domains, {n_domains} after dropping covered subdomains")
        if not rules:
            sys.exit(f"{lst['id']} compiled to no rules; is the URL still a block list?")
        parts = split_parts(rules)
        entry["rulesets"] = []
        entry["allow"] = {}
        for n, part in enumerate(parts, 1):
            rid = lst["id"] if len(parts) == 1 else f"{lst['id']}-{n}"
            for i, r in enumerate(part, 1):
                r["id"] = i
            size = write_json(OUT / f"{rid}.json", part)
            if size > PART_BYTES * 1.1:
                sys.exit(f"{rid}.json is {size / 1e6:.1f} MB; one rule is bigger than a part.")
            entry["rulesets"].append(rid)
            # The popup counts what was blocked on a page from getMatchedRules,
            # which reports rule ids but not actions; these are the ones to skip.
            allow = [r["id"] for r in part if r["action"]["type"] != "block"]
            if allow:
                entry["allow"][rid] = allow
        entry["rules"] = len(rules)
        entry["domains"] = n_domains
        print(f"  {len(rules)} rules in {len(parts)} file{'s' if len(parts) > 1 else ''}")
        index.append(entry)

    write_json(OUT / "index.json", index)

    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["declarative_net_request"] = {"rule_resources": [
        {"id": rid, "enabled": e["enabled"], "path": f"rules/{rid}.json"} for e in index for rid in e["rulesets"]
    ]}
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    n_sets = sum(len(e["rulesets"]) for e in index)
    if n_sets > 50:
        sys.exit(f"{n_sets} ruleset files; browsers enable at most 50 at once.")
    total = sum(e["rules"] for e in index)
    print(f"\n{len(index)} lists in {n_sets} ruleset files, {total} rules, {sum(e['domains'] for e in index)} bundled domains.")


if __name__ == "__main__":
    main()
