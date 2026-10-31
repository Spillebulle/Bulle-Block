#!/usr/bin/env python3
"""Package the extension for each browser.

    python tools/package.py            dist/chrome/, dist/firefox/ and a zip of each
    python tools/package.py --no-zip   folders only (load dist/firefox in about:debugging)

manifest.json in the repository is the Chromium one, so the folder loads
unpacked in Vivaldi or Chrome without warnings. Firefox needs two changes,
made here and nowhere else: it has no extension service worker, so the
background runs as `background.scripts`; and it needs
`browser_specific_settings` (add-on ID, minimum version, data collection),
a key Chromium warns about.

Run tools/build_rules.py first: rules/ must exist.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Everything the extension loads at run time. A new top-level runtime file
# must be added here.
RUNTIME = ["manifest.json", "background.js", "tokens.css", "content", "popup", "icons", "fonts", "rules"]

GECKO = {
    "gecko": {
        "id": "bulleblock@spillebulle",  # permanent once uploaded to AMO
        "strict_min_version": "140.0",   # data_collection_permissions needs 140
        "data_collection_permissions": {"required": ["none"]},
    }
}


def copy_runtime(dest):
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for name in RUNTIME:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, dest / name)
        else:
            shutil.copy2(src, dest / name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-zip", action="store_true", help="write the folders only")
    args = ap.parse_args()

    if not (ROOT / "rules" / "index.json").exists():
        sys.exit("rules/ is missing; run python tools/build_rules.py first.")

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]

    chrome = DIST / "chrome"
    copy_runtime(chrome)

    firefox = DIST / "firefox"
    copy_runtime(firefox)
    ff = dict(manifest)
    ff["background"] = {"scripts": [manifest["background"]["service_worker"]]}
    ff["browser_specific_settings"] = GECKO
    (firefox / "manifest.json").write_text(json.dumps(ff, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    for name, folder in (("chrome", chrome), ("firefox", firefox)):
        if args.no_zip:
            print(folder)
            continue
        zip_base = DIST / f"bulle-block-{version}-{name}"
        print(shutil.make_archive(str(zip_base), "zip", folder))


if __name__ == "__main__":
    main()
