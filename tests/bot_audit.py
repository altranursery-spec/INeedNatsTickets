#!/usr/bin/env python3
"""Bot-conduct audit for humanitix-sniper.user.js.

Proves the script behaves like a careful, human-driven page helper: rate-limited, no browser
spoofing, no contact with CAPTCHA frames, one ticket, never pays, clicks only what it should.
It cannot predict Cloudflare's decision (that also depends on your browser, IP and history); it
proves the script gives Cloudflare nothing to object to.

Black-box: the script is read from disk as-is and injected into local stand-in pages. Only the
config keys (EVENTS, SALE_TIME, BUYER) are patched, by key name, so edits elsewhere don't break
the audit. Nothing here touches the internet.

Run:   .venv/bin/python -I tests/bot_audit.py            (all checks)
       .venv/bin/python -I tests/bot_audit.py S D2 D5    (static checks + chosen dynamic ones)
Env:   SCRIPT=path/to/other.user.js   to audit a different copy
"""
import asyncio
import datetime as dt
import json
import os
import re
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from stub import Plan, Stub  # noqa: E402

SCRIPT = Path(os.environ.get("SCRIPT") or HERE.parent / "humanitix-sniper.user.js")
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
MEL = ZoneInfo("Australia/Melbourne")
FINALS_SLUG = "one-piece-card-game-championship-2026-melbourne-finals-oceania"
DIGI_SLUG = "digimon-card-game-championship-2026-online-november-regional-oceania"

RESULTS = []          # (id, status, message)
REQUEST_HOSTS = set() # every http(s) host:port the browser contacted during dynamic checks


def record(cid, status, msg):
    RESULTS.append((cid, status, msg))
    print(f"[{status}] {cid}: {msg}")


# ─────────────────────────── Static checks ───────────────────────────

def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    src = re.sub(r"^\s*//.*$", "", src, flags=re.M)        # whole-line comments
    src = re.sub(r"(?<=\S)\s{2,}//.*$", "", src, flags=re.M)  # trailing comments after two spaces
    return src


def header(src: str) -> str:
    m = re.search(r"// ==UserScript==(.*?)// ==/UserScript==", src, re.S)
    return m.group(1) if m else ""


