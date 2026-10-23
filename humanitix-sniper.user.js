// ==UserScript==
// @name         Humanitix on-sale assistant (One Piece TCG)
// @namespace    ineednatstickets
// @version      1.4.1
// @description  Grabs ONE ticket the instant a configured Humanitix event goes on sale, then hands over to you for Turnstile and payment.
// @match        https://events.humanitix.com/*
// @homepageURL  https://github.com/altranursery-spec/INeedNatsTickets
// @updateURL    https://raw.githubusercontent.com/altranursery-spec/INeedNatsTickets/main/humanitix-sniper.user.js
// @downloadURL  https://raw.githubusercontent.com/altranursery-spec/INeedNatsTickets/main/humanitix-sniper.user.js
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @noframes
// ==/UserScript==

/*
  HOW IT WORKS (README.md has the sale-day checklist)
  - You open each event's /tickets page in your own Chrome before the sale.
  - The panel (bottom-right) shows a countdown and a checklist. Every row must be green.
  - Before the sale the script only sends a quiet background request every 60 s (every 10 s in
    the last two minutes) so your session stays warm. Each reply is checked: if the sale opens
    early, the script notices.
  - From three seconds before the sale it polls once per second. The moment Humanitix says the
    tickets are on sale it reloads once, sets the quantity to 1, clicks Continue, confirms the
    checkout page opened, and BEEPS. If Continue does not go through it retries, and if the page
    errors it reloads by itself (never more than once per second, for up to 10 minutes).
  - On the checkout page it prefills your details and keeps doing so through every step for the
    20-minute hold. You do Turnstile (usually automatic) and payment yourself.
  - It never touches CAPTCHAs, never pays, never joins waitlists, never buys more than one
    ticket, and only one tab per event will ever grab.
*/

const VERSION = "1.4.1";

// ─────────────────────────── CONFIG: edit these ───────────────────────────

const EVENTS = [
    { name: "TEST", slug: "digimon-card-game-championship-2026-online-november-regional-oceania", match: "" },
  {
    name: "Finals (Nationals)",
    slug: "one-piece-card-game-championship-2026-melbourne-finals-oceania",
    match: "Competitor Entry",        // substring of the ticket name to pick; "" = first ticket card
  },
  {
    name: "Flame Flame Fruit Coliseum",
    slug: "one-piece-card-game-championship-2026-melbourne-flame-flame-fruit-coliseum-oceania",
    match: "Player Entry",
  },
  {
    name: "Treasure Cup",
    slug: "one-piece-card-game-championship-2026-melbourne-treasure-cup-oceania",
    match: "Competitor Entry",
  },
];

// FALLBACK only. The script reads the real sale time from each event page ("Sales start at …").
// "+11:00" is AEDT (Melbourne/Sydney daylight time).
const SALE_TIME = "2026-10-25T12:00:00+11:00";

