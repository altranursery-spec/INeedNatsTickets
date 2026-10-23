# One Piece TCG ticket assistant for Humanitix

A Tampermonkey userscript that runs inside your own Chrome. It waits for the sale to open,
puts exactly one ticket in the cart, clicks Continue, and beeps. You finish Turnstile and
payment yourself. It runs as ordinary page JavaScript in your real browser, so there is nothing
for Cloudflare to detect, your login and cookies are your own, and Turnstile behaves the way it
does for any human.

## Events (as configured)

| Event | Tickets page | Sale opens |
|---|---|---|
| Championship 2026 Melbourne Finals (Nationals) | https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-finals-oceania/tickets | Sun 25 Oct 2026, 12:00 pm AEDT |
| Flame Flame Fruit Coliseum | https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-flame-flame-fruit-coliseum-oceania/tickets | Sun 25 Oct 2026, 12:00 pm AEDT |
| Treasure Cup (Jan 2027 side event) | https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-treasure-cup-oceania/tickets | Sun 25 Oct 2026, 12:00 pm AEDT |

The script reads the sale time from each event page itself, so if TAK Games moves it the
script follows. `SALE_TIME` in the script is only the fallback.

## Install (once)

Friends get the short version in `FRIENDS.md`.

1. Install the Tampermonkey extension in Chrome or Edge.
2. **Chrome 138 or newer:** open `chrome://extensions`, click **Details** on Tampermonkey, and turn
   on **Allow User Scripts**. If Chrome asks, also turn on Developer mode at the top right. Without
   this toggle the script never runs.
3. Open the install link in Chrome and click **Install** when Tampermonkey asks:
   https://raw.githubusercontent.com/altranursery-spec/INeedNatsTickets/main/humanitix-sniper.user.js
   Tampermonkey checks that link for updates by itself about once a day. To update right now, open
   the same link again and click **Update**.
4. Open the Finals tickets page. A dark panel appears bottom-right. Click **Settings**, fill in your
   details (name, email, mobile, TCG+ membership number, Discord username, address) and **Save**.
   They are stored only in your own Tampermonkey. Never put card details anywhere in this tool.
5. In that same Chrome, log in to Humanitix if you have an account. Optionally save your card in
   Chrome's autofill so payment is one click.
6. On the Finals tickets page click **Arm sound & test**. You should hear two beeps and every
   checklist row should be green.

## What happens on the checkout page

Humanitix checkout is one page in three steps: Buyer information, Ticket info, Payment. The
script fills every field it has an answer for (text boxes, dropdowns, checkboxes, yes/no
choices), then clicks "Continue to Ticket info" and "Continue to payment" by itself once every
required field on the step is filled. On the Payment step it selects the credit/debit card option
so the card form is open and waiting. It never clicks a pay or order button. You enter the card
and pay.

The Ticket info step for TAK Games events asks for: first name, last name, mobile, email, country,
street address, suburb, post code, TCG+ membership number and Discord username. All of these
come from `BUYER`.

If a required question has no answer in the script, the panel turns orange and says
**Needs you: <question>**, and it does not move on until you fill it. To make that never happen:

1. During the Saturday dry run, on the Ticket info step, click the panel's **Copy fields**
   button. It copies the exact list of questions, with the dropdown options, to your clipboard.
2. Add one line per question to `ANSWERS` in the script, for example
   `[/country of residence/i, "Australia"],` or `[/shirt size/i, "L"],`. Text answers fill text
   boxes, dropdowns (matched by option text) and yes/no choices; `true` ticks a checkbox.
   Consent checkboxes ("I agree to the rules") are ticked already.
3. Save, press **Reset**, run the dry run again and confirm no "Needs you" appears.

TAK Games' One Piece events may ask slightly different questions from the Digimon one, so
keep the panel in view on Sunday. Anything it cannot answer it will name, and you type it.

## The panel checklist

Every row must be green before the sale. Red means fix it.