def static_checks(src: str):
    code = strip_comments(src)
    hdr = header(src)

    # S1 scope
    matches = re.findall(r"@match\s+(\S+)", hdr) + re.findall(r"@include\s+(\S+)", hdr)
    bad = [m for m in matches if not re.fullmatch(r"https://events\.humanitix\.com/\*?", m)]
    problems = []
    if not matches: problems.append("no @match")
    if bad: problems.append("@match/@include outside events.humanitix.com: " + ", ".join(bad))
    if "@noframes" not in hdr: problems.append("@noframes missing")
    if re.search(r"@connect", hdr): problems.append("@connect present")
    if re.search(r"GM_xmlhttpRequest|GM\.xmlHttpRequest", code): problems.append("GM_xmlhttpRequest used")
    record("S1 scope", "FAIL" if problems else "PASS", "; ".join(problems) or f"runs only on {matches[0]}, top frame only, no cross-site requests")

    # S2 fingerprint tampering
    pats = [r"Object\.defineProperty\(\s*navigator", r"navigator\.__proto__", r"\bwebdriver\b", r"navigator\.userAgent\s*=",
            r"defineProperty\([^)]*\b(plugins|languages|hardwareConcurrency|deviceMemory|platform|vendor)\b",
            r"WebGLRenderingContext\.prototype", r"HTMLCanvasElement\.prototype\.toDataURL\s*=", r"chrome\.runtime\s*=",
            r"Notification\.permission\s*=", r"screen\.(width|height)\s*="]
    hits = [p for p in pats if re.search(p, code)]
    record("S2 no fingerprint tampering", "FAIL" if hits else "PASS", ("found: " + ", ".join(hits)) if hits else "no navigator/WebGL/canvas/screen overrides")

    # S3 CAPTCHA contact
    pats = [r"challenges\.cloudflare\.com", r"cf-turnstile", r"turnstile\.(render|execute|reset|getResponse)", r"2captcha|anti-?captcha|capsolver|capmonster|nopecha",
            r"g-recaptcha-response", r"\bgrecaptcha\b", r"\bh-?captcha\b"]
    hits = [p for p in pats if re.search(p, code, re.I)]
    record("S3 no CAPTCHA interaction", "FAIL" if hits else "PASS", ("found: " + ", ".join(hits)) if hits else "no Turnstile/reCAPTCHA/hCaptcha APIs or solver services")

    # S4 frames
    pats = [r"\.contentWindow\b", r"\.contentDocument\b", r"\bframes\[", r"window\.parent\.", r"\btop\.document\b",
            r"\b(window|parent|top|contentWindow|frames\[[^\]]*\])\.postMessage\("]
    hits = [p for p in pats if re.search(p, code)]
    record("S4 no frame reach-in", "FAIL" if hits else "PASS", ("found: " + ", ".join(hits)) if hits else "never reaches into iframes (Turnstile, Braintree card fields)")

    # S5 remote code
    pats = [r"\beval\(", r"new Function\(", r"createElement\(\s*[\"']script", r"import\(\s*[\"']https?", r"\.src\s*=\s*[\"']https?"]
    hits = [p for p in pats if re.search(p, code)]
    record("S5 no remote code", "FAIL" if hits else "PASS", ("found: " + ", ".join(hits)) if hits else "no eval/Function/script injection")

    # S6 external hosts
    hosts = set(re.findall(r"https?://([A-Za-z0-9.\-]+)", code))
    bad = sorted(h for h in hosts if not h.endswith("humanitix.com"))
    fetch_bad = re.findall(r"fetch\(\s*[\"'](https?://[^\"']+)", code)
    fetch_bad = [u for u in fetch_bad if "humanitix.com" not in u]
    record("S6 no external hosts", "FAIL" if (bad or fetch_bad) else "PASS",
           ("hosts: " + ", ".join(bad + fetch_bad)) if (bad or fetch_bad) else f"only humanitix.com referenced ({', '.join(sorted(hosts)) or 'relative URLs only'})")

    # S7 rate constants (tolerant of renames)
    def const(name):
        m = re.search(r"const\s+" + name + r"\s*=\s*([0-9.]+)", code)
        return float(m.group(1)) if m else None
    poll, gap, keep = const("POLL_INTERVAL_MS"), const("MIN_RELOAD_GAP_MS"), const("KEEPALIVE_SECONDS")
    missing = [n for n, v in (("POLL_INTERVAL_MS", poll), ("MIN_RELOAD_GAP_MS", gap), ("KEEPALIVE_SECONDS", keep)) if v is None]
    probs = []
    if poll is not None and poll < 1000: probs.append(f"POLL_INTERVAL_MS={poll:g} (<1000)")
    if gap is not None and gap < 1000: probs.append(f"MIN_RELOAD_GAP_MS={gap:g} (<1000)")
    if keep is not None and keep != 0 and keep < 10: probs.append(f"KEEPALIVE_SECONDS={keep:g} (<10)")
    if probs: record("S7 rate constants", "FAIL", "; ".join(probs))
    elif missing: record("S7 rate constants", "WARN", "constant(s) not found by name: " + ", ".join(missing) + " (dynamic checks D1-D3 still measure the real cadence)")
    else: record("S7 rate constants", "PASS", f"poll {poll:g} ms, reload gap {gap:g} ms, keepalive {keep:g} s")

    # S8 payment guard
    guard = re.search(r"/[^/\n]*\bpay\b[^/\n]*\border\b[^/\n]*/i|/[^/\n]*\border\b[^/\n]*\bpay\b[^/\n]*/i", code)
    submit_click = re.search(r"braintree-card-submit[^\n]*\.click\(\)|querySelector\([^)]*braintree-card-submit[^)]*\)\s*\.click", code)
    if submit_click: record("S8 payment guard", "FAIL", "code clicks the Pay Order button")
    elif guard: record("S8 payment guard", "PASS", "button-click guard rejects pay/order wording; Pay Order never clicked (D5 proves it live)")
    else: record("S8 payment guard", "WARN", "could not find the pay/order guard pattern by shape (D5 still proves Pay Order is never clicked)")