// Your details are entered through the Settings button on the panel and stored privately in your
// own Tampermonkey. Nothing personal lives in this file. These are only the defaults.
const BUYER_DEFAULTS = {
  firstName: "",
  lastName: "",
  email: "",
  mobile: "",
  bandaiNumber: "",   // TCG+ membership number ("What is your TCG+ membership number?")
  discordId: "",      // Discord username ("What is your Discord username?")
  // Address block on the Ticket info step
  country: "Australia",
  streetAddress: "",
  suburb: "",
  postcode: "",
  state: "",          // only if the form has a state/region dropdown
  dateOfBirth: "",    // DD/MM/YYYY, only if the form asks
};
const BUYER_FIELDS = [
  ["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["mobile", "Mobile"],
  ["bandaiNumber", "TCG+ membership number"], ["discordId", "Discord username"],
  ["streetAddress", "Street address"], ["suburb", "Suburb"], ["postcode", "Post code"], ["country", "Country"],
  ["state", "State (only if the form asks)"], ["dateOfBirth", "Date of birth DD/MM/YYYY (only if the form asks)"],
];
function loadBuyer() {
  let saved = {};
  try { saved = GM_getValue("buyer", {}) || {}; } catch (e) {}
  const out = Object.assign({}, BUYER_DEFAULTS);
  for (const [k] of BUYER_FIELDS) if (saved[k] !== undefined && String(saved[k]).trim()) out[k] = String(saved[k]).trim();
  return out;
}
const BUYER = loadBuyer();

// Answers for checkout questions: [label pattern, value].
// Text answers fill text boxes, dropdowns (matched by option text) and radio buttons.
// `true` ticks a checkbox, `false` unticks one. Use the panel's "Copy fields" button on the checkout page to see
// the exact questions, then add one line per question here.
const ANSWERS = [
  [/i agree|accept the|terms|rules|conditions|code of conduct/i, true],   // consent checkboxes
  [/humanitix can send me emails/i, false],                                 // untick the Humanitix newsletter
  [/keep me updated/i, false],                                              // untick the TAK Games newsletter
  [/email tickets to attendees/i, true],                                    // tick "Email tickets to attendees"
  // [/country of residence/i, "Australia"],
  // [/deck ?list/i, "Will submit via TCG+"],
];

// Click "Continue to Ticket info" and "Continue to payment" by itself once every required field
// on the step is filled. Never clicks a pay/order button. Set to false to stop after filling.
const AUTO_ADVANCE = true;

// On the Payment step, select this payment method so the card form is open and waiting for you.
// Matched against the option's text. Set to null to leave the payment method alone.
const PAYMENT_METHOD = /credit|debit|\bcard\b/i;

// Tuning (defaults are fine)
const KEEPALIVE_SECONDS = 60;          // background request cadence before the sale (0 = off)
const KEEPALIVE_NEAR_SECONDS = 10;     // cadence in the last two minutes before the sale
const POLL_START_BEFORE_MS = 3000;     // start once-per-second polling this long before the sale time
const POLL_INTERVAL_MS = 1000;         // never below 1000
const POLL_SLOW_AFTER_MINUTES = 10;    // this long after the sale time, poll every 3 s instead of 1 s
const GIVE_UP_AFTER_MINUTES = 30;      // stop trying this long after the sale time
const SOLDOUT_WATCH_SECONDS = 10;      // when sold out, check for returned tickets this often
const SOLDOUT_WATCH_MINUTES = 45;      // ...for this long (held tickets come back when people don't pay within 20 min)
const PREFILL_FOR_MINUTES = 20;        // keep prefilling checkout fields for this long (the hold length)
const GRAB_ATTEMPTS = 3;               // Continue clicks to try before reloading
const NAV_WAIT_MS = 6000;              // how long to wait for the checkout page after clicking Continue
const MIN_RELOAD_GAP_MS = 1000;        // never reload faster than this

// ─────────────────────────── Selectors (from the live Humanitix DOM) ───────────────────────────

const SEL = {
  ticketCard: "li.TicketCard",
  ticketName: "h3.name",
  qtyInput: 'input[data-testid^="value-"]',
  increment: '[data-testid^="increment-"]',
  pickerValue: '[data-testid="picker-value"]',
  checkoutBtn: '[data-testid="checkout-btn"]',
  saleState: ".sale-state",
  ticketForm: "#ticket-form",
  errorBoxes: '[class*="TicketErrorModal"], [class*="ErrorSummary"], .bottom-alerts, [role="dialog"], [role="alertdialog"]',
};
const NOT_ON_SALE_RE = /sales start/i;
const SOLD_OUT_RE = /sold out/i;
// Pages to leave alone: Cloudflare waiting room and browser checks. They move on by themselves; reloading them restarts them.
const HOLD_PAGE_RE = /waiting room|you are (now )?in (a |the )?(queue|line)|estimated wait time|just a moment|checking your browser|verify you are human|performing security verification|cf-chl|challenge-platform|cf-browser-verification/i;
const ON_SALE_HTML_MARKER = 'data-testid="increment-';
const ERROR_PAGE_RE = /something went wrong|please refresh|try again later|service unavailable|internal server error|bad gateway|gateway time-?out|origin is unreachable|rate limit|too many requests|error 5\d\d|error reference number: 5\d\d|<title>5\d\d/i;
const UNAVAILABLE_RE = /sold out|no longer available|not available|unavailable|allocation exhausted|exceeded the/i;
const SESSION_EXPIRED_RE = /session timed out|checkout time has expired|timer has run out|your tickets have been released/i;
const DONE_RE = /payment complete!|order processed!|your order is confirmed|thanks for your order|order confirmed/i;
const BOT_CHECK_FAIL_RE = /bot protection could not verify|could not verify your browser|verification failed/i;

// ─────────────────────────── Tickets page ───────────────────────────

async function runTicketsPage(ev) {
  const slug = ev.slug;
  const grabbedKey = "grabbed:" + slug;
  const ui = makePanel(ev.name);
  ui.pf("script", true, "Script v" + VERSION + " loaded");

  const tab = tabIdentity();
  const isDup = watchDuplicates(slug, tab, (dup) =>
    ui.pf("single", !dup, dup ? "DUPLICATE TAB. Close this one; the other tab will grab." : "Only tab for this event"));

  const vis = () => ui.pf("visible", !document.hidden, document.hidden ? "Tab hidden. Keep it on screen in its own window." : "Tab visible");
  vis();
  document.addEventListener("visibilitychange", vis);

  const snd = () => ui.pf("sound", isAudioArmed(), isAudioArmed() ? "Sound armed" : "Click 'Arm sound & test'");
  snd();
  onAudioArmed(snd);

  const buyerOk = ["firstName", "lastName", "email", "mobile"].every((k) => BUYER[k] && BUYER[k].trim());
  ui.pf("buyer", buyerOk, buyerOk ? "Your details are saved" : "Click Settings and fill in your details");

  if (isHoldPage()) {
    ui.state("Cloudflare queue or browser check in progress. Leave this page alone; it moves on by itself and the script resumes.", "warn");
    ui.pf("time", null, "Waiting for Cloudflare");
    ui.pf("clock", null, "");
    ui.pf("ticket", null, "");
    // If the check finishes in place (no navigation), restart cleanly once the ticket list is there.
    setInterval(() => { if (findCards().length) safeReload(slug, "hold page cleared"); }, 5000);
    return;
  }

  // Sale time: the page's own text wins, SALE_TIME is the fallback.
  const pageStr = readPageSaleDateStr();
  const pageMs = parseHumanitixDate(pageStr);
  const cfgMs = new Date(SALE_TIME).getTime();
  const rememberedMs = Number(GM_getValue("saleAt:" + slug, NaN));
  let saleAt = NaN, src = "";
  if (!Number.isNaN(pageMs)) { saleAt = pageMs; src = "page"; GM_setValue("saleAt:" + slug, pageMs); }
  else if (!Number.isNaN(rememberedMs)) { saleAt = rememberedMs; src = "remembered from page"; }
  else if (!Number.isNaN(cfgMs)) { saleAt = cfgMs; src = "SALE_TIME fallback"; }
  if (Number.isNaN(saleAt)) {
    ui.pf("time", false, "No sale time on the page or in SALE_TIME. Watching the page only.");
  } else {
    let t = "Sale " + fmtMelbourne(saleAt) + " (" + src + ")";
    if (src === "page" && !Number.isNaN(cfgMs) && Math.abs(cfgMs - pageMs) > 60000) t += ". Differs from SALE_TIME; page wins.";
    ui.pf("time", true, t);
  }

  const clock = await serverClockOffset();
  const now = () => Date.now() + clock.applied;
  if (clock.unknown) ui.pf("clock", null, "Could not read Humanitix's clock; using the PC clock");
  else ui.pf("clock", Math.abs(clock.raw) < 5000, "PC clock vs Humanitix: " + Math.round(clock.raw / 1000) + " s" + (clock.applied ? " (corrected)" : ""));

  // Ticket list present? If not, this is an error or blank page: recover by reloading.
  let cards = findCards();
  if (!cards.length) {
    const bodyText = (document.body && document.body.innerText || "").slice(0, 3000);
    const why = ERROR_PAGE_RE.test(bodyText) ? "an error page" : "no ticket list";
    ui.pf("ticket", false, "Page shows " + why);
    if (!Number.isNaN(saleAt) && now() > saleAt + GIVE_UP_AFTER_MINUTES * 60000) {
      ui.state("Gave up " + GIVE_UP_AFTER_MINUTES + " min after the sale time. Reload manually.", "bad");
      return;
    }
    const remaining = Number.isNaN(saleAt) ? Infinity : saleAt - now();
    const hot = Date.now() - Number(GM_getValue("hot:" + slug, 0)) < 5 * 60000;   // we reloaded because the sale opened
    const fails = Number(GM_getValue("fails:" + slug, 0)) + 1;
    GM_setValue("fails:" + slug, fails);
    const delay = (hot || remaining <= POLL_START_BEFORE_MS) ? (fails > 10 ? 5000 : 2000) : 30000;
    ui.state("Page shows " + why + " (" + fails + "x). Reloading in " + delay / 1000 + " s.", "warn");
    setTimeout(() => safeReload(slug, why), delay);
    return;
  }
  GM_deleteValue("fails:" + slug);
  let card = pickCard(ev, cards);
  const matched = !ev.match || ticketName(card).toLowerCase().includes(ev.match.toLowerCase());
  ui.pf("ticket", matched, (matched ? "Ticket: " : "No ticket matching '" + ev.match + "', using first: ") + ticketName(card));

  // Ticket already bought in this browser? Never grab another by itself.
  const doneAt = GM_getValue("done:" + slug, 0);
  if (doneAt) {
    ui.state("Already bought at " + new Date(doneAt).toLocaleTimeString() + ". Nothing to do. Press Reset only if you really want another ticket.", "ok");
    return;
  }

  // Checkout already reached in this browser? Don't grab again by itself.
  const grabbedAt = GM_getValue(grabbedKey, 0);
  if (grabbedAt) {
    ui.state("Checkout was reached at " + new Date(grabbedAt).toLocaleTimeString() + ". Finish it there. Starting over? Press Reset.", "ok");
    return;
  }

  // On sale right now (dry run, late start, or page reloaded after detection)? Go.
  if (findQty(card)) {
    await grab(ev, card, ui, tab, isDup);
    return;
  }
  if (SOLD_OUT_RE.test(card.textContent || "")) {
    startSoldOutWatch(ev, ui);
    return;
  }

  // Watch the DOM in case Humanitix updates the card live.
  let done = false;
  const observer = new MutationObserver(() => {
    if (done) return;
    const cs = findCards();
    if (!cs.length) return;
    const c = pickCard(ev, cs);
    if (findQty(c)) {
      done = true;
      observer.disconnect();
      grab(ev, c, ui, tab, isDup);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const giveUpAt = saleAt + GIVE_UP_AFTER_MINUTES * 60000;
  let lastKeepalive = Date.now();
  let lastPoll = 0;
  let busy = false;

  const handleVerdict = (verdict, phase) => {
    if (done) return;
    if (verdict === "onsale") {
      done = true; observer.disconnect();
      ui.state("ON SALE (" + phase + "). Reloading to grab.", "ok");
      GM_setValue("hot:" + slug, Date.now());
      safeReload(slug, "on sale");
    } else if (verdict === "queue") {
      done = true; observer.disconnect();
      ui.state("Cloudflare queue is active. Reloading once to join it.", "warn");
      safeReload(slug, "queue");
    } else if (verdict === "soldout") {
      done = true; observer.disconnect();
      beep(3);
      startSoldOutWatch(ev, ui);
    }
  };
  let backoff = 0;   // consecutive 429/5xx answers to polls

  const tick = async () => {
    if (done) return;
    const t = now();
    const remaining = saleAt - t;
    ui.countdown(remaining);

    if (!(remaining <= POLL_START_BEFORE_MS)) {
      // Waiting phase (also used when no sale time is known: remaining is NaN).
      ui.state(Number.isNaN(remaining) ? "No sale time known. Checking the page once a minute." : "Waiting for the sale. Leave this tab open and visible.", "idle");
      const cadence = (remaining < 120000 ? KEEPALIVE_NEAR_SECONDS : KEEPALIVE_SECONDS) * 1000;
      if (KEEPALIVE_SECONDS > 0 && !busy && Date.now() - lastKeepalive >= cadence) {
        lastKeepalive = Date.now();
        busy = true;
        try { handleVerdict(classifyTicketsHtml((await fetchTicketsHtml()).html, ev), "keepalive"); }
        catch (e) { log("keepalive error", e); }
        finally { busy = false; }
      }
      return;
    }

    if (t > giveUpAt) {
      done = true; observer.disconnect();
      ui.state("Gave up " + GIVE_UP_AFTER_MINUTES + " min after the sale time. Reload manually to try again.", "bad");
      return;
    }
    // 1 s for the first minutes, 3 s later on, and doubling (to 10 s) while Humanitix answers 429/5xx.
    const slow = t > saleAt + POLL_SLOW_AFTER_MINUTES * 60000;
    const interval = Math.min(10000, Math.max(1000, POLL_INTERVAL_MS) * (slow ? 3 : 1) * Math.pow(2, backoff));
    if (busy || Date.now() - lastPoll < interval) return;
    busy = true;
    lastPoll = Date.now();
    ui.state(backoff ? "Humanitix is struggling (" + (slow ? "slow" : "busy") + "). Polling every " + interval / 1000 + " s." : slow ? "Still watching, every 3 s." : "Sale time. Polling once per second.", "warn");
    try {
      const r = await fetchTicketsHtml();
      backoff = (r.status === 429 || r.status >= 500) ? Math.min(backoff + 1, 3) : 0;
      const verdict = classifyTicketsHtml(r.html, ev);
      log("poll", verdict, r.status);
      handleVerdict(verdict, "poll");
    } catch (e) {
      log("poll error", e);
    } finally {
      busy = false;
    }
  };

  tick();
  setInterval(tick, 100);

  // Chrome slows timers in hidden tabs. Tick at once when the tab becomes visible, and nag while hidden near sale time.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  setInterval(() => {
    if (done) return;
    if (document.hidden && saleAt - now() < 20 * 60 * 1000) document.title = "⚠ KEEP THIS TAB VISIBLE";
  }, 5000);
}

// Sold out is not the end: held tickets return to stock when people don't pay within the 20-minute hold.
let soldOutWatching = false;
function startSoldOutWatch(ev, ui) {
  if (soldOutWatching) return;
  soldOutWatching = true;
  const slug = ev.slug;
  const until = Date.now() + SOLDOUT_WATCH_MINUTES * 60000;
  ui.state("Sold out. Watching for returned tickets every " + SOLDOUT_WATCH_SECONDS + " s for " + SOLDOUT_WATCH_MINUTES + " min (held tickets come back when people don't pay). Leave this tab open.", "warn");
  let busy = false;
  const iv = setInterval(async () => {
    if (Date.now() > until) { clearInterval(iv); ui.state("Sold out. Stopped watching after " + SOLDOUT_WATCH_MINUTES + " min.", "bad"); return; }
    if (busy) return;
    busy = true;
    try {
      const r = await fetchTicketsHtml();
      const verdict = classifyTicketsHtml(r.html, ev);
      log("soldout watch", verdict, r.status);
      if (verdict === "onsale") {
        clearInterval(iv);
        beep(6);
        GM_setValue("hot:" + slug, Date.now());
        ui.state("TICKETS RETURNED. Reloading to grab.", "ok");
        safeReload(slug, "returned stock");
      }
    } catch (e) { log("soldout watch error", e); }
    finally { busy = false; }
  }, SOLDOUT_WATCH_SECONDS * 1000);
}

async function grab(ev, card, ui, tab, isDup) {
  const slug = ev.slug;
  const grabbedKey = "grabbed:" + slug;
  const lockKey = "grabbing:" + slug;

  if (isDup()) {
    ui.state("Duplicate tab: standing down, the other tab is grabbing.", "warn");
    return;
  }
  const lock = GM_getValue(lockKey, null);
  if (lock && lock.id !== tab.id && Date.now() - lock.t < 10000) {
    ui.state("Another tab is grabbing this event. Standing down.", "warn");
    return;
  }
  GM_setValue(lockKey, { id: tab.id, t: Date.now() });
  ui.state("GRABBING.", "ok");
  beep(2);

  for (let attempt = 1; attempt <= GRAB_ATTEMPTS; attempt++) {
    const cards = findCards();
    if (cards.length) card = pickCard(ev, cards);
    const input = findQty(card);
    if (!input) { await sleep(300); continue; }

    // If Continue causes a full page load (not Humanitix's usual in-page move), record the grab on the way out.
    const onHide = () => { GM_setValue(grabbedKey, Date.now()); GM_deleteValue(lockKey); };
    window.addEventListener("pagehide", onHide, { once: true });

    let navigated = null;
    if (humanTookOver) {
      // You clicked the page yourself. The script steps aside and just waits for checkout to open.
      ui.state("You're clicking it yourself. Standing aside; waiting for the checkout page.", "ok");
      navigated = await waitFor(() => !/\/tickets\/?$/.test(location.pathname), 120000);
    } else {
      await setQuantityOne(card, input);
      if (!humanTookOver) {
        const btn = await waitFor(enabledCheckoutButton, 4000);
        if (humanTookOver) { /* they beat us to it; don't double-click */ }
        else if (btn) btn.click();
        else {
          const form = document.querySelector(SEL.ticketForm);
          if (form && form.requestSubmit) form.requestSubmit();
        }
        log("grab", "attempt " + attempt + ": " + (humanTookOver ? "you clicked Continue; not clicking again" : "clicked Continue (" + (btn ? "button" : "form submit") + ")"));
      }
      navigated = await waitFor(() => !/\/tickets\/?$/.test(location.pathname), humanTookOver ? 120000 : NAV_WAIT_MS);
    }
    window.removeEventListener("pagehide", onHide);
    if (navigated) {
      GM_setValue(grabbedKey, Date.now());
      GM_deleteValue(lockKey);
      ui.state("Ticket in cart. GO FINISH CHECKOUT NOW.", "ok");
      ui.big();
      beep(12);
      notify(ev.name + ": ticket in cart. Finish checkout now!");
      flashTitle("🎫 GO! " + ev.name);
      log("grab", "checkout page: " + location.pathname);
      runCheckoutPage(ev, ui);
      return;
    }

    if (humanTookOver) {
      GM_deleteValue(lockKey);
      ui.state("Waiting for you to finish on this page. The script won't click anything here.", "warn");
      return;
    }
    const err = visibleErrorText();
    if (err && UNAVAILABLE_RE.test(err)) {
      GM_deleteValue(lockKey);
      ui.state("Humanitix says: " + err.slice(0, 140), "bad");
      beep(3);
      return;
    }
    if (err) {
      log("grab", "error shown: " + err.slice(0, 200));
      closeModals();
    }
    ui.state("Continue did not go through (attempt " + attempt + "). Retrying.", "warn");
    await sleep(300);
  }

  GM_deleteValue(lockKey);
  ui.state("Could not reach checkout after " + GRAB_ATTEMPTS + " tries. Reloading.", "warn");
  safeReload(slug, "grab failed");
}

async function setQuantityOne(card, input) {
  const inc = card.querySelector(SEL.increment);
  const pickerValue = () => {
    const v = card.querySelector(SEL.pickerValue);
    return v ? v.textContent.trim() : "";
  };
  const isOne = () => Number(input.value) === 1 || pickerValue() === "1";
  for (let i = 0; i < 15 && !isOne() && !humanTookOver; i++) {
    if (Number(input.value) > 1) { setNativeValue(input, "1"); break; }
    if (inc) inc.click(); else setNativeValue(input, "1");
    await sleep(60);
  }
  if (humanTookOver) return;
  if (!isOne()) { setNativeValue(input, "1"); await sleep(60); }
  if (Number(input.value) > 1) setNativeValue(input, "1"); // never more than one
}

function enabledCheckoutButton() {
  const all = Array.from(document.querySelectorAll(SEL.checkoutBtn));
  const enabled = all.filter((b) => b.getAttribute("aria-disabled") !== "true" && !b.disabled);
  return enabled.find((b) => b.offsetParent !== null) || enabled[0] || null;
}

// ─────────────────────────── Checkout page ───────────────────────────
//
// Humanitix checkout is one page with steps: Buyer information → Ticket info → Payment.
// The script fills every field it has an answer for (text, dropdown, checkbox, radio), shows
// which required fields still need you, and, when a step is complete, clicks "Continue to
// Ticket info" / "Continue to payment". It never clicks a pay/order button.

let checkoutRunning = false;
function runCheckoutPage(ev, ui) {
  if (checkoutRunning) return;
  checkoutRunning = true;
  if (!ui) {
    ui = makePanel(ev ? ev.name : "Humanitix checkout");
    ui.state("Checkout page. Complete Turnstile and payment yourself.", "ok");
    ui.big();
    beep(3);
  }
  ui.hideChecklist();
  ui.addButton("Copy fields", copyFieldDump);
  ui.info("Humanitix holds the ticket until its timer (top-right) runs out.");
  // Order already complete? Record it at once so another tab never grabs a second ticket.
  const firstText = ((document.body && document.body.innerText) || "").slice(0, 30000);
  if (ev && DONE_RE.test(firstText)) {
    GM_setValue("done:" + ev.slug, Date.now());
    ui.state("Ticket bought. Nothing more to do. (The script will not grab another for this event.)", "ok");
    return;
  }
  // However this page was reached (script or you), remember it so the tickets page never grabs a second one by itself.
  if (ev) { try { if (!GM_getValue("grabbed:" + ev.slug, 0)) GM_setValue("grabbed:" + ev.slug, Date.now()); } catch (e) {} }

  const until = Date.now() + PREFILL_FOR_MINUTES * 60000;
  let total = 0, advanceClicks = 0, lastAdvance = 0, lastAdvanceText = "", busy = false, lastNeeds = "", methodPicked = false, botFail = false;
  const iv = setInterval(async () => {
    if (Date.now() > until) return clearInterval(iv);
    if (busy) return;
    busy = true;
    try {
      const text = ((document.body && document.body.innerText) || "").slice(0, 30000);
      if (DONE_RE.test(text)) {
        clearInterval(iv);
        if (ev) GM_setValue("done:" + ev.slug, Date.now());
        ui.state("Ticket bought. Nothing more to do. (The script will not grab another for this event.)", "ok");
        flashTitle("✅ " + (ev ? ev.name : "Done"));
        return;
      }
      if (SESSION_EXPIRED_RE.test(text)) {
        clearInterval(iv);
        beep(3);
        if (ev) {
          ui.state("Hold expired. Going back to the tickets page to grab again in 3 s.", "bad");
          GM_deleteValue("grabbed:" + ev.slug);
          GM_setValue("hot:" + ev.slug, Date.now());
          setTimeout(() => { location.href = "/" + ev.slug + "/tickets"; }, 3000);
        } else {
          ui.state("Hold expired. Go back to the tickets page.", "bad");
        }
        return;
      }
      if (BOT_CHECK_FAIL_RE.test(text) || BOT_CHECK_FAIL_RE.test(visibleErrorText())) {
        if (!botFail) { botFail = true; beep(3); ui.state("Humanitix's bot check failed. Click 'try again' on the page yourself; the script waits.", "bad"); }
        return;   // no clicking while the check is failing
      } else if (botFail) {
        botFail = false;
        lastAdvance = 0; lastAdvanceText = "";
        ui.state("Bot check cleared. Carrying on.", "ok");
      }
      const n = await fillKnownFields();
      if (n) { total += n; ui.info("Filled " + total + " field(s) so far. Check them before paying."); }

      const all = requiredEmptyFields();
      const needs = all.filter((f) => !SKIP_FIELD_RE.test(f.label));
      const onPayment = all.some((f) => /card/i.test(f.label));
      const needsText = needs.map((f) => displayLabel(f.el)).join(", ") + (onPayment ? "|pay" : "");
      if (needsText !== lastNeeds) {
        lastNeeds = needsText;
        if (needs.length) ui.state("Needs you: " + needs.map((f) => displayLabel(f.el)).join(", "), "warn");
        else if (onPayment) ui.state("Everything filled. Enter your card and pay.", "ok");
        else ui.state(advanceClicks ? "Step complete. Moving on." : "Checkout page. Complete Turnstile and payment yourself.", "ok");
      }

      if (PAYMENT_METHOD && !methodPicked && !needs.length && !stepButton()) {
        const opt = paymentMethodOption();
        if (opt) {
          methodPicked = true;
          log("checkout", "selecting payment method: " + optionText(opt));
          opt.click();
          ui.info("Selected '" + optionText(opt) + "'. Enter your card details and pay.");
        }
      }

      if (AUTO_ADVANCE && !needs.length && advanceClicks < 4) {
        const btn = stepButton();
        if (btn) {
          const text = btn.textContent.trim();
          const since = Date.now() - lastAdvance;
          // A different step's button may be clicked after 1 s; the same button only after 8 s (retry).
          const allowed = text !== lastAdvanceText ? since > 1000 : since > 8000;
          if (allowed) {
            lastAdvance = Date.now();
            lastAdvanceText = text;
            advanceClicks++;
            log("checkout", "clicking step button: " + text);
            btn.click();
            ui.info("Clicked '" + text + "'.");
          }
        }
      }
    } catch (e) {
      log("checkout loop error", e);
    } finally {
      busy = false;
    }
  }, 500);
}

const STEP_BUTTON_RE = /^\s*continue to (ticket info|payment)\s*$/i;
const NEVER_CLICK_RE = /pay|order|purchase|confirm|place|submit|book/i;
function stepButton() {
  return Array.from(document.querySelectorAll("button")).find((b) => {
    const t = (b.textContent || "").trim();
    return STEP_BUTTON_RE.test(t) && !NEVER_CLICK_RE.test(t.replace(/continue to payment/i, "")) && isVisible(b)
      && b.getAttribute("aria-disabled") !== "true" && !b.disabled && !b.closest("#humanitix-sniper-panel");
  }) || null;
}

// The payment-method chooser: a visible option whose text names the card method and nothing else.
const PAY_ACTION_RE = /pay now|pay \$|pay [0-9]|place order|confirm|purchase|complete order|checkout/i;
const PAY_CANDIDATE_SEL = 'button, [role="radio"], [role="tab"], [role="option"], [role="button"], label, input[type="radio"], '
  + '[class*="ayment"], [class*="ateway"], [class*="ethod"], [data-testid*="ayment"], [data-testid*="ateway"], [data-testid*="method"], [data-testid*="card"]';
function optionText(el) {
  const t = (el.tagName === "INPUT" ? labelFor(el) : el.textContent || "").replace(/\s+/g, " ").trim();
  return t.replace(/\(required\)/i, "").trim();
}
function paymentMethodOption() {
  // Humanitix (seen live 19 Oct 2026): <summary data-testid="payment-option-credit-card">Credit Card</summary>
  // inside an accordion; the "Pay Order" button is data-testid="braintree-card-submit" and is never touched.
  const direct = document.querySelector('[data-testid="payment-option-credit-card"], [data-testid^="payment-option-"][data-testid*="card"]');
  if (direct && isVisible(direct) && !direct.closest("#humanitix-sniper-panel")) {
    const details = direct.closest("details");
    if (details && details.open) return null;         // already open
    return direct;
  }
  const cands = Array.from(document.querySelectorAll(PAY_CANDIDATE_SEL))
    .filter((el) => !el.closest("#humanitix-sniper-panel") && (isVisible(el) || (el.tagName === "INPUT" && isVisible(el.closest("label") || el))));
  const hits = cands.filter((el) => {
    const t = optionText(el);
    if (!t || t.length > 40 || !PAYMENT_METHOD.test(t) || PAY_ACTION_RE.test(t) || /gift|voucher|save card/i.test(t)) return false;
    if (el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" || el.checked) return false;
    const inner = el.querySelector && el.querySelector('input[type="radio"]');
    if (inner && inner.checked) return false;
    return true;
  });
  hits.sort((a, b) => optionText(a).length - optionText(b).length);
  return hits[0] || null;
}

// Answers: [label pattern, value]. Strings fill text/dropdown/radio; true ticks a checkbox.
function answerRules() {
  const b = BUYER;
  return [
    ...ANSWERS,                                     // your explicit answers win
    [/first ?name|given/i, b.firstName],
    [/last ?name|surname|family/i, b.lastName],
    [/e-?mail/i, b.email],                          // also fills "Confirm Email"
    [/mobile|phone|\btel\b/i, b.mobile],
    [/bandai|tcg\s*\+|tcg ?plus|member(ship)? ?(no|number|id)|player ?(id|number)/i, b.bandaiNumber],
    [/discord/i, b.discordId],
    [/\bcountry\b/i, b.country],
    [/street|address line|^address$/i, b.streetAddress],
    [/suburb|\bcity\b|\btown\b/i, b.suburb],
    [/post ?code|postal code|\bzip\b/i, b.postcode],
    [/\bstate\b|state\/territory|\bprovince\b/i, b.state],
    [/date of birth|\bdob\b|birth ?date/i, b.dateOfBirth],
  ].filter(([re, v]) => typeof v === "boolean" || (v && String(v).trim()));
}

const SKIP_FIELD_RE = /card|cvc|cvv|expir|promo|discount|access code|search|coupon|gift/i;

// Every form control on the page with its label, kind and state.
function collectFields() {
  const out = [];
  const seen = new Set();
  const push = (f) => { if (!seen.has(f.el)) { seen.add(f.el); out.push(f); } };
  // Custom dropdowns
  for (const box of document.querySelectorAll('[role="combobox"]')) {
    if (box.closest("#humanitix-sniper-panel")) continue;
    const label = labelFor(box);
    push({ el: box, kind: "combobox", label, required: isRequired(box, label), visible: isVisible(box),
           filled: box.getAttribute("data-none-selected") !== "true" && !/^select an option$/i.test(fieldContentText(box)) });
  }
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (el.closest("#humanitix-sniper-panel") || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    const label = labelFor(el);
    const kind = el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : (el.type || "text").toLowerCase();
    let filled;
    if (kind === "checkbox") filled = el.checked;
    else if (kind === "radio") filled = !!document.querySelector('input[type="radio"][name="' + CSS.escape(el.name || "") + '"]:checked');
    else filled = !!(el.value && String(el.value).trim());
    let visible = isVisible(el);
    if (!visible && (kind === "checkbox" || kind === "radio")) {
      const proxy = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest("label, .Checkbox, .Radio, fieldset");
      visible = !!proxy && isVisible(proxy);
    }
    push({ el, kind, label, required: isRequired(el, label), visible, filled });
  }
  return out;
}

function requiredEmptyFields() {
  const groups = new Set();
  return collectFields().filter((f) => {
    if (!f.required || f.filled || !f.visible) return false;
    if (f.kind === "radio") { const n = f.el.name || f.label; if (groups.has(n)) return false; groups.add(n); }
    return true;
  });
}

async function fillKnownFields() {
  const rules = answerRules();
  let filled = 0;
  for (const f of collectFields()) {
    const el = f.el;
    if (el.dataset.sniperFilled || (f.filled && f.kind !== "checkbox")) continue;
    if (f.kind === "radio" && el.name && document.querySelector('input[type="radio"][name="' + CSS.escape(el.name) + '"]:checked')) continue;
    if (SKIP_FIELD_RE.test(f.label)) continue;
    const desc = f.label;
    const matching = rules.filter(([re]) => re.test(desc) && !(re.source.startsWith("last") && /first/i.test(desc)));
    let ok = false;
    for (const [, value] of matching) {
      try {
        if (f.kind === "checkbox") {
          if (typeof value !== "boolean") continue;
          if (el.checked !== value) el.click();
          ok = el.checked === value;
        }
        else if (typeof value === "boolean") { /* boolean answer for a non-checkbox: not applicable */ }
        else if (f.kind === "combobox") ok = await chooseCombobox(el, String(value));
        else if (f.kind === "select") ok = chooseNativeSelect(el, String(value));
        else if (f.kind === "radio") ok = chooseRadio(el, String(value));
        else if (f.kind === "date") { setNativeValue(el, toIsoDate(String(value))); ok = !!el.value; }
        else { setNativeValue(el, String(value)); ok = true; }
      } catch (e) { log("fill error", f.label, e); }
      if (ok) break;
    }
    if (ok) { el.dataset.sniperFilled = "1"; filled++; log("filled", f.kind, displayLabel(el).slice(0, 60)); }
  }
  return filled;
}

function fieldContentText(box) {
  const c = box.querySelector('[data-testid="field-content"]');
  return (c ? c.textContent : box.textContent || "").trim();
}
async function chooseCombobox(box, value) {
  const want = value.toLowerCase();
  const listId = box.getAttribute("aria-controls");
  const list = (listId && document.getElementById(listId)) || box.querySelector('[role="listbox"]');
  if (!list) return false;
  const options = () => Array.from(list.querySelectorAll('[role="option"]'));
  const pick = () => options().find((o) => o.textContent.trim().toLowerCase() === want)
               || options().find((o) => o.textContent.trim().toLowerCase().includes(want) && !/^select an option$/i.test(o.textContent.trim()));
  if (!pick()) return false;
  box.click();
  await sleep(120);
  const opt = pick();
  if (!opt) return false;
  opt.click();
  await sleep(120);
  if (fieldContentText(box).toLowerCase().includes(want)) return true;
  // Some builds listen to pointer events rather than click.
  for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) opt.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  await sleep(120);
  return fieldContentText(box).toLowerCase().includes(want);
}
function chooseNativeSelect(sel, value) {
  const want = value.toLowerCase();
  const opt = Array.from(sel.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
           || Array.from(sel.options).find((o) => o.text.trim().toLowerCase().includes(want));
  if (!opt) return false;
  sel.value = opt.value;
  sel.dispatchEvent(new Event("input", { bubbles: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return sel.value === opt.value;
}
function chooseRadio(radio, value) {
  const want = value.toLowerCase();
  const group = radio.name ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(radio.name) + '"]')) : [radio];
  const hit = group.find((r) => labelFor(r).toLowerCase().includes(want));
  if (!hit) return false;
  hit.click();
  return hit.checked;
}
function toIsoDate(s) {
  const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s.trim());
  return m ? m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0") : s;
}

function labelFor(el) {
  let t = "";
  const id = el.id;
  if (id) {
    const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    if (l) t += " " + l.textContent;
  }
  const wrap = el.closest("label");
  if (wrap) t += " " + wrap.textContent;
  const ids = (el.getAttribute("aria-labelledby") || "") + " " + (el.getAttribute("aria-describedby") || "");
  ids.split(/\s+/).filter(Boolean).forEach((i) => { const e = document.getElementById(i); if (e) t += " " + e.textContent; });
  const container = el.closest(".InputText, .Select, .Checkbox, .Radio, [class*='Input']");
  if (container && !t.trim()) { const l = container.querySelector(".InputLabel, label"); if (l) t += " " + l.textContent; }
  const fs = el.closest("fieldset, [role='group'], [role='radiogroup']");
  if (fs) {
    const lg = fs.querySelector("legend") || (fs.getAttribute("aria-labelledby") && document.getElementById(fs.getAttribute("aria-labelledby")));
    if (lg) t += " " + lg.textContent;
    if (fs.getAttribute("aria-required") === "true") t += " (required)";
  }
  t += " " + [el.getAttribute("aria-label"), el.placeholder, el.name, el.getAttribute("data-testid")].filter(Boolean).join(" ");
  return t.replace(/\s+/g, " ").trim();
}
function displayLabel(el) {
  let l = null;
  if (el.id) l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
  if (!l) { const c = el.closest(".InputText, .Select, .Checkbox, .Radio"); if (c) l = c.querySelector(".InputLabel, label"); }
  const fs = el.closest("fieldset");
  let t = (fs && fs.querySelector("legend") ? fs.querySelector("legend").textContent + " " : "") + (l ? l.textContent : "");
  if (!t.trim()) t = el.getAttribute("aria-label") || el.placeholder || el.name || el.id || "(unlabelled)";
  return t.replace(/\(required\)/gi, "").replace(/\s+/g, " ").trim();
}
function isRequired(el, label) {
  return el.required === true || el.getAttribute("aria-required") === "true" || /\(required\)|\*\s*$/i.test(label || "");
}
function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function copyFieldDump() {
  const lines = collectFields().map((f) => {
    let extra = "";
    if (f.kind === "combobox") {
      const listId = f.el.getAttribute("aria-controls");
      const list = (listId && document.getElementById(listId)) || f.el.querySelector('[role="listbox"]');
      if (list) extra = " options: " + Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim()).filter((x) => !/^select an option$/i.test(x)).join(" | ");
    } else if (f.kind === "select") {
      extra = " options: " + Array.from(f.el.options).map((o) => o.text.trim()).join(" | ");
    }
    return (f.required ? "[required] " : "[optional] ") + f.kind + ": " + displayLabel(f.el) + extra + (f.filled ? "  (filled)" : "");
  });
  const clickables = Array.from(document.querySelectorAll(PAY_CANDIDATE_SEL))
    .filter((el) => !el.closest("#humanitix-sniper-panel") && isVisible(el))
    .map((el) => {
      const t = optionText(el).slice(0, 60);
      const attrs = ["role", "data-testid", "aria-checked", "aria-selected", "type", "name", "id"].map((a) => (el.getAttribute(a) ? a + "=" + el.getAttribute(a) : "")).filter(Boolean).join(" ");
      return "<" + el.tagName.toLowerCase() + "> class=\"" + (el.className && el.className.baseVal === undefined ? String(el.className).slice(0, 50) : "") + "\" " + attrs + " text=\"" + t + "\"";
    });
  const text = lines.join("\n") + "\n\nCLICKABLE ELEMENTS ON THIS STEP\n" + clickables.join("\n");
  console.log("[humanitix-sniper] FIELDS\n" + text);
  try { navigator.clipboard.writeText(text); } catch (e) {}
  alert("Field list copied to clipboard (also in the console):\n\n" + text.slice(0, 1500));
}

// ─────────────────────────── Page helpers ───────────────────────────

function findCards() {
  return Array.from(document.querySelectorAll(SEL.ticketCard));
}
function ticketName(card) {
  const h = card.querySelector(SEL.ticketName);
  return h ? h.textContent.replace(/\s+/g, " ").replace(/\bticket\b\s*$/i, "").trim() : "(unnamed)";
}
function pickCard(ev, cards) {
  if (ev.match) {
    const m = ev.match.toLowerCase();
    const hit = cards.find((c) => ticketName(c).toLowerCase().includes(m));
    if (hit) return hit;
  }
  return cards[0];
}
function findQty(card) {
  return card ? card.querySelector(SEL.qtyInput) : null;
}
function isHoldPage() {
  if (document.querySelector(SEL.ticketCard) || document.querySelector(SEL.ticketForm)) return false;
  const text = (document.title + " " + (document.body ? document.body.innerText : "")).slice(0, 5000);
  return HOLD_PAGE_RE.test(text) || !!document.getElementById("cf-waiting-room") || !!document.querySelector('meta[http-equiv="refresh" i]');
}
function readPageSaleDateStr() {
  const el = document.querySelector(SEL.saleState);
  if (el && NOT_ON_SALE_RE.test(el.textContent)) {
    return el.textContent.replace(/.*sales start at\s*/i, "").trim();
  }
  const m = document.documentElement.innerHTML.match(/saleDateStr:"([^"]+)"/);
  return m ? m[1] : "";
}
function visibleErrorText() {
  const boxes = Array.from(document.querySelectorAll(SEL.errorBoxes))
    .filter((b) => !b.closest("#humanitix-sniper-panel") && b.getBoundingClientRect().height > 0);
  const text = boxes.map((b) => b.innerText || "").join(" ").replace(/\s+/g, " ").trim();
  return text || "";
}
function closeModals() {
  const btns = Array.from(document.querySelectorAll('[role="dialog"] button, [class*="Modal"] button'))
    .filter((b) => /close|ok|keep going|dismiss|got it/i.test(b.textContent + " " + (b.getAttribute("aria-label") || "")));
  btns.forEach((b) => { try { b.click(); } catch (e) {} });
}

async function fetchTicketsHtml() {
  const r = await fetch(location.pathname + "?_=" + Date.now(), {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "text/html" },
  });
  return { status: r.status, html: await r.text() };
}

