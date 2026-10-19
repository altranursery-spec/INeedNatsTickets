#!/usr/bin/env python3
"""Saturday-night check: is Humanitix's page still shaped the way the userscript expects?

Run:  python3 -I selfcheck.py
Fetches each event in humanitix-sniper.user.js plus one TAK Games event that is on sale
right now, and checks every selector/marker the script depends on. Exit code 0 = all good.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

USERSCRIPT = Path(__file__).with_name("humanitix-sniper.user.js")
HOST_URL = "https://events.humanitix.com/host/tak-games"
MEL = ZoneInfo("Australia/Melbourne")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

# What the userscript relies on (keep in sync with SEL / markers in the script).
COMMON = {
    "ticket card":          r'class="TicketCard',
    "ticket name heading":  r'<h3 class="name',
    "ticket form":          r'id="ticket-form"',
    "checkout button":      r'data-testid="checkout-btn"',
    "embedded sale status": r'ticketSaleStatus:"',
    "max per order":        r'maxTicketsPerOrder:\d+',
}
NOT_ON_SALE = {
    "sale-state block":     r'class="sale-state',
    "Sales start at text":  r'Sales start at ',
    "saleDateStr":          r'saleDateStr:"[^"]+"',
}
ON_SALE = {
    "quantity input":       r'data-testid="value-[a-f0-9]{24}"',
    "increment control":    r'data-testid="increment-[a-f0-9]{24}"',
    "picker value":         r'data-testid="picker-value"',
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def script_events() -> list[tuple[str, str]]:
    src = USERSCRIPT.read_text(encoding="utf-8")
    block = src[src.index("const EVENTS = ["): src.index("];", src.index("const EVENTS = ["))]
    out = []
    for m in re.finditer(r'^\s*\{\s*name:\s*"([^"]*)",\s*slug:\s*"([^"]+)"', block, re.M):
        out.append((m.group(1), m.group(2)))
    return out


def on_sale_example() -> str | None:
    html = fetch(HOST_URL)
    now = datetime.now(timezone.utc)
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        for item in data.get("itemListElement", []) if isinstance(data, dict) else []:
            ev = item.get("item", {})
            for o in ev.get("offers", []):
                if o.get("@type") != "Offer" or o.get("availability", "").split("/")[-1] != "InStock":
                    continue
                starts = o.get("availabilityStarts")
                if starts and datetime.fromisoformat(starts.replace("Z", "+00:00")) < now:
                    return ev["url"].rstrip("/") + "/tickets"
    return None


def check(html: str, rules: dict[str, str], label: str) -> int:
    bad = 0
    for name, pat in rules.items():
        ok = re.search(pat, html) is not None
        print(f"   [{'ok' if ok else 'MISSING'}] {name}")
        bad += 0 if ok else 1
    return bad


def main() -> int:
    problems = 0
    events = script_events()
    if not events:
        print("No events found in humanitix-sniper.user.js"); return 2
    for name, slug in events:
        url = f"https://events.humanitix.com/{slug}/tickets"
        print(f"\n== {name}\n   {url}")
        try:
            html = fetch(url)
        except Exception as e:
            print(f"   [MISSING] page fetch failed: {e}"); problems += 1; continue
        if "TicketCard" not in html and re.search(r"waiting room|cf-waiting-room", html, re.I):
            print("   [note] Cloudflare waiting room is active right now; cannot check this page."); continue
        problems += check(html, COMMON, name)
        on_sale = re.search(ON_SALE["increment control"], html) is not None
        if on_sale:
            print("   state: ON SALE now")
            problems += check(html, ON_SALE, name)
        else:
            print("   state: not on sale yet")
            problems += check(html, NOT_ON_SALE, name)
            m = re.search(r'saleDateStr:"([^"]+)"', html)
            if m:
                print(f"   page sale time: {m.group(1)}")
        m = re.search(r"maxTicketsPerOrder:(\d+)", html)
        if m:
            print(f"   max tickets per order: {m.group(1)}")

    print("\n== On-sale page check (proves the quantity picker markup is unchanged)")
    ex = on_sale_example()
    if not ex:
        print("   [MISSING] could not find any TAK Games event currently on sale"); problems += 1
    else:
        print(f"   {ex}")
        try:
            html = fetch(ex)
            problems += check(html, COMMON, ex)
            problems += check(html, ON_SALE, ex)
        except Exception as e:
            print(f"   [MISSING] fetch failed: {e}"); problems += 1

    print("\nRESULT:", "ALL GOOD" if problems == 0 else f"{problems} PROBLEM(S). Selectors live under SEL in humanitix-sniper.user.js.")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