# ─────────────────────────── Dynamic harness ───────────────────────────

class _S(str):
    def pipe(self, key, val):
        return _S(re.sub(r'(\b%s: )"[^"]*"' % re.escape(key), lambda m: m.group(1) + '"' + val + '"', self, count=1))


def patch_script(src: str, slug: str, sale_iso: str):
    warns = []
    s = _S(src)
    if re.search(r"const\s+EVENTS\s*=\s*\[", s):
        s = _S(re.sub(r"(const\s+EVENTS\s*=\s*\[)", r'\1\n  { name: "AUDIT", slug: "%s", match: "" },' % slug, s, count=1))
    else:
        warns.append("EVENTS array not found; dynamic checks cannot target the stub event")
    if re.search(r'const\s+SALE_TIME\s*=\s*"[^"]*"', s):
        s = _S(re.sub(r'(const\s+SALE_TIME\s*=\s*)"[^"]*"', r'\1"%s"' % sale_iso, s, count=1))
    else:
        warns.append("SALE_TIME not found (page sale time is used anyway)")
    vals = {"firstName": "Audit", "lastName": "Person", "email": "audit@example.com", "mobile": "0400000000", "bandaiNumber": "1234567890",
            "discordId": "audit_user", "streetAddress": "1 Test St", "suburb": "Testville", "postcode": "3000", "country": "Australia"}
    if "BUYER" in s:
        for k, v in vals.items():
            s = s.pipe(k, v)
    else:
        warns.append("BUYER block not found; checkout prefill not exercised")
    return str(s), warns


def shim(script_src: str) -> str:
    return """
if (window.top === window) {
  const S = k => 'gm:' + k;
  window.GM_getValue = (k, d) => { const v = localStorage.getItem(S(k)); return v === null ? d : JSON.parse(v); };
  window.GM_setValue = (k, v) => localStorage.setItem(S(k), JSON.stringify(v));
  window.GM_deleteValue = k => localStorage.removeItem(S(k));
  window.GM_notification = o => console.log('[GM_notification]', o && o.text);
  window.alert = t => console.log('[alert] ' + String(t).slice(0, 120));
  const run = () => { try { (function(){ %s })(); } catch (e) { console.error('userscript error', e); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
}
""" % script_src


def humanitix_str(epoch: float) -> str:
    d = dt.datetime.fromtimestamp(epoch, MEL)
    day = d.day
    suf = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{d:%a} {day}{suf} {d:%b %Y}, {d.strftime('%I').lstrip('0')}:{d:%M} {d:%p}".replace(" AM", " am").replace(" PM", " pm") + f" {d:%Z}"


FAR = "2027-06-01T12:00:00+10:00"


