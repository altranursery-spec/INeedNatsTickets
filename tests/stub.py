"""Local stand-in for Humanitix used by bot_audit.py.

Serves saved copies of real Humanitix pages (tests/fixtures) plus a checkout page that copies
Humanitix's markup, and records every request and every click so the audit can measure what the
userscript does. Nothing here talks to the internet.

Two servers:
  Site       127.0.0.1:<port>   the "Humanitix" origin
  Challenge  127.0.0.1:<port2>  a second origin embedded in checkout as an iframe (stands in for
                                 Turnstile / Braintree frames the script must never touch)
"""
import http.server
import json
import re
import threading
import time
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"

# Injected into every served page: a stand-in for Humanitix's own JavaScript (which cannot run
# offline) plus a click recorder. This is "the site", not the script under test.
SITE_JS = r"""
<style>dialog.Drawer{display:block;position:static}[data-testid="checkout-btn"],[data-testid^="increment-"]{display:inline-block;min-width:120px;min-height:40px}</style>
<script>
(function () {
  function describe(el) {
    if (!el || !el.tagName) return {tag: "?"};
    return {tag: el.tagName.toLowerCase(), testid: el.getAttribute("data-testid") || "", role: el.getAttribute("role") || "",
            type: el.getAttribute("type") || "", id: el.id || "", cls: (typeof el.className === "string" ? el.className : "").slice(0, 60),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60), panel: !!el.closest("#humanitix-sniper-panel")};
  }
  document.addEventListener("click", function (e) {
    var el = e.target.closest("button, summary, label, input, select, textarea, a, [role], [data-testid]") || e.target;
    var d = describe(el); d.t = Date.now();
    try { navigator.sendBeacon("/__click", JSON.stringify(d)); } catch (err) {}
  }, true);

  function hydrate() {
    // Quantity picker: "+" and "−" change the input (respecting max) and enable the checkout button.
    document.querySelectorAll('[data-testid^="increment-"], [data-testid^="decrement-"]').forEach(function (b) {
      b.addEventListener("click", function () {
        var box = b.parentElement, inp = box.querySelector("input"), pv = box.querySelector('[data-testid="picker-value"]');
        var max = Number(inp.getAttribute("max") || 1), v = Number(inp.value || 0);
        v = b.getAttribute("data-testid").indexOf("increment") === 0 ? Math.min(max, v + 1) : Math.max(0, v - 1);
        var apply = function () {
          inp.value = String(v); if (pv) pv.textContent = String(v);
          document.querySelectorAll('[data-testid="checkout-btn"]').forEach(function (c) { c.setAttribute("aria-disabled", v > 0 ? "false" : "true"); });
        };
        if (window.__slowIncrementMs) setTimeout(apply, window.__slowIncrementMs); else apply();
      });
    });
    document.querySelectorAll('[data-testid="checkout-btn"]').forEach(function (c) {
      c.addEventListener("click", function (e) {
        e.preventDefault();
        var qty = 0; document.querySelectorAll('input[data-testid^="value-"]').forEach(function (i) { qty += Number(i.value || 0); });
        if (qty < 1 && !window.__continueIgnoresQty) return;
        if (qty < 1) qty = 1;
        var base = location.pathname.replace(/\/tickets\/?$/, "");
        setTimeout(function () { location.href = base + "/au/test0000000000000000001/details?qty=" + qty; }, 60);
      });
    });
    // Checkout steps
    var b1 = document.getElementById("b1"), b2 = document.getElementById("b2");
    if (b1) b1.addEventListener("click", function () { b1.hidden = true; document.getElementById("s2").hidden = false; });
    if (b2) b2.addEventListener("click", function () { b2.hidden = true; document.getElementById("s3").hidden = false; });
    // Custom dropdowns
    document.querySelectorAll('[role="combobox"]').forEach(function (box) {
      var list = document.getElementById(box.getAttribute("aria-controls"));
      if (!list) return;
      box.addEventListener("click", function (e) {
        if (e.target.closest('[role="option"]')) return;
        var open = list.getAttribute("data-open") === "true";
        list.setAttribute("data-open", open ? "false" : "true"); list.style.display = open ? "none" : "block";
      });
      list.querySelectorAll('[role="option"]').forEach(function (o) {
        o.addEventListener("click", function () {
          box.querySelector('[data-testid="field-content"]').textContent = o.textContent;
          box.setAttribute("data-none-selected", o.textContent === "Select an option" ? "true" : "false");
          list.setAttribute("data-open", "false"); list.style.display = "none";
        });
      });
    });
    var pay = document.getElementById("pay");
    if (pay) pay.addEventListener("click", function () { window.__paid = (window.__paid || 0) + 1; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hydrate); else hydrate();
})();
</script>
"""