// Decide what freshly fetched tickets HTML says for our event.
function classifyTicketsHtml(html, ev) {
  const hasList = /TicketCard|ticket-form/.test(html);
  if (!hasList && (HOLD_PAGE_RE.test(html) || /cf-waiting-room|__cfwaitingroom/.test(html))) return "queue";
  if (!hasList) return "error";
  let region = html;
  if (ev.match) {
    const idx = html.toLowerCase().indexOf('data-testid="ticket-');
    const cardIdx = html.toLowerCase().indexOf(ev.match.toLowerCase(), idx >= 0 ? idx : 0);
    if (cardIdx >= 0) {
      const end = html.indexOf("</li>", cardIdx);
      region = html.slice(cardIdx, end > 0 ? end : cardIdx + 20000);
    }
  }
  if (region.includes(ON_SALE_HTML_MARKER)) return "onsale";
  if (NOT_ON_SALE_RE.test(region) || /ticketNotOnSale/.test(region)) return "notyet";
  if (SOLD_OUT_RE.test(region)) return "soldout";
  return "unknown";
}

function safeReload(slug, why) {
  const last = GM_getValue("lastReload:" + slug, 0);
  const wait = Math.max(0, MIN_RELOAD_GAP_MS - (Date.now() - last));
  log("reload", why, "in", wait, "ms");
  setTimeout(() => {
    GM_setValue("lastReload:" + slug, Date.now());
    location.reload();
  }, wait);
}