async def browse(cid, stub, paths, slug, sale_iso, seconds, tabs=1, until=None):
    """Open the paths in a fresh profile with the script injected; wait `seconds` or until `until(pages)` is true."""
    from playwright.async_api import async_playwright
    src, warns = patch_script(SCRIPT.read_text(encoding="utf-8"), slug, sale_iso)
    for w in warns: record(cid + " (patch)", "WARN", w)
    profile = OUT / f"profile-{cid.split()[0]}"
    os.system(f"rm -rf '{profile}'")
    logs, pages = [], []
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(str(profile), headless=True, viewport={"width": 1280, "height": 900})
        await ctx.add_init_script(shim(src))
        # Only request kinds a script can initiate count for D9; images/fonts in the saved pages are the page's own markup.
        ctx.on("request", lambda r: REQUEST_HOSTS.add(re.sub(r"^https?://([^/]+).*$", r"\1", r.url))
               if r.url.startswith("http") and r.resource_type in ("fetch", "xhr", "websocket", "eventsource", "document", "script") else None)
        for i, path in enumerate(paths):
            pg = ctx.pages[0] if (i == 0 and ctx.pages) else await ctx.new_page()
            pg.on("console", (lambda idx: lambda m: logs.append(f"tab{idx} [{m.type}] {m.text}"))(i))
            pages.append(pg)
            await pg.goto(stub.origin + path, wait_until="domcontentloaded")
        t0 = time.time()
        while time.time() - t0 < seconds:
            await asyncio.sleep(0.25)
            if until and until(pages):
                break
        info = {"urls": [pg.url for pg in pages], "logs": logs, "elapsed": time.time() - t0}
        try:
            info["panels"] = [await pg.evaluate("(document.querySelector('#humanitix-sniper-panel')||{}).innerText || ''") for pg in pages]
        except Exception:
            info["panels"] = [""] * len(pages)
        try:
            info["paid"] = await pages[0].evaluate("window.__paid || 0")
        except Exception:
            info["paid"] = None
        fr = next((f for f in pages[0].frames if "/challenge" in f.url), None)
        if fr:
            try:
                info["challenge_input"] = await fr.evaluate("document.getElementById('cf-input').value")
            except Exception:
                info["challenge_input"] = "(unreadable)"
        await ctx.close()
    return info


def gaps(ts):
    return [b - a for a, b in zip(ts, ts[1:])]