def _text(idx, label, name, required=True, typ="text"):
    req = '<span aria-hidden="true" data-text="low">(required)</span>' if required else ""
    return (f'<div class="InputText" data-testid="{label}"><label class="InputLabel" for="Input.Text.s{idx}"><span>{label}</span> {req}</label>'
            f'<div class="field"><div class="border-container"><input type="{typ}" data-testid="{label}-input" id="Input.Text.s{idx}" name="{name}" '
            f'placeholder="{label}" value="" {"aria-required=\"true\"" if required else ""}/></div></div></div>')


def _select(idx, label, options):
    opts = "".join(f'<div aria-selected="false" data-testid="dropdown-option" class="option" role="option" tabindex="0">{o}</div>'
                   for o in ["Select an option"] + options)
    return (f'<div class="Select"><label class="InputLabel" for="Input.Select.s{idx}" id="Input.Select.s{idx}-label"><span>{label}</span> '
            f'<span aria-hidden="true" data-text="low">(required)</span></label>'
            f'<div class="field" id="Input.Select.s{idx}" role="combobox" data-none-selected="true" aria-controls="Input.Select.s{idx}-controls" '
            f'aria-expanded="false" aria-labelledby="Input.Select.s{idx}-label" aria-required="true" tabindex="0">'
            f'<div class="field-content" data-testid="field-content">Select an option</div>'
            f'<div class="options" id="Input.Select.s{idx}-controls" data-testid="dropdown-options" role="listbox" data-open="false" style="display:none">{opts}</div></div></div>')


def _checkbox(idx, label, checked=False):
    return (f'<div class="Checkbox"><label for="Input.Checkbox.s{idx}"><input type="checkbox" id="Input.Checkbox.s{idx}" class="u-visually-hidden" {"checked" if checked else ""}/>'
            f'<div class="InputLabel"><span>{label}</span></div></label></div>')