// ─────────────────────────── Tabs ───────────────────────────

function tabIdentity() {
  try {
    const raw = sessionStorage.getItem("humanitix-sniper-tab");
    if (raw) return JSON.parse(raw);
    const t = { id: Math.random().toString(36).slice(2), born: Date.now() };
    sessionStorage.setItem("humanitix-sniper-tab", JSON.stringify(t));
    return t;
  } catch (e) {
    return { id: Math.random().toString(36).slice(2), born: Date.now() };
  }
}

// The oldest tab for an event is the grabber; later tabs stand down.
function watchDuplicates(slug, tab, onChange) {
  let dup = false;
  try {
    const bc = new BroadcastChannel("humanitix-sniper");
    const others = new Map();
    bc.onmessage = (e) => {
      const m = e.data;
      if (!m || m.slug !== slug || m.id === tab.id) return;
      others.set(m.id, { born: m.born, seen: Date.now() });
    };
    const announce = () => {
      bc.postMessage({ slug, id: tab.id, born: tab.born });
      for (const [id, o] of others) if (Date.now() - o.seen > 7000) others.delete(id);
      const older = Array.from(others.entries()).some(([id, o]) => o.born < tab.born || (o.born === tab.born && id < tab.id));
      if (older !== dup) { dup = older; onChange(dup); }
    };
    announce();
    setInterval(announce, 2000);
  } catch (e) {
    log("duplicate watch unavailable", e);
  }
  onChange(dup);
  return () => dup;
}

