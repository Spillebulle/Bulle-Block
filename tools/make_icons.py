#!/usr/bin/env python3
"""Render icons/icon{16,32,48,128}.png: the plum app mark with Lucide's
shield-ban glyph in white, drawn by headless Chrome from one SVG so the four
sizes cannot drift apart. Needs Chrome (or set CHROME to another Chromium)."""
import os, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")
ACCENT = "#3977A8"  # light-theme accent, oklch(0.55 0.10 245): white clears 4.5:1 on it

def svg(size):
    # Lucide shield-ban (ISC), 24-unit box, centred at 62 % of the tile.
    stroke = 2.25 if size <= 16 else 2 if size <= 32 else 1.75
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 128 128">
<rect width="128" height="128" rx="28" fill="{ACCENT}"/>
<g transform="translate(24.3 24.3) scale(3.3)" fill="none" stroke="#FFFFFF" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round">
<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
<path d="m4.243 5.21 14.39 12.472"/>
</g></svg>'''

for size in (16, 32, 48, 128):
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "icon.html"
        page.write_text(f'<html><body style="margin:0;background:transparent">{svg(size)}</body></html>')
        out = ROOT / "icons" / f"icon{size}.png"
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--default-background-color=00000000", f"--window-size={size},{size}",
                        f"--screenshot={out}", page.as_uri()], check=True, capture_output=True)
        print(out)