| Row | Green means | If red |
|---|---|---|
| Script | the script is loaded (shows version) | Tampermonkey is off, Allow User Scripts is off, or the slug in `EVENTS` does not match the URL |
| Sale time | the time was read from the page (or the fallback) | neither the page nor `SALE_TIME` gave a time; check the page by eye |
| Clock | your PC clock agrees with Humanitix within a few seconds | fix Windows time sync; the script corrects large errors but a good clock is better |
| Ticket | the right ticket card was found | the `match` text in `EVENTS` does not match any ticket name; the script falls back to the first card |
| Buyer | your details are saved in Settings | click **Settings** on the panel, fill in, Save |
| Sound | Chrome will play the beep | click **Arm sound & test** once after every page load |
| Visible | the tab is on screen | put the tab in its own window; hidden tabs are slowed by Chrome |
| Single tab | this is the only tab open for this event | close the duplicate; only one tab per event grabs |

Buttons: **Settings** opens the form for your details. **Arm sound & test** plays the beep and unlocks sound for the tab. **Reset** clears the
"already grabbed" memory for all events and reloads; use it after a dry run or if a checkout
expired. **Copy fields** (checkout page only) copies the list of questions on the form.

## Saturday 24 October: rehearsal

1. `python3 -I selfcheck.py` must end with `RESULT: ALL GOOD`. If not, the Humanitix page changed;
   get the script updated before Sunday.
2. `python3 -I discover.py` to confirm all three events still list the same sale time.
3. Dry run on a live event that is already on sale. The script ships with a "DRY RUN" entry for it:
   - Open https://events.humanitix.com/digimon-card-game-championship-2026-online-november-regional-oceania/tickets
   - The event is already on sale, so the script grabs straight away: quantity 1, Continue, the
     checkout page opens with your details prefilled, Ticket info filled, Continue to Payment,
     card form open. On sale day the picker does not exist until 12:00, so it waits.
   - Close the tab. Do not pay. The ticket is released when the 20 minute timer runs out.
   - Press **Reset** on any open panel. Do this once, not repeatedly: each run holds one of that
     event's tickets for 20 minutes.
4. Open the Finals page and confirm every checklist row is green and the countdown is running.

## Sunday 25 October: sale day

| Time (AEDT) | Do |
|---|---|
| 11:00 to 11:30 | Close every other tab on events.humanitix.com. Make sure Chrome is not muted and the PC will not sleep. Open one tab per event at its `/tickets` URL (three events: Finals, Flame Flame Fruit, Treasure Cup). Earlier is fine and costs nothing; if a Cloudflare queue is already running, earlier arrival can only help. |
| 11:30 | Drag each tab into its own window and arrange them side by side so every tab stays visible. Do not minimise them. Click **Arm sound & test** in each. Every checklist row green. |
| 11:30 | Optional backup: on your phone, on mobile data, open the Finals tickets page in the normal browser and leave it. It is a separate queue entry. Only buy from the phone if the PC tab has not reached checkout, and never buy the same ticket twice. |
| 11:55 | Hands on keyboard, card and TCG+ ID ready. Both windows visible. Do not refresh anything. If a tab shows a Cloudflare "waiting room" page, leave it; it refreshes itself and the script resumes when you are let in. |
| 11:59:57 | The script starts polling once per second. When Humanitix flips to on-sale it reloads once, adds 1 ticket, clicks Continue and beeps. If the page errors or comes back blank, it reloads again by itself, at most once a second, for up to 30 minutes. |
| after the beep | Go to the beeping window. The script fills buyer details and Ticket info and moves to the Payment step by itself. If the panel says "Needs you: …", type that answer. Pass Turnstile if it appears, enter your card, pay. Humanitix holds the ticket for 20 minutes, shown top-right. Do the Finals first, then Flame Flame Fruit, then Treasure Cup. |

## If something goes wrong on the day

- **You want to click it yourself.** Go ahead. A real click on "+" or Continue makes the script
  stand aside; it will not double-click, and it still fills the checkout for you.