// ─────────────────────────── Time helpers ───────────────────────────

async function serverClockOffset() {
  try {
    const t0 = Date.now();
    const r = await fetch("/robots.txt?_=" + t0, { method: "HEAD", cache: "no-store" });
    const t1 = Date.now();
    const d = r.headers.get("date");
    if (!d) return { raw: 0, applied: 0 };
    const raw = new Date(d).getTime() - (t0 + t1) / 2;
    if (Number.isNaN(raw)) return { raw: 0, applied: 0, unknown: true };
    // The Date header has 1 s resolution; only correct clocks that are clearly wrong.
    return { raw, applied: Math.abs(raw) > 2000 ? raw : 0 };
  } catch (e) {
    return { raw: 0, applied: 0, unknown: true };
  }
}

const TZ_HOURS = { AEDT: 11, AEST: 10, ACDT: 10.5, ACST: 9.5, AWST: 8, NZDT: 13, NZST: 12, UTC: 0, GMT: 0 };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "Sun 25th Oct 2026, 12:00 pm AEDT" → epoch ms. NaN if it cannot be read.
function parseHumanitixDate(str) {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?:\s+([A-Z]{3,5}))?/i.exec(str || "");
  if (!m) return NaN;
  const day = +m[1], mon = MONTHS[m[2].toLowerCase()], year = +m[3];
  let h = +m[4];
  const min = +m[5];
  const ap = (m[6] || "").toLowerCase().replace(/\./g, "");
  const tz = (m[7] || "").toUpperCase();
  if (mon === undefined || day < 1 || day > 31 || h > 23 || min > 59) return NaN;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const naive = Date.UTC(year, mon, day, h, min);
  let off = TZ_HOURS[tz];
  if (off === undefined) off = melbourneOffsetHours(naive);
  return naive - off * 3600000;
}
function melbourneOffsetHours(aroundUtcMs) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Australia/Melbourne", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(aroundUtcMs));
    const g = (t) => +parts.find((p) => p.type === t).value;
    const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"));
    return Math.round(((local - aroundUtcMs) / 3600000) * 2) / 2;
  } catch (e) {
    return 10;
  }
}
function fmtMelbourne(ms) {
  try {
    return new Date(ms).toLocaleString("en-AU", {
      timeZone: "Australia/Melbourne", weekday: "short", day: "numeric", month: "short",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
    });
  } catch (e) {
    return new Date(ms).toISOString();
  }
}

