# One Piece tickets helper: install guide

This is a small add-on for Chrome that waits on the Humanitix ticket page, grabs one ticket the
instant the sale opens, and fills in your checkout details. You still do the last step and pay.
It takes about ten minutes to set up. Do it the day before the sale, not on the day.

## 1. Install Tampermonkey

1. In Chrome, search the Chrome Web Store for **Tampermonkey** and click **Add to Chrome**.
2. Type `chrome://extensions` in the address bar and press Enter.
3. Find Tampermonkey, click **Details**, and switch on **Allow User Scripts**. If you cannot see
   that switch, turn on **Developer mode** at the top right of the page first.
4. Click the puzzle-piece icon at the top right of Chrome and pin Tampermonkey so its icon stays visible.

## 2. Install the helper

1. Open this link in Chrome:
   https://raw.githubusercontent.com/altranursery-spec/INeedNatsTickets/main/humanitix-sniper.user.js
2. Tampermonkey opens a page describing the script. Click **Install**.

## 3. Put in your details

1. Open the Finals ticket page:
   https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-finals-oceania/tickets
2. A dark box appears at the bottom right. Click **Settings**.
3. Fill in your name, email, mobile, TCG+ membership number, Discord username and address. Click **Save**.
   These stay on your own computer. Do not put card details anywhere.
4. Click **Arm sound & test**. You should hear two beeps. Every line in the box should now have a green tick.

## 4. Sale day: Sunday 25 October, 12:00 pm Melbourne time

1. By 11:30, open these two pages, each in its own Chrome window, side by side so both stay on screen:
   - https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-finals-oceania/tickets
   - https://events.humanitix.com/one-piece-card-game-championship-2026-melbourne-flame-flame-fruit-coliseum-oceania/tickets
2. Click **Arm sound & test** in each. Check every line has a green tick. Then leave them alone.
   Do not refresh. Do not open the same page twice.
3. At 11:55 sit down with your card. At 12:00 the helper grabs a ticket and beeps.
4. Go to the beeping window. Your details are filled in and the card form is open. Enter your card and
   click **Pay Order**. Do the Finals window first, then the other one. You have 20 minutes for each.

If a line in the box is red, it tells you what to fix. If the box says "Needs you: …", type that
answer yourself. If a page shows a Cloudflare waiting room, leave it alone; it moves on by itself.