async def dynamic_checks(wanted):
    port = 8900

    def want(cid):
        return not wanted or cid.split()[0] in wanted or "D" in wanted

    # D1 idle cadence
    if want("D1"):
        port += 2
        now = time.time()
        stub = Stub(port, port + 1, Plan(before="finals", sale_str=humanitix_str(now + 3600)))
        try:
            info = await browse("D1 idle cadence", stub, [f"/{FINALS_SLUG}/tickets"], FINALS_SLUG, FAR, 70)
        finally:
            stub.stop()
        f, d = stub.site_rec.fetches(), stub.site_rec.documents()
        ok = len(f) <= 2 and len(d) == 1 and not stub.site_rec.clicks
        record("D1 idle cadence", "PASS" if ok else "FAIL",
               f"{len(f)} background request(s) and {len(d) - 1} reload(s) in 70 s while waiting; {len(stub.site_rec.clicks)} click(s)")

    # D2 poll cadence
    if want("D2"):
        port += 2
        now = time.time()
        sale = now + 5
        stub = Stub(port, port + 1, Plan(before="finals", sale_str=humanitix_str(sale)))
        try:
            info = await browse("D2 poll cadence", stub, [f"/{FINALS_SLUG}/tickets"], FINALS_SLUG, FAR, 25)
        finally:
            stub.stop()
        polls = [r["t"] for r in stub.site_rec.fetches() if r["t"] >= sale - 3.5]
        g = gaps(polls)
        d = stub.site_rec.documents()
        ok = len(polls) >= 10 and (not g or min(g) >= 0.9) and len(d) == 1
        record("D2 poll cadence", "PASS" if ok else "FAIL",
               f"{len(polls)} polls in ~20 s, shortest gap {min(g):.2f} s" if g else f"only {len(polls)} polls seen" + (f"; {len(d) - 1} reload(s) of a healthy page" if len(d) != 1 else ""))

    # D3 reload cadence + recovery
    if want("D3"):
        port += 2
        now = time.time()
        stub = Stub(port, port + 1, Plan(before="finals", after="digimon", flip_at=now + 6, doc_error_from=now + 5, doc_error_to=now + 11,
                                         sale_str=humanitix_str(now + 4)))
        try:
            info = await browse("D3 reload cadence", stub, [f"/{FINALS_SLUG}/tickets"], FINALS_SLUG, FAR, 45,
                                until=lambda pgs: "/details" in pgs[0].url)
        finally:
            stub.stop()
        docs = [r for r in stub.site_rec.documents() if "/tickets" in r["path"]]
        errs = [r for r in docs if r["status"] == 502]
        g = gaps([r["t"] for r in docs])
        reached = "/details" in info["urls"][0]
        ok = reached and len(errs) >= 2 and (not g or min(g) >= 0.9)
        # informational: detection → reload
        fl = [r["t"] for r in stub.site_rec.fetches() if r["t"] >= now + 6]
        first_reload_after = next((r["t"] for r in docs if r["t"] >= (fl[0] if fl else 1e18)), None)
        lat = f", on-sale poll → reload {1000 * (first_reload_after - fl[0]):.0f} ms" if fl and first_reload_after else ""
        record("D3 reload cadence", "PASS" if ok else "FAIL",
               f"{len(errs)} error page(s) hit, {len(docs)} page loads, shortest gap {min(g):.2f} s, checkout {'reached' if reached else 'NOT reached'}{lat}" if g else "no reloads observed")

    # D4 quantity cap
    if want("D4"):
        port += 2
        stub = Stub(port, port + 1, Plan(before="digimon", qty_max=5))
        try:
            info = await browse("D4 quantity cap", stub, [f"/{DIGI_SLUG}/tickets"], DIGI_SLUG, FAR, 20, until=lambda pgs: "/details" in pgs[0].url)
        finally:
            stub.stop()
        inc = [c for c in stub.site_rec.clicks if str(c.get("testid", "")).startswith("increment-")]
        chk = [c for c in stub.site_rec.clicks if c.get("testid") == "checkout-btn"]
        qty = re.search(r"qty=(\d+)", info["urls"][0])
        ok = len(inc) == 1 and len(chk) == 1 and qty and qty.group(1) == "1"
        record("D4 quantity cap", "PASS" if ok else "FAIL",
               f"picker allowed up to 5; {len(inc)} '+' click(s), {len(chk)} Continue click(s), order quantity {qty.group(1) if qty else '?'}")

    # D5 + D6 click allow-list and cross-origin isolation
    if want("D5") or want("D6"):
        port += 2
        stub = Stub(port, port + 1, Plan(before="digimon"))
        try:
            info = await browse("D5 click allow-list", stub, [f"/{DIGI_SLUG}/tickets"], DIGI_SLUG, FAR, 40,
                                until=lambda pgs: "/details" in pgs[0].url and getattr(pgs[0], "_seen", None) is None and setattr(pgs[0], "_seen", time.time()) or
                                                  (getattr(pgs[0], "_seen", None) is not None and time.time() - pgs[0]._seen > 8))
        finally:
            stub.stop()

        def allowed(c):
            tid, text, tag, role, typ = str(c.get("testid", "")), str(c.get("text", "")), c.get("tag", ""), c.get("role", ""), c.get("type", "")
            if c.get("panel"): return True
            if tid.startswith("increment-") or tid == "checkout-btn" or tid == "payment-option-credit-card": return True
            if re.fullmatch(r"Continue to (Ticket info|Payment)", text): return True
            if tag == "input" and typ in ("checkbox", "radio"): return True
            if role in ("combobox", "option") or tid in ("field-content", "dropdown-option"): return True
            return False
        bad = [c for c in stub.site_rec.clicks if not allowed(c)]
        ticket_t = next((r["t"] for r in stub.site_rec.documents() if "/tickets" in r["path"]), None)
        chk_t = next((c.get("t") for c in stub.site_rec.clicks if c.get("testid") == "checkout-btn"), None)
        speed = f"; page load → Continue click {chk_t / 1000 - ticket_t:.2f} s" if ticket_t and chk_t else ""
        desc = ", ".join(sorted({(c.get("testid") or c.get("text") or c.get("tag")) for c in stub.site_rec.clicks if not c.get("panel")}))
        if want("D5"):
            record("D5 click allow-list", "PASS" if not bad and info.get("paid") in (0, None) else "FAIL",
                   (f"clicked only: {desc}" if not bad else "forbidden click(s): " + ", ".join(json.dumps(b) for b in bad[:5])) + (f"; Pay Order clicked {info['paid']}x" if info.get("paid") else "") + speed)
        if want("D6"):
            ch_docs = [r for r in stub.ch_rec.requests if r["kind"] == "document"]
            ch_other = [r for r in stub.ch_rec.requests if r["kind"] not in ("document", "other")]
            errs = [l for l in info["logs"] if "userscript error" in l]
            ok = len(ch_docs) >= 1 and not ch_other and not stub.ch_rec.clicks and info.get("challenge_input", "") == "" and not errs
            record("D6 cross-origin isolation", "PASS" if ok else "FAIL",
                   f"challenge frame loaded {len(ch_docs)}x, {len(ch_other)} other request(s) to it, {len(stub.ch_rec.clicks)} click(s) inside it, "
                   f"its input {'untouched' if info.get('challenge_input', '') == '' else 'MODIFIED'}, {len(errs)} script error(s)")

    # D7 unconfigured page
    if want("D7"):
        port += 2
        stub = Stub(port, port + 1, Plan(before="finals"))
        try:
            info = await browse("D7 unconfigured page", stub, ["/some-other-event/tickets"], DIGI_SLUG, FAR, 8)
        finally:
            stub.stop()
        ok = not stub.site_rec.fetches() and not stub.site_rec.clicks and not info["panels"][0]
        record("D7 unconfigured page", "PASS" if ok else "FAIL",
               f"{len(stub.site_rec.fetches())} background request(s), {len(stub.site_rec.clicks)} click(s), panel {'absent' if not info['panels'][0] else 'PRESENT'}")

    # D8 one tab one order
    if want("D8"):
        port += 2
        stub = Stub(port, port + 1, Plan(before="digimon"))
        try:
            info = await browse("D8 one tab one order", stub, [f"/{DIGI_SLUG}/tickets"] * 2, DIGI_SLUG, FAR, 12)
        finally:
            stub.stop()
        n = sum("/details" in u for u in info["urls"])
        record("D8 one tab one order", "PASS" if n == 1 else "FAIL", f"{n} of 2 tabs reached checkout")

    # D9 off-origin traffic
    if want("D9"):
        bad = sorted(h for h in REQUEST_HOSTS if not h.startswith("127.0.0.1:"))
        record("D9 no off-origin traffic", "PASS" if not bad else "FAIL",
               "browser contacted only the local stand-in origins" if not bad else "contacted: " + ", ".join(bad))