// ─────────────────────────── DOM utilities ───────────────────────────

function setNativeValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (desc && desc.set) desc.set.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function labelTextFor(input) {
  let t = "";
  if (input.id) {
    const l = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
    if (l) t += " " + l.textContent;
  }
  const wrap = input.closest("label");
  if (wrap) t += " " + wrap.textContent;
  const ids = (input.getAttribute("aria-describedby") || "") + " " + (input.getAttribute("aria-labelledby") || "");
  ids.split(/\s+/).filter(Boolean).forEach((id) => { const e = document.getElementById(id); if (e) t += " " + e.textContent; });
  return t;
}
function waitFor(fn, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      let v = null;
      try { v = fn(); } catch (e) {}
      if (v || Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(v || null);
      }
    }, 25);
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(...a) {
  console.log("[humanitix-sniper " + new Date().toISOString().slice(11, 23) + "]", ...a);
}

// ─────────────────────────── Alerts ───────────────────────────

// A real click by you on the quantity "+" or Continue means you've taken over; the script then never double-clicks.
let humanTookOver = false;
document.addEventListener("click", (e) => {
  if (!e.isTrusted || !e.target || !e.target.closest) return;
  if (e.target.closest(SEL.increment + ", " + SEL.checkoutBtn)) { humanTookOver = true; log("you clicked the page yourself; standing aside"); }
}, true);