def checkout_page(challenge_origin: str) -> str:
    """Checkout page mirroring Humanitix's live markup (buyer info, ticket info, payment accordion)."""
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>Checkout</title>
<style>.step[hidden]{{display:none}}</style></head><body>
<h2>Checkout</h2><div id="timer">19m 54s</div>
<section class="step" id="s1"><legend>Buyer information</legend>
{_text(1, "First Name", "firstName")}{_text(2, "Last Name", "lastName")}{_text(3, "Email", "email", typ="email")}
{_text(4, "Confirm Email", "emailConfirmation", typ="email")}{_text(5, "Mobile", "mobile", typ="tel")}
{_checkbox(6, "Humanitix can send me emails about upcoming events and news", True)}
{_checkbox(7, "Keep me updated on the latest news, events, and exclusive offers from TAK Games")}
{_checkbox(8, "Email tickets to attendees")}
<button type="button" data-testid="edit-form">Edit</button>
<button type="button" id="b1">Continue to Ticket info</button></section>
<section class="step" id="s2" hidden><h3>Ticket info</h3><h4>Ticket 1 - Competitor Entry</h4><a href="#copy" id="copy-from-order">Copy from order</a>
{_text(10, "First Name", "aFirst")}{_text(11, "Last Name", "aLast")}{_text(12, "Mobile", "aMobile", typ="tel")}{_text(13, "Email", "aEmail", typ="email")}
<div>Address</div>{_select(14, "Country", ["Afghanistan", "Australia", "New Zealand", "United States"])}
{_text(15, "Street address", "street")}{_text(16, "Suburb", "suburb")}{_text(17, "Post code", "postcode")}
{_text(18, "What is your TCG+ membership number?", "bandai")}{_text(19, "What is your Discord username?", "discord")}
<button type="button" data-testid="edit-form">Edit</button>
<button type="button" id="b2">Continue to Payment</button></section>
<section class="step" id="s3" hidden><h3>Payment</h3>
<div class="PaymentForm"><ul class="PaymentForm Accordion">
<li><details id="d-paypal"><summary data-testid="payment-option-paypal">PayPal</summary><div>PayPal button</div></details></li>
<li><details id="d-card"><summary data-testid="payment-option-credit-card">Credit Card</summary><div>
<label class="f-label-2-bold">Full name</label><label class="f-label-2-bold">Card number</label><label class="f-label-2-bold">Expiry</label><label class="f-label-2-bold">CVV</label>
<iframe id="challenge" src="{challenge_origin}/challenge" width="400" height="120"></iframe>
<button type="button" id="pay" data-testid="braintree-card-submit">Pay Order</button></div></details></li>
<li><details id="d-afterpay"><summary data-testid="payment-option-afterpay">Afterpay</summary><div>Afterpay</div></details></li>
</ul></div></section>
<button type="button" class="cm__btn">Accept all</button><button type="button" class="cm__btn cm__btn--secondary">Reject all</button>
<button type="button" class="privacy-choices">Your privacy choices</button>
{SITE_JS}</body></html>'''


HOLD_PAGE = '''<!doctype html><html><head><meta charset="utf-8"><title>Just a moment...</title><meta http-equiv="refresh" content="2"></head>
<body><div id="cf-wrapper"><h1>Just a moment...</h1><p>Checking your browser before accessing events.humanitix.com.</p>
<p>This process is automatic. Your browser will redirect to your requested content shortly.</p></div></body></html>'''

DONE_PAGE = '''<!doctype html><html><head><meta charset="utf-8"><title>Order complete</title></head><body>
<h1>Payment complete!</h1><p>Your tickets have been emailed to you.</p>''' + SITE_JS + '''</body></html>'''

CHALLENGE_PAGE = '''<!doctype html><html><head><meta charset="utf-8"><title>challenge</title></head><body>
<p>Verify you are human</p><input id="cf-input" name="cf-turnstile-response" placeholder="token"/>
<button type="button" id="verify">Verify</button>
<script>
document.addEventListener("click", function (e) { try { navigator.sendBeacon("/__click", JSON.stringify({tag: e.target.tagName, id: e.target.id, t: Date.now()})); } catch (err) {} }, true);
</script></body></html>'''


class Plan:
    """What the site serves at a given moment. All times are epoch seconds."""
    def __init__(self, before="finals", after="digimon", flip_at=None, doc_error_from=None, doc_error_to=None,
                 sale_str=None, qty_max=None, hold_from=None, hold_to=None, fetch_429_from=None, fetch_429_to=None,
                 expire_after_ms=None, slow_increment_ms=None, continue_ignores_qty=False):
        self.before, self.after, self.flip_at = before, after, flip_at
        self.doc_error_from, self.doc_error_to = doc_error_from, doc_error_to
        self.sale_str, self.qty_max = sale_str, qty_max
        self.hold_from, self.hold_to = hold_from, hold_to                 # document loads get a Cloudflare-style "Just a moment" page
        self.fetch_429_from, self.fetch_429_to = fetch_429_from, fetch_429_to   # background polls get HTTP 429
        self.expire_after_ms = expire_after_ms                           # checkout page shows the expired-hold message after this
        self.slow_increment_ms = slow_increment_ms                       # "+" takes this long to update the value (slow page JS)
        self.continue_ignores_qty = continue_ignores_qty                 # Continue navigates even with qty 0 (human-click scenario)


class Recorder:
    def __init__(self):
        self.requests = []   # {t, path, kind, status}
        self.clicks = []     # dicts from SITE_JS
        self.lock = threading.Lock()

    def add_request(self, path, kind, status):
        with self.lock:
            self.requests.append({"t": time.time(), "path": path, "kind": kind, "status": status})

    def add_click(self, d):
        with self.lock:
            self.clicks.append(d)

    def fetches(self):
        return [r for r in self.requests if r["kind"] == "fetch"]

    def documents(self):
        return [r for r in self.requests if r["kind"] == "document"]


def _make_handler(rec: Recorder, plan: Plan, challenge_origin: str, is_challenge: bool):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _kind(self):
            dest = self.headers.get("Sec-Fetch-Dest", "")
            if self.path.startswith("/__"):
                return "internal"
            if dest == "document" or dest == "iframe":
                return "document"
            if dest == "empty":
                return "fetch"
            return "other"

        def _send(self, code, body, ctype="text/html; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            rec.add_request(self.path, "head", 200)
            self.send_response(200); self.end_headers()

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            if self.path == "/__click":
                try:
                    rec.add_click(json.loads(raw.decode("utf-8", "replace")))
                except Exception:
                    rec.add_click({"tag": "?", "raw": raw[:80].decode("utf-8", "replace")})
                self.send_response(204); self.end_headers(); return
            rec.add_request(self.path, "post", 404)
            self.send_response(404); self.end_headers()

        def do_GET(self):
            path = self.path.split("?")[0]
            kind = self._kind()
            if is_challenge:
                if path == "/challenge":
                    rec.add_request(self.path, kind, 200); self._send(200, CHALLENGE_PAGE.encode()); return
                rec.add_request(self.path, kind, 404); self.send_response(404); self.end_headers(); return

            now = time.time()
            if "/complete" in path:
                rec.add_request(self.path, kind, 200); self._send(200, DONE_PAGE.encode("utf-8")); return
            if re.search(r"/tickets/?$", path):
                if kind == "document" and plan.hold_from and plan.hold_from <= now < (plan.hold_to or 1e18):
                    rec.add_request(self.path, kind, 503); self._send(503, HOLD_PAGE.encode("utf-8")); return
                if kind == "fetch" and plan.fetch_429_from and plan.fetch_429_from <= now < (plan.fetch_429_to or 1e18):
                    rec.add_request(self.path, kind, 429); self._send(429, b"<html><title>429</title><body>Too many requests</body></html>"); return
                if kind == "document" and plan.doc_error_from and plan.doc_error_from <= now < (plan.doc_error_to or 1e18):
                    rec.add_request(self.path, kind, 502)
                    self._send(502, b"<html><head><title>502 Bad gateway</title></head><body>Here's an event we didn't plan for... Bad gateway. "
                                    b"The web server reported a bad gateway error. Error reference number: 502</body></html>")
                    return
                key = plan.after if (plan.flip_at and now >= plan.flip_at) else plan.before
                html = (FIXTURES / f"{key}.html").read_text(encoding="utf-8")
                if plan.sale_str and key == "finals":
                    html = html.replace("Sun 25th Oct 2026, 12:00 pm AEDT", plan.sale_str)
                if plan.qty_max and key == "digimon":
                    html = html.replace('max="1"', f'max="{plan.qty_max}"')
                html = html.replace("https://images.humanitix.com", "/images-stub")   # keep the audit fully offline
                flags = "<script>window.__slowIncrementMs=%s;window.__continueIgnoresQty=%s;</script>" % (plan.slow_increment_ms or 0, "true" if plan.continue_ignores_qty else "false")
                html = html.replace("</body>", flags + SITE_JS + "</body>")
                rec.add_request(self.path, kind, 200); self._send(200, html.encode("utf-8")); return
            if "/details" in path:
                page = checkout_page(challenge_origin)
                if plan.expire_after_ms:
                    page = page.replace("</body>", '<script>setTimeout(function(){var d=document.createElement("div");d.id="expired";d.textContent="Session timed out. Your checkout time has expired.";document.body.prepend(d);}, %d);</script></body>' % plan.expire_after_ms)
                rec.add_request(self.path, kind, 200); self._send(200, page.encode("utf-8")); return
            if path == "/robots.txt":
                rec.add_request(self.path, kind, 200); self._send(200, b"User-agent: *\n", "text/plain"); return
            rec.add_request(self.path, kind, 404)
            self.send_response(404); self.end_headers()
    return H


class Stub:
    """Starts the site and the challenge origin; exposes recorders."""
    def __init__(self, port: int, challenge_port: int, plan: Plan):
        self.site_rec, self.ch_rec = Recorder(), Recorder()
        self.origin = f"http://127.0.0.1:{port}"
        self.challenge_origin = f"http://127.0.0.1:{challenge_port}"
        self._site = http.server.ThreadingHTTPServer(("127.0.0.1", port), _make_handler(self.site_rec, plan, self.challenge_origin, False))
        self._ch = http.server.ThreadingHTTPServer(("127.0.0.1", challenge_port), _make_handler(self.ch_rec, plan, self.challenge_origin, True))
        for s in (self._site, self._ch):
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def stop(self):
        self._site.shutdown(); self._ch.shutdown()