def main():
    wanted = set(sys.argv[1:])
    print(f"Auditing {SCRIPT}  ({SCRIPT.stat().st_size} bytes)\n")
    src = SCRIPT.read_text(encoding="utf-8")
    ver = re.search(r"@version\s+(\S+)", src)
    print("Script version:", ver.group(1) if ver else "(unknown)")
    print("\n-- Static checks (what the code could do) --")
    if not wanted or "S" in wanted or any(w.startswith("S") for w in wanted):
        static_checks(src)
    dyn = {w for w in wanted if w.startswith("D")}
    if not wanted or dyn:
        print("\n-- Dynamic checks (what the code actually does, on a local stand-in site) --")
        asyncio.run(dynamic_checks(dyn))
    fails = [r for r in RESULTS if r[1] == "FAIL"]
    warns = [r for r in RESULTS if r[1] == "WARN"]
    print("\n" + ("ALL CHECKS PASSED" if not fails else f"{len(fails)} CHECK(S) FAILED") + (f", {len(warns)} warning(s)" if warns else ""))
    print("What this means: a pass shows the script is rate-limited, spoofs nothing, never touches CAPTCHA or card frames,\n"
          "buys one ticket, clicks only the ticket, step and card-option controls, and never pays. It does not predict\n"
          "Cloudflare's own decision, which also depends on your browser, network and account history.")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