let audioCtx = null;
const audioListeners = [];
function onAudioArmed(fn) { audioListeners.push(fn); }
function isAudioArmed() { return !!audioCtx && audioCtx.state === "running"; }
function armAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const p = audioCtx.state === "suspended" ? audioCtx.resume() : Promise.resolve();
    p.then(() => audioListeners.forEach((f) => { try { f(); } catch (e) {} }));
  } catch (e) {}
}
["pointerdown", "keydown", "touchstart"].forEach((evt) => window.addEventListener(evt, armAudio, { capture: true }));

function beep(times) {
  armAudio();
  if (!audioCtx) return;
  let n = 0;
  const iv = setInterval(() => {
    if (n++ >= times) return clearInterval(iv);
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = "square";
      o.frequency.value = n % 2 ? 880 : 1320;
      g.gain.value = 0.4;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.25);
    } catch (e) {}
  }, 400);
}
function notify(text) {
  try {
    GM_notification({ title: "Humanitix", text, timeout: 15000, onclick: () => window.focus() });
  } catch (e) {}
}
function flashTitle(text) {
  const orig = document.title;
  let on = false;
  setInterval(() => {
    on = !on;
    document.title = on ? text : orig;
  }, 700);
}

// ─────────────────────────── Settings form ───────────────────────────