- **"Sold out" at 12:00:03.** Leave the tab open. Held tickets return to stock when people fail to
  pay within 20 minutes, and the script checks every 10 seconds for 45 minutes and grabs when one
  comes back. It will not join the waitlist for you.
- **Cloudflare "Just a moment" or waiting room.** Leave it. The script never reloads those pages;
  they move on by themselves and it resumes.
- **The page errors or goes blank.** It reloads by itself, every 2 seconds (5 seconds after ten
  failures), for up to 30 minutes after the sale time. If Humanitix answers "too many requests",
  it slows down and speeds back up when the site recovers.
- **Your hold expires.** The script goes back to the tickets page by itself and grabs again.
- **Humanitix's bot check fails at a step.** The panel tells you; click "try again" on the page and
  the script carries on.
- **You already bought.** The panel says so and will not grab another, even if you reopen the page.
  Reset is the only way to make it try again.

## What it will not do

One ticket per event only (also the site's own limit). No CAPTCHA or Turnstile automation,
no automatic payment, no waitlist joining, no stealth or fingerprint tricks, never more than one
background request per second. Humanitix's buyer terms should be read in the browser before
sale day; this tool keeps a human on every irreversible step.

## What has been tested

By you, in your own Chrome, on your own Humanitix test event (20 Oct 2026, sale scheduled for
9:00 am): the script read the sale time from the page, counted down, polled from three seconds
out, caught the flip at 9:00, reloaded, added one ticket, clicked Continue, and filled the
checkout including the Ticket info questions copied from TAK Games' form. This is the full
Sunday path on the live site.

By you, in your own Chrome (Digimon online regional, 19 Oct 2026): the script grabbed the
ticket, filled Buyer information, set the newsletter boxes, filled every Ticket info field
including TCG+ membership number and Discord username, clicked Continue to Payment, and
opened the credit card form. Nothing was paid.

Live on Humanitix (Digimon online regional, 19 Oct 2026): quantity 1, Continue, real checkout
page about a second later, in-page navigation detected, buyer fields prefilled (first name, last
name, email, email confirmation, mobile), 20 minute hold timer visible and not covered by the
panel. Checkouts closed without paying. When the automated test browser clicked "Continue to
Ticket info", Humanitix replied "Bot protection could not verify your browser": that is Turnstile
rejecting an automated browser, and it is the reason this script runs in your real Chrome. The
Ticket info fields are therefore matched by label; your Saturday dry run confirms them.

Offline, against saved copies of the real pages: the countdown, the not-on-sale polling, the
switch from not-on-sale to on-sale followed by the grab, recovery from an error page at sale
time, use of the page's own sale time over the fallback, the duplicate-tab lock, and the
Continue retry. Against a copy of Humanitix's checkout markup: text, date, dropdown, checkbox
and yes/no questions filled, both step buttons clicked, the pay button never clicked, and an
unanswerable required question stopping the script and being named in the panel.

## Bot-conduct audit

`tests/` holds an audit that proves the script stays inside the limits bot protection cares about:
rate-limited requests, no browser spoofing, no contact with CAPTCHA or card frames, one ticket, no
payment, only the expected clicks. It runs against a local copy of the Humanitix pages, so it is
safe to run as often as you like, and it keeps working after you edit the script. See
`tests/README.md`. Setup once with `bash tests/setup.sh`, then run
`.venv/bin/python -I tests/bot_audit.py`.

## Sharing with friends

Everyone installs from the same link, enters their own details in Settings on their own PC, and
buys one ticket with their own account and card. Nothing personal is in the shared file. When
you change the script (for example adding the Treasure Cup slug), push it to GitHub and every
installed copy updates itself within a day; friends can also force it from the Tampermonkey
Dashboard with "Check for userscript updates".

## Files

- `humanitix-sniper.user.js`: the script. Selectors live at the top under `SEL`.
- `FRIENDS.md`: the plain-language install guide to send to friends.
- `selfcheck.py`: Saturday check that Humanitix's pages still match the script.
- `discover.py`: lists TAK Games' One Piece events and their on-sale times.
- `tests/`: the bot-conduct audit.
