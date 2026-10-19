#!/usr/bin/env python3
"""List One Piece Card Game events on TAK Games' Humanitix page, with on-sale times.

Run:  python3 -I discover.py
Shows every "One Piece" event, when its tickets go on sale (Melbourne time),
and whether its slug is already in humanitix-sniper.user.js. Use it to catch
the January Treasure Cup listing the moment TAK Games posts it.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HOST_URL = "https://events.humanitix.com/host/tak-games"
USERSCRIPT = Path(__file__).with_name("humanitix-sniper.user.js")
MEL = ZoneInfo("Australia/Melbourne")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def configured_slugs() -> set[str]:
    if not USERSCRIPT.exists():
        return set()
    src = USERSCRIPT.read_text(encoding="utf-8")
    # only uncommented slug lines
    return {m.group(1) for m in re.finditer(r'^\s*slug:\s*"([^"]+)"', src, re.M)}


def to_local(iso: str | None) -> str:
    if not iso:
        return "-"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone(MEL).strftime("%a %d %b %Y %I:%M %p %Z")
    except ValueError:
        return iso


def main() -> int:
    html = fetch(HOST_URL)
    events = []
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        for item in data.get("itemListElement", []) if isinstance(data, dict) else []:
            ev = item.get("item", {})
            if "one piece" in ev.get("name", "").lower():
                events.append(ev)
    if not events:
        print("No One Piece events found in the host page metadata. Page layout may have changed.")
        return 1

    known = configured_slugs()
    print(f"{len(events)} One Piece event(s) on {HOST_URL}\n")
    for ev in events:
        url = ev.get("url", "")
        slug = url.rstrip("/").split("/")[-1]
        flag = "in script" if slug in known else "NOT in script"
        print(f"[{flag}] {ev.get('name')}")
        print(f"    event:   {to_local(ev.get('startDate'))}")
        print(f"    tickets: {url}/tickets")
        for o in ev.get("offers", []):
            if o.get("@type") == "Offer":
                print(f"    ticket:  {o.get('name')}  ${o.get('price')}  on sale {to_local(o.get('availabilityStarts'))}  ({o.get('availability', '').split('/')[-1]})")
        print()
    new = [e for e in events if e.get("url", "").rstrip("/").split("/")[-1] not in known]
    if new:
        print("Add any of the NOT-in-script events to EVENTS in humanitix-sniper.user.js if you want them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
