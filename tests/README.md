# Bot-conduct audit

Checks that `humanitix-sniper.user.js` behaves like a careful, human-driven page helper and gives
bot protection nothing to object to. Everything runs against a local stand-in for Humanitix built
from saved copies of the real pages. Nothing contacts the internet.

## What it can and cannot tell you

A full pass proves the script:

- runs only on events.humanitix.com, in the top frame, and talks to no other site;
- changes nothing about how your browser identifies itself (no navigator, WebGL, canvas or screen overrides);
- never references or touches Turnstile, reCAPTCHA, hCaptcha or any solver service;
- never reaches into iframes, which is where Turnstile and the Braintree card fields live;
- loads no remote code;
- sends at most one background request per second while polling, keeps reloads at least a second
  apart, and makes almost no requests while waiting;
- buys exactly one ticket even if the page allows more;
- clicks only the quantity "+", Continue, the two step buttons, form controls, and the Credit Card
  option, and never Pay Order, Edit, waitlist, cookie or other payment buttons;
- does nothing at all on pages that are not in `EVENTS`;
- lets only one tab per event reach checkout.

It cannot predict Cloudflare's decision. That depends on your browser, IP address, cookies and
history as well as on the script. The evidence for that part is your own dry run in real Chrome,
which passed Turnstile at "Continue to Ticket info".

## Setup (once)

```
bash tests/setup.sh
```

This creates `.venv` with Playwright and downloads a Chromium for it. Needs Python 3.11+.

## Run

```
.venv/bin/python -I tests/bot_audit.py
```

About five minutes. Add check ids to run a subset, e.g. `tests/bot_audit.py S D2 D5`.
To audit a different copy of the script: `SCRIPT=path/to/file.user.js .venv/bin/python -I tests/bot_audit.py`.

## The checks

| id | What it looks at | Pass means |
|---|---|---|
| S1 | script header | only `https://events.humanitix.com/*`, `@noframes` set, no `@connect`, no cross-site request API |
| S2 | source | no overrides of navigator, user agent, plugins, languages, WebGL, canvas, screen |
| S3 | source | no Turnstile, reCAPTCHA, hCaptcha APIs or solver services |
| S4 | source | no `contentWindow`, `contentDocument`, `frames[]`, `postMessage` |
| S5 | source | no `eval`, `new Function`, script injection |
| S6 | source | every URL mentioned is on humanitix.com |
| S7 | source | poll interval ≥ 1 s, reload gap ≥ 1 s, keepalive ≥ 10 s (WARN if you renamed the constants; D1 to D3 measure the real values anyway) |
| S8 | source | the pay/order button guard exists and Pay Order is never a click target |
| D1 | 70 s on a page whose sale is an hour away | at most 2 background requests, no reloads, no clicks |
| D2 | 20 s of polling with the sale never opening | ≥ 10 polls, shortest gap ≥ 0.9 s, no reload of a healthy page |
| D3 | sale opens but the reload hits "Bad gateway" for 6 s | reloads ≥ 0.9 s apart, recovers, reaches checkout; reports detection-to-reload time |
| D4 | picker allows up to 5 tickets | exactly one "+" click, one Continue click, order quantity 1 |
| D5 | every click on the tickets and checkout pages is recorded | only allowed controls clicked; Pay Order, Edit, PayPal, Afterpay, cookie buttons untouched; reports load-to-Continue time |
| D6 | checkout embeds a frame from a second origin with a "Verify" button and an input | frame loaded once, no other requests to it, no clicks inside, input untouched, no script errors |
| D7 | a page whose event is not in `EVENTS` | no panel, no requests, no clicks |
| D8 | two tabs on the same event | exactly one reaches checkout |
| D9 | every request the browser made during the audit | only the local stand-in origins |
| D10 | reload lands on a Cloudflare "Just a moment" page that refreshes itself | the script adds no reloads of its own, then grabs when it clears |
| D11 | page is sold out, tickets return 16 s later | checks at least 9 s apart, grabs the returned ticket |
| D12 | a real person clicks Continue while the script is still setting the quantity | Continue clicked exactly once (theirs), script stands aside, checkout reached |
| D13 | the checkout hold expires | goes back to the tickets page and grabs again |
| D14 | the order-complete page was seen earlier | tickets page shows "Already bought", no clicks |
| D15 | background polls answered with 429 for 9 s | gaps grow to several seconds, then recovery and grab |

## Editing the script

The audit reads the script file fresh each run and patches only three config keys by name
(`EVENTS`, `SALE_TIME`, the `BUYER` values). Everything else is observed from the outside, so you
can rename functions, restructure, or add features and the dynamic checks still apply. If you rename
a rate constant, S7 downgrades to WARN and D1 to D3 still measure the real behaviour. If you remove
`EVENTS` or `BUYER` entirely, the audit says so and skips what it cannot target.

Failures are the point: if you make a change that polls faster than once a second, clicks a new
button, or touches a frame, the relevant check turns FAIL and names it.

## Files

- `bot_audit.py`: the checks.
- `stub.py`: the local stand-in site: serves the fixtures, a checkout page copied from Humanitix's
  markup, a second-origin "challenge" frame, and records every request and click.
- `fixtures/`: saved real pages (Finals not on sale, Digimon on sale, Treasure Cup sold out).
- `out/`: browser profiles created during runs; safe to delete.