function openSettings() {
  const existing = document.getElementById("humanitix-sniper-settings");
  if (existing) existing.remove();
  const wrap = document.createElement("div");
  wrap.id = "humanitix-sniper-settings";
  wrap.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;color:#111;padding:18px 20px;border-radius:12px;width:min(520px,94vw);max-height:90vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.4)";
  const h = document.createElement("div");
  h.style.cssText = "font-size:18px;font-weight:700;margin-bottom:4px";
  h.textContent = "Your details";
  const p = document.createElement("div");
  p.style.cssText = "font-size:12px;color:#555;margin-bottom:12px";
  p.textContent = "Saved only in your own Tampermonkey on this computer. Used to fill the Humanitix checkout. Never put card details here.";
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:8px 12px";
  const inputs = {};
  let saved = {};
  try { saved = GM_getValue("buyer", {}) || {}; } catch (e) {}
  for (const [key, label] of BUYER_FIELDS) {
    const l = document.createElement("label");
    l.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:12px;font-weight:600";
    const i = document.createElement("input");
    i.type = key === "email" ? "email" : "text";
    i.value = saved[key] !== undefined ? saved[key] : (BUYER_DEFAULTS[key] || "");
    i.style.cssText = "font:14px system-ui;padding:6px 8px;border:1px solid #bbb;border-radius:6px";
    i.autocomplete = "off";
    inputs[key] = i;
    l.append(label, i);
    if (/street|date of birth/i.test(label)) l.style.gridColumn = "1 / -1";
    grid.appendChild(l);
  }
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:14px";
  const mkb = (text, primary, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.style.cssText = "font:14px system-ui;padding:7px 14px;border-radius:8px;border:1px solid #888;cursor:pointer;" + (primary ? "background:#2a2;color:#fff;border-color:#2a2" : "background:#eee;color:#111");
    b.addEventListener("click", fn);
    row.appendChild(b);
  };
  mkb("Cancel", false, () => wrap.remove());
  mkb("Save", true, () => {
    const obj = {};
    for (const [key] of BUYER_FIELDS) obj[key] = inputs[key].value.trim();
    try { GM_setValue("buyer", obj); } catch (e) { alert("Could not save: " + e); return; }
    wrap.remove();
    location.reload();
  });
  box.append(h, p, grid, row);
  wrap.appendChild(box);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
  inputs.firstName.focus();
}

// ─────────────────────────── Panel ───────────────────────────

const PF_ROWS = [
  ["script", "Script"], ["time", "Sale time"], ["clock", "Clock"], ["ticket", "Ticket"],
  ["buyer", "Buyer"], ["sound", "Sound"], ["visible", "Visible"], ["single", "Single tab"],
];

function makePanel(title) {
  const existing = document.getElementById("humanitix-sniper-panel");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.id = "humanitix-sniper-panel";
  box.style.cssText = [
    "position:fixed", "bottom:12px", "left:12px", "z-index:2147483647",    // bottom-left: clear of Humanitix's timer (top right) and Continue button (bottom right)
    "background:#111", "color:#eee", "font:13px/1.4 system-ui,sans-serif",
    "padding:10px 12px", "border-radius:10px", "box-shadow:0 4px 18px rgba(0,0,0,.4)",
    "max-width:360px", "border:2px solid #444",
  ].join(";");
  const h = document.createElement("div");
  h.style.cssText = "font-weight:700;margin-bottom:4px";
  h.textContent = "🎫 " + title;
  const state = document.createElement("div");
  state.style.cssText = "margin:4px 0;font-weight:600";
  const cd = document.createElement("div");
  cd.style.cssText = "font-size:22px;font-variant-numeric:tabular-nums;margin:2px 0";
  const info = document.createElement("div");
  info.style.cssText = "opacity:.85;font-size:12px;white-space:pre-line";
  const list = document.createElement("div");
  list.style.cssText = "margin:6px 0 0;font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:1px 8px";
  const rows = {};
  for (const [key, label] of PF_ROWS) {
    const k = document.createElement("div");
    k.style.cssText = "font-weight:600;white-space:nowrap";
    const v = document.createElement("div");
    v.style.cssText = "opacity:.9";
    k.textContent = "• " + label;
    v.textContent = "…";
    list.append(k, v);
    rows[key] = { k, v, ok: null };
  }
  const row = document.createElement("div");
  row.style.cssText = "margin-top:8px;display:flex;gap:6px";
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "font:12px system-ui;padding:3px 8px;border-radius:6px;border:1px solid #666;background:#222;color:#eee;cursor:pointer";
    b.addEventListener("click", fn);
    row.appendChild(b);
  };
  mk("Settings", openSettings);
  mk("Arm sound & test", () => { armAudio(); beep(2); });
  mk("Reset", () => {
    EVENTS.forEach((e) => ["grabbed:", "grabbing:", "lastReload:", "hot:", "saleAt:", "done:", "fails:"].forEach((k) => GM_deleteValue(k + e.slug)));
    location.reload();
  });
  box.append(h, state, cd, info, list, row);
  (document.body || document.documentElement).appendChild(box);

  const colors = { idle: "#444", warn: "#c90", ok: "#2a2", bad: "#c22" };
  const infoLines = [];
  let tone = "idle";
  let big = false;
  const paint = () => {
    const anyBad = Object.values(rows).some((r) => r.ok === false);
    box.style.borderColor = anyBad && tone !== "ok" ? colors.bad : (colors[tone] || "#444");
  };
  return {
    state(text, t) { state.textContent = text; tone = t || "idle"; paint(); },
    countdown(ms) {
      if (Number.isNaN(ms)) { cd.textContent = ""; return; }
      cd.textContent = ms <= 0 ? "T+" + fmt(-ms) : "T−" + fmt(ms);
    },
    info(text) { infoLines.push(text); info.textContent = infoLines.slice(-4).join("\n"); },
    pf(key, ok, text) {
      const r = rows[key];
      if (!r) return;
      r.ok = ok;
      r.k.textContent = (ok === true ? "✓ " : ok === false ? "✗ " : "• ") + PF_ROWS.find(([k]) => k === key)[1];
      r.k.style.color = ok === true ? "#6d6" : ok === false ? "#f66" : "#aaa";
      r.v.textContent = text || "";
      paint();
    },
    hideChecklist() { list.style.display = "none"; },
    addButton(label, fn) { if (!row.querySelector('[data-label="' + label + '"]')) { mk(label, fn); row.lastChild.dataset.label = label; } },
    big() { big = true; box.style.fontSize = "16px"; box.style.background = "#1b3d1b"; state.style.fontSize = "18px"; },
    get isBig() { return big; },
  };
  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ":" : "") + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + "." + String(Math.floor((ms % 1000) / 100));
  }
}

// ─────────────────────────── Entry ───────────────────────────

(function main() {
  "use strict";
  const parts = location.pathname.split("/").filter(Boolean);
  const slug = parts[0] || "";
  const ev = EVENTS.find((e) => e.slug === slug);
  const isTicketsPage = !!ev && parts[1] === "tickets" && parts.length === 2;
  const isEventInfoPage = !!ev && parts.length === 1;
  const looksLikeCheckout = !isEventInfoPage && (/\/checkout\b/i.test(location.pathname) || (!!ev && !isTicketsPage));

  if (isTicketsPage) {
    runTicketsPage(ev).catch((e) => log("fatal", e));
  } else if (looksLikeCheckout) {
    runCheckoutPage(ev);
  }
})();

