// ---------------------------------------------------------------------------
// End-to-end checks for phase 1. Runs the real application code against
// harness.html, which swaps the Firebase SDK for an in-memory stand-in — so
// this needs no Firebase project, no credentials and no network.
//
//   npm install playwright && npx playwright install chromium
//   python3 -m http.server 8123        # from the project root, in another shell
//   node tests/browser/run.mjs
//
// What it CANNOT test: the Firestore security rules, which run on Google's
// servers. See README → "Verifying the permission rules".
// ---------------------------------------------------------------------------
import { chromium } from "playwright";

const PORT = process.env.PORT || 8123;
const BASE = `http://localhost:${PORT}/tests/browser/harness.html`;
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) fails++; };
const group = (t) => console.log("\n" + t);

const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });
const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));

const AGENT_PROFILE = {
  fullName: "CHAN SIEW SIN", nric: "000908-14-0426",
  phone: "019-400 9082", nickname: "Suzanne", version: 1,
};

/** Reset the store, seed it, sign a user in, and wait for the app to settle. */
async function scenario({ docs = {}, user = null, hash = "#/dashboard" }) {
  await page.evaluate(([docs, user, hash]) => {
    window.__stub.reset();
    for (const [path, data] of Object.entries(docs)) {
      const d = { ...data };
      for (const k of ["invitedAt", "firstLoginAt", "lastLoginAt", "uploadedAt", "savedAt"]) {
        if (d[k] === "@now") d[k] = new Date();
      }
      window.__stub.seed(path, d);
    }
    location.hash = hash;
    window.__stub.setUser(user);
  }, [docs, user, hash]);
  await page.waitForTimeout(450);
  return page.locator("#root").innerText();
}

// window.prompt / window.confirm answers, consumed in order.
// A persistent handler with a queue, because two page.once("dialog") handlers
// both fire on the *same* first dialog rather than one each.
const dialogAnswers = [];
const answer = (...values) => dialogAnswers.push(...values);
page.on("dialog", async (d) => {
  if (dialogAnswers.length === 0) { await d.dismiss(); return; }
  const next = dialogAnswers.shift();
  if (next === false || next === null) await d.dismiss();
  else await d.accept(typeof next === "string" ? next : undefined);
});

const google = (email, name = "Test User") =>
  ({ uid: "uid-" + email, email, displayName: name, photoURL: null });

await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

// ---------------------------------------------------------------------------
group("Sign-in screen");
{
  const t = await scenario({ user: null });
  ok(/Sign in with Google/.test(t), "signed-out visitors get the sign-in screen");
  ok(/does not request access to your Google Drive/.test(t),
     "states that no Drive scope is requested (brief §4.2)");
  ok(/Test Realty Sdn\. Bhd\./i.test(t), "company name comes from config.js");
}

// ---------------------------------------------------------------------------
group("The allowlist gate (brief §4.1, acceptance criterion #1)");
{
  const t = await scenario({ docs: {}, user: google("stranger@gmail.com") });
  ok(/not on the approved list/i.test(t), "an address that is not on the list is refused");
  ok(/stranger@gmail\.com/.test(t), "the refusal shows the exact address Google returned");
  ok(!/Dashboard/.test(t), "a refused user gets no dashboard, empty or otherwise");
  ok(await page.evaluate(() => window.__stub.dump()["users/stranger@gmail.com"] === undefined),
     "a refused sign-in creates no user record");
}
{
  const t = await scenario({
    docs: { "users/off@gmail.com": { email: "off@gmail.com", role: "agent", active: false } },
    user: google("off@gmail.com"),
  });
  ok(/switched off/i.test(t), "a deactivated account is told its access was switched off");
  ok(!/Dashboard/.test(t), "a deactivated account reaches no screen");
}
{
  const t = await scenario({
    docs: { "users/typo@gmail.com": { email: "typo@gmail.com", role: "Admin", active: true } },
    user: google("typo@gmail.com"),
  });
  ok(/role is not set correctly/i.test(t), "a mistyped role is caught rather than silently defaulted");
  ok(/"Admin"/.test(t), "the message quotes the bad value so it can be fixed");
}
{
  const t = await scenario({
    docs: { "users/MiXeD@Gmail.com": { email: "mixed@gmail.com", role: "agent", active: true, profile: AGENT_PROFILE } },
    user: google("MiXeD@Gmail.com"),
  });
  ok(/not on the approved list/i.test(t),
     "a record whose ID is not lowercased does not match — as the security rules require");
}
{
  const t = await scenario({
    docs: { "users/mixed@gmail.com": { email: "mixed@gmail.com", role: "agent", active: true, profile: AGENT_PROFILE } },
    user: google("MiXeD@Gmail.com"),
  });
  ok(/My dashboard/.test(t), "…and a lowercased record matches an address Google returns in mixed case");
}

{
  // Unpublished security rules make every read fail. That must be reported as
  // a setup problem, not as "you are not on the approved list".
  await page.evaluate(() => { window.__stub.reset(); window.__stub.setDenyAll(true); });
  await page.evaluate((u) => window.__stub.setUser(u), google("boss@gmail.com"));
  await page.waitForTimeout(400);
  const t = await page.locator("#root").innerText();
  ok(/setup problem/i.test(t), "a database permission error is diagnosed as a setup problem");
  ok(/firestore\.rules/.test(t), "…and names the file and console step that fixes it");
  ok(!/not on the approved list/i.test(t), "…and is not mistaken for an allowlist refusal");
  await page.evaluate(() => window.__stub.setDenyAll(false));
}

// ---------------------------------------------------------------------------
group("Agent profile gate (brief §6, acceptance criterion #2)");
{
  const t = await scenario({
    docs: { "users/new@gmail.com": { email: "new@gmail.com", role: "agent", active: true } },
    user: google("new@gmail.com"),
  });
  ok(/Sales Agent profile is incomplete/.test(t), "an agent with no profile is held on the profile form");
  ok(/Still needed: Full Name, I\/C Number, Phone Number, Nickname/.test(t), "every missing field is named");
  ok(!/Dashboard[\s\S]*Recent activity/.test(t), "they cannot get past it to the dashboard");

  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(250);
  ok(/Sales Agent profile is incomplete/.test(await page.locator("#root").innerText()),
     "…and cannot route around it by editing the URL");
}
{
  const t = await scenario({
    docs: { "users/half@gmail.com": { email: "half@gmail.com", role: "agent", active: true,
             profile: { fullName: "CHAN SIEW SIN", nric: "000908-14-0426" } } },
    user: google("half@gmail.com"),
  });
  ok(/Still needed: Phone Number, Nickname/.test(t), "a half-filled profile names only what is still missing");
}

// ---------------------------------------------------------------------------
group("Saving a profile");
{
  await scenario({
    docs: { "users/new@gmail.com": { email: "new@gmail.com", role: "agent", active: true } },
    user: google("new@gmail.com"),
  });
  const saveBtn = () => page.locator("button", { hasText: "Save profile" });
  ok(await saveBtn().isDisabled(), "Save is disabled until the profile is valid");

  // Real keystrokes, not page.fill: if live validation re-rendered the form it
  // would replace the focused input and the rest of the word would go nowhere.
  await page.focus("#pf-fullName");
  await page.keyboard.type("CHAN SIEW");
  ok((await page.evaluate(() => document.activeElement && document.activeElement.id)) === "pf-fullName",
     "the input keeps focus while typing");
  ok((await page.inputValue("#pf-fullName")) === "CHAN SIEW",
     "every typed character is kept");
  await page.fill("#pf-fullName", "");

  await page.fill("#pf-fullName", "CHAN SIEW SIN");
  await page.fill("#pf-nric", "000908140426");
  await page.fill("#pf-phone", "+60194009082");
  await page.fill("#pf-nickname", "Suzanne");
  await page.waitForTimeout(150);

  const preview = await page.locator(".preview").innerText();
  ok(/000908-14-0426/.test(preview), "the preview shows the canonical NRIC");
  ok(/019-400 9082/.test(preview), "+60194009082 is normalised to 019-400 9082");
  ok(/\(2\) Suzanne \(Sales Agent\) - 019-400 9082/.test(preview),
     "the preview renders the Tenancy Administrator contact line from brief §5.2");
  ok(!(await saveBtn().isDisabled()), "Save enables once all four fields are valid");

  await page.fill("#pf-phone", "03-2345 6789");
  await page.waitForTimeout(150);
  ok(await saveBtn().isDisabled(), "a landline re-disables Save");
  ok(/mobile number/i.test(await page.locator("#root").innerText()), "…and explains why");

  await page.fill("#pf-phone", "019-400 9082");
  await page.waitForTimeout(150);
  await saveBtn().click();
  await page.waitForTimeout(500);

  const st = await page.evaluate(() => window.__stub.dump());
  const rec = st["users/new@gmail.com"];
  ok(rec.profile && rec.profile.fullName === "CHAN SIEW SIN", "the profile is written to the user record");
  ok(rec.profile.nric === "000908-14-0426" && rec.profile.phone === "019-400 9082",
     "values are stored in canonical form, not as typed");
  ok(rec.profileComplete === true, "profileComplete is set");
  ok(rec.role === "agent" && rec.active === true, "saving a profile does not touch role or active");
  ok(!!st["users/new@gmail.com/profileVersions/1"],
     "version 1 is snapshotted (brief §6 — profile edits must never alter an existing PTAA)");

  const t = await page.locator("#root").innerText();
  ok(/My dashboard/.test(t), "the agent lands on their dashboard once the profile is complete");
  ok(/Complete/.test(t), "the dashboard shows the profile as complete");
}

// ---------------------------------------------------------------------------
group("Activity log (brief §14.1)");
{
  const entries = await page.evaluate(() =>
    Object.entries(window.__stub.dump()).filter(([p]) => p.startsWith("activity/")).map(([, v]) => v));
  ok(entries.some(e => e.action === "auth.first_login"), "a first sign-in is logged");
  ok(entries.some(e => e.action === "profile.created"), "completing a profile is logged");
  ok(entries.every(e => e.actorEmail === "new@gmail.com"), "entries record who acted");
  ok(entries.every(e => e.at instanceof Date || (e.at && e.at.toDate)), "entries are timestamped");
}

// ---------------------------------------------------------------------------
group("Admin — users screen");
const ADMIN_DOCS = {
  "users/boss@gmail.com":    { email: "boss@gmail.com", role: "admin", active: true, firstLoginAt: "@now", lastLoginAt: "@now" },
  "users/suzanne@gmail.com": { email: "suzanne@gmail.com", role: "agent", active: true, profile: AGENT_PROFILE, firstLoginAt: "@now", lastLoginAt: "@now" },
  "users/newbie@gmail.com":  { email: "newbie@gmail.com", role: "agent", active: true },
  "users/gone@gmail.com":    { email: "gone@gmail.com", role: "agent", active: false },
};
{
  const t = await scenario({ docs: ADMIN_DOCS, user: google("boss@gmail.com"), hash: "#/users" });
  ok(/Approved accounts \(4\)/.test(t), "all four accounts are listed");
  ok(/suzanne@gmail\.com/.test(t) && /gone@gmail\.com/.test(t), "active and switched-off accounts both appear");
  ok(/Incomplete/.test(t), "an agent with no profile is flagged Incomplete");
  ok(/never/.test(t), "an account that has never signed in is shown as such");

  const selfRow = page.locator("tr", { hasText: "boss@gmail.com" });
  ok(await selfRow.locator("button", { hasText: "Make agent" }).isDisabled(),
     "an admin cannot change their own role");
  ok(await selfRow.locator("button", { hasText: "Switch off" }).isDisabled(),
     "an admin cannot switch off their own access");
}
{
  // Promote, then try to demote the only other admin away — the guard should hold.
  answer(true);
  await page.locator("tr", { hasText: "suzanne@gmail.com" }).locator("button", { hasText: "Make admin" }).click();
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__stub.dump()["users/suzanne@gmail.com"].role)) === "admin",
     "an admin can promote an agent");

  const logged = await page.evaluate(() => Object.entries(window.__stub.dump())
    .filter(([p]) => p.startsWith("activity/")).map(([, v]) => v)
    .some(e => e.action === "user.role_changed"));
  ok(logged, "the role change is written to the activity log");
}
{
  await scenario({
    docs: { "users/boss@gmail.com": { email: "boss@gmail.com", role: "admin", active: true },
            "users/a@gmail.com":    { email: "a@gmail.com", role: "agent", active: true, profile: AGENT_PROFILE } },
    user: google("boss@gmail.com"), hash: "#/users",
  });
  await page.locator("#new-email").fill("added@gmail.com");
  await page.locator("button", { hasText: "Add" }).click();
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => window.__stub.dump()["users/added@gmail.com"]);
  ok(!!added, "an admin can add an address to the approved list");
  ok(added && added.role === "agent" && added.active === true, "…created as an active Sales Agent by default");
  ok(added && added.invitedBy === "boss@gmail.com", "…recording who added them");

  await page.locator("#new-email").fill("NotAnEmail");
  await page.locator("button", { hasText: "Add" }).click();
  await page.waitForTimeout(300);
  ok(/does not look like an email/i.test(await page.locator("body").innerText()),
     "a malformed address is rejected");
}

// ---------------------------------------------------------------------------
group("Admin — dashboard and activity");
{
  const t = await scenario({ docs: ADMIN_DOCS, user: google("boss@gmail.com"), hash: "#/dashboard" });
  ok(/Admin dashboard/.test(t), "an admin gets the admin dashboard");
  ok(/Open requests/.test(t) && /Waiting on me/.test(t),
     "the dashboard is built around what needs the admin, not raw counts");
  await page.waitForTimeout(400);            // the accounts card loads on its own
  const withAccounts = await page.locator("#root").innerText();
  ok(/active account/i.test(withAccounts), "the accounts summary renders");
  ok(/newbie@gmail\.com/.test(withAccounts),
     "an agent with an incomplete profile is named, because they cannot submit a request");
  ok(/Skipped/.test(withAccounts),
     "the AI cross-check is labelled Skipped, not quietly dropped or faked as done");
  ok(!/M ASTRA|LOY HUI TING|PTAA-00\d/.test(withAccounts),
     "no invented PTAA data anywhere on the dashboard");
}
{
  const t = await scenario({ docs: ADMIN_DOCS, user: google("boss@gmail.com"), hash: "#/activity" });
  ok(/Activity log/.test(t), "the activity screen renders");
  ok(/Append-only/.test(t), "it states that it is append-only");
  ok(!/\bDelete\b/.test(t), "it offers no delete action (non-negotiable rule #11)");
}

// ---------------------------------------------------------------------------
group("Route protection");
{
  const t = await scenario({
    docs: { "users/suzanne@gmail.com": { email: "suzanne@gmail.com", role: "agent", active: true, profile: AGENT_PROFILE } },
    user: google("suzanne@gmail.com"), hash: "#/users",
  });
  ok(/Administrators only/.test(t), "an agent typing #/users is refused");
  ok(!/Approved accounts/.test(t), "…and sees no part of the user list");

  await page.evaluate(() => { location.hash = "#/activity"; });
  await page.waitForTimeout(250);
  ok(/Administrators only/.test(await page.locator("#root").innerText()), "an agent typing #/activity is refused");

  await page.evaluate(() => { location.hash = "#/profile-of:boss@gmail.com"; });
  await page.waitForTimeout(300);
  ok(/Only an administrator/.test(await page.locator("#root").innerText()),
     "an agent cannot open another user's profile by URL");

  const nav = await page.locator(".nav").innerText();
  ok(!/Users|Activity/.test(nav), "admin-only items are absent from an agent's navigation");
}

// ---------------------------------------------------------------------------
// Phases 2, 3 and 6 — requests, the queue, and the state machine
// ---------------------------------------------------------------------------

const PROPS = {
  "properties/p1": { name: "M ASTRA", nameLower: "m astra", address: "Jalan Ampang, KL", active: true },
  "properties/p2": { name: "THE ERA", nameLower: "the era", address: "Jalan Ipoh, KL", active: true },
};
const SUZANNE = {
  "users/suzanne@gmail.com": { email: "suzanne@gmail.com", role: "agent", active: true,
                               profile: AGENT_PROFILE, firstLoginAt: "@now" },
};
const BOSS = {
  "users/boss@gmail.com": { email: "boss@gmail.com", role: "admin", active: true, firstLoginAt: "@now" },
};

/**
 * The same admin, with their own profile filled in. Generating a document
 * records who prepared it — their name goes in the second witness block — so an
 * admin with no profile cannot generate. Most screens do not care; the ones
 * that produce documents use this instead.
 */
const BOSS_WITH_PROFILE = {
  "users/boss@gmail.com": {
    email: "boss@gmail.com", role: "admin", active: true, firstLoginAt: "@now",
    profileComplete: true,
    profile: { fullName: "NUR AFIQAH BINTI RAZAK", nric: "950101-10-1234",
               phone: "011-2233 4455", nickname: "Fiqah", version: 1 },
  },
};
const OTHER_AGENT = {
  "users/ali@gmail.com": { email: "ali@gmail.com", role: "agent", active: true,
                           profile: { ...AGENT_PROFILE, fullName: "ALI BIN OSMAN", nickname: "Ali" },
                           firstLoginAt: "@now" },
};

// A 1x1 PNG, enough to drive the resize-and-store pipeline end to end.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function fillNewRequest() {
  await page.fill("#nr-owner-name", "LOY HUI TING");
  await page.fill("#nr-owner-nric", "880214105566");
  await page.fill("#nr-owner-phone", "0123456789");
  await page.fill("#nr-owner-address", "12 Jalan Ampang, 50450 Kuala Lumpur");
  await page.selectOption("#nr-propertyId", { label: "M ASTRA" });
  await page.fill("#nr-unitNo", "a-18-09");
  await page.selectOption("#nr-ptaaType", "Partition");
  await page.fill("#nr-tenancy-initialTermMonths", "36");
  await page.fill("#nr-tenancy-commencementDate", "2026-09-01");
  await page.fill("#nr-financial-monthlyAdminFeePercent", "10");
  await page.waitForTimeout(200);
}

const dump = () => page.evaluate(() => window.__stub.dump());

group("Agent submits a New PTAA Request (phase 2)");
{
  await scenario({ docs: { ...SUZANNE }, user: google("suzanne@gmail.com"), hash: "#/new-request" });
  const t = await page.locator("#root").innerText();
  ok(/no properties on the list/i.test(t), "with no properties, the agent is told why they cannot submit");

  await scenario({ docs: { ...SUZANNE, ...PROPS }, user: google("suzanne@gmail.com"), hash: "#/new-request" });
  const submit = page.locator("button", { hasText: "Submit request" });
  ok(await submit.isDisabled(), "Submit is disabled until the form is valid");

  await fillNewRequest();
  ok(!(await submit.isDisabled()), "Submit enables once every required field is valid");

  const preview = await page.locator(".filename").innerText();
  ok(preview === "PTAA (M ASTRA A-18-09) LOY HUI TING.docx",
     "the generated filename is previewed before submission: " + preview);

  const derived = await page.inputValue("#nr-tenancy-expiryDate");
  ok(derived === "2029-08-31", "expiry is worked out from the 36-month term: " + derived);

  // Three named slots now, not a gallery: each supporting file has a fixed place
  // in the agreement, so the app has to know which photograph is which.
  let slots = await page.locator(".slot").allInnerTexts();
  ok(slots.length === 3, "three supporting-file slots, one per thing the agent attaches");
  ok(slots.some(t => /Owner I\/C — front/.test(t)), "…the I/C front");
  ok(slots.some(t => /Owner I\/C — back/.test(t)), "…the I/C back");
  ok(slots.some(t => /Renovation quotation/.test(t)), "…and the quotation");
  ok(slots.every(t => /Not attached/.test(t)), "all empty to begin with");

  await page.locator(".slot", { hasText: "Owner I/C — front" })
            .locator('input[type="file"]').first()
            .setInputFiles({ name: "ic-front.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.waitForTimeout(500);
  slots = await page.locator(".slot").allInnerTexts();
  ok(slots.filter(t => /Attached/.test(t)).length === 1,
     "attaching to one slot fills that slot and no other");
  ok(/Owner I\/C — front/.test(slots.find(t => /Attached/.test(t)) || ""),
     "…and it is the one that was chosen");

  await submit.click();
  await page.waitForTimeout(900);

  const st = await dump();
  const req = st["requests/PTAA-00001"];
  ok(!!req, "the request is stored under a generated PTAA number");
  ok(req.status === "NEW" && req.currentAction === "PTAA Admin",
     "it starts at NEW with the admin holding the ball");
  ok(req.agentEmail === "suzanne@gmail.com", "it records the signed-in agent as the requester");
  ok(req.owner.nric === "880214-10-5566" && req.owner.phone === "012-345 6789",
     "owner details are stored in canonical form");
  ok(req.unitNo === "A-18-09", "the unit number is upper-cased for the filename");
  ok(req.tenancy.expiryDate === "2029-08-31", "the derived expiry is saved");
  ok(req.agentSnapshot && req.agentSnapshot.fullName === "CHAN SIEW SIN",
     "the agent's details are snapshotted onto the request (brief §6, rule #4)");
  ok(st["counters/requests"] && st["counters/requests"].next === 2, "the PTAA counter advanced");
  const atts = Object.entries(st).filter(([k]) => k.startsWith("requests/PTAA-00001/attachments/"));
  ok(atts.length === 1, "the attached image was saved with the request");
  ok(atts[0][1].kind === "ic_front",
     "…against the slot it was attached to, so it can be placed in the document: " + atts[0][1].kind);
  ok(/PTAA-00001/.test(await page.locator("#root").innerText()),
     "the agent lands on the new request");
}

group("A second request gets the next number");
{
  await page.evaluate(() => { location.hash = "#/new-request"; });
  await page.waitForTimeout(500);
  await fillNewRequest();
  await page.locator("button", { hasText: "Submit request" }).click();
  await page.waitForTimeout(800);
  const st = await dump();
  ok(!!st["requests/PTAA-00002"], "the second request is PTAA-00002, not a duplicate");
  ok(st["counters/requests"].next === 3, "the counter advanced again");
}

group("Agent isolation (brief §3, acceptance criterion #9)");
{
  await scenario({
    docs: {
      ...SUZANNE, ...OTHER_AGENT, ...PROPS,
      "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "NEW",
        currentAction: "PTAA Admin", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "LOY HUI TING" }, propertyName: "M ASTRA", unitNo: "A-18-09",
        ptaaType: "Partition", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
      "requests/PTAA-00002": { ptaaId: "PTAA-00002", type: "NEW_PTAA", status: "NEW",
        currentAction: "PTAA Admin", agentEmail: "ali@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "SITI BINTI OMAR" }, propertyName: "THE ERA", unitNo: "B-07-11",
        ptaaType: "WUR", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
    },
    user: google("suzanne@gmail.com"), hash: "#/requests",
  });
  const t = await page.locator("#root").innerText();
  ok(/PTAA-00001/.test(t), "an agent sees their own request");
  ok(!/PTAA-00002/.test(t), "an agent does not see another agent's request");
  ok(!/SITI BINTI OMAR/.test(t), "…nor the other owner's name");
}

group("Admin queue and dashboard (phase 3)");
{
  const t = await scenario({
    docs: {
      ...BOSS, ...SUZANNE, ...OTHER_AGENT, ...PROPS,
      "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "NEW",
        currentAction: "PTAA Admin", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "LOY HUI TING" }, propertyName: "M ASTRA", unitNo: "A-18-09",
        ptaaType: "Partition", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
      "requests/PTAA-00002": { ptaaId: "PTAA-00002", type: "NEW_PTAA", status: "READY_FOR_AGENT",
        currentAction: "Sales Agent", agentEmail: "ali@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "SITI BINTI OMAR" }, propertyName: "THE ERA", unitNo: "B-07-11",
        ptaaType: "WUR", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
    },
    user: google("boss@gmail.com"), hash: "#/dashboard",
  });
  ok(/Waiting on me/.test(t), "the dashboard leads with what needs the admin");
  ok(/New requests/.test(t) && /PTAA-00001/.test(t), "the new request is surfaced under Needs my attention");
  ok(/Waiting on someone else/.test(t) && /PTAA-00002/.test(t),
     "requests waiting on other people are separated out");

  const q = await scenario({
    docs: {
      ...BOSS, ...SUZANNE, ...OTHER_AGENT, ...PROPS,
      "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "NEW",
        currentAction: "PTAA Admin", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "LOY HUI TING" }, propertyName: "M ASTRA", unitNo: "A-18-09",
        ptaaType: "Partition", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
      "requests/PTAA-00002": { ptaaId: "PTAA-00002", type: "NEW_PTAA", status: "READY_FOR_AGENT",
        currentAction: "Sales Agent", agentEmail: "ali@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "SITI BINTI OMAR" }, propertyName: "THE ERA", unitNo: "B-07-11",
        ptaaType: "WUR", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
    },
    user: google("boss@gmail.com"), hash: "#/requests",
  });
  ok(/PTAA-00001/.test(q) && /PTAA-00002/.test(q), "an admin sees every agent's requests");

  await page.fill("#q", "SITI");
  await page.waitForTimeout(250);
  const filtered = await page.locator("#root").innerText();
  ok(/PTAA-00002/.test(filtered) && !/LOY HUI TING/.test(filtered), "searching by owner name filters the queue");
  await page.fill("#q", "");
  await page.waitForTimeout(200);
}

group("The state machine (phase 6, brief §7.2)");
{
  const seed = (status, currentAction) => ({
    ...BOSS, ...SUZANNE, ...PROPS,
    "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status, currentAction,
      agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
      owner: { name: "LOY HUI TING", nric: "880214-10-5566" }, propertyName: "M ASTRA",
      unitNo: "A-18-09", ptaaType: "Partition",
      tenancy: { initialTermMonths: 36, commencementDate: "2026-09-01", expiryDate: "2029-08-31" },
      financial: { monthlyAdminFeePercent: 10 }, specialTerms: [], updatedAt: "@now" },
  });

  await scenario({ docs: seed("NEW", "PTAA Admin"), user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  const detail = await page.locator("#root").innerText();
  ok(/PTAA \(M ASTRA A-18-09\) LOY HUI TING\.docx/.test(detail),
     "the request detail shows the filename that will be generated");
  ok(/profile version/i.test(detail), "…and which profile version the agent details came from");

  await page.locator("button", { hasText: "Start review" }).click();
  await page.waitForTimeout(500);
  let r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "UNDER_REVIEW", "admin can start the review");

  await page.locator("button", { hasText: "Mark PTAA OK" }).click();
  await page.waitForTimeout(500);
  r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "PTAA_OK", "admin can mark PTAA OK");
  ok(r.currentAction === "PTAA Admin",
     "PTAA OK is a resting state — it stays with the admin, not the agent (brief §7.3)");

  let txt = await page.locator("#root").innerText();
  ok(!/\bComplete\b/.test(txt) || !/Mark completed/i.test(txt),
     "there is no way to mark it Completed from PTAA OK");

  await page.locator("button", { hasText: "Release to agent" }).click();
  await page.waitForTimeout(500);
  r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "READY_FOR_AGENT", "releasing is a separate, deliberate step");
  ok(r.currentAction === "Sales Agent", "and it hands the ball to the agent");
}

group("Nothing can be marked Completed yet (rule #6)");
{
  for (const status of ["FINAL_CHECK", "READY_FOR_AGENT", "PTAA_OK"]) {
    await scenario({
      docs: {
        ...BOSS, ...SUZANNE, ...PROPS,
        "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status, currentAction: "PTAA Admin",
          agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE, owner: { name: "LOY HUI TING" },
          propertyName: "M ASTRA", unitNo: "A-18-09", ptaaType: "Partition",
          tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
      },
      user: google("boss@gmail.com"), hash: "#/request:PTAA-00001",
    });
    const buttons = await page.locator(".card button").allInnerTexts();
    const completeBtn = buttons.filter(b => /complete and file/i.test(b));
    if (status === "FINAL_CHECK") {
      // Phase 11 exists now, so the action is offered here — but only here, and
      // only as the upload-first transaction, never as a plain status button.
      ok(completeBtn.length === 1, "the Complete action appears at Final check");
      const t = await page.locator("#root").innerText();
      ok(/Not ready to complete/.test(t),
         "…and with an empty checklist it says exactly what is missing");
    } else {
      ok(completeBtn.length === 0, `no Complete action is offered at ${status}`);
    }
    ok(!buttons.some(b => /^complete$/i.test(b.trim())),
       `Complete is never a bare status button at ${status}`);
  }
}

group("Hold remembers where it came from (brief §7.3)");
{
  await scenario({
    docs: {
      ...BOSS, ...SUZANNE, ...PROPS,
      "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "UNDER_REVIEW",
        currentAction: "PTAA Admin", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
        owner: { name: "LOY HUI TING" }, propertyName: "M ASTRA", unitNo: "A-18-09",
        ptaaType: "Partition", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
    },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001",
  });

  answer("Waiting for Owner");
  await page.locator("button", { hasText: "Put on hold" }).click();
  await page.waitForTimeout(500);
  let r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "ON_HOLD", "the request goes on hold");
  ok(r.previousStatus === "UNDER_REVIEW", "and remembers the status it was held from");
  ok(r.holdReason === "Waiting for Owner", "with the reason recorded");
  ok(r.currentAction === "None", "nobody holds the ball while it is paused");

  await page.locator("button", { hasText: "Resume" }).click();
  await page.waitForTimeout(500);
  r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "UNDER_REVIEW", "Resume returns it to exactly where it was");
  ok(!r.previousStatus, "and clears the remembered status");
}

group("Cancelling requires a reason and is recorded");
{
  answer("Owner withdrew", true);   // the reason prompt, then the confirmation
  await page.locator("button", { hasText: "Cancel" }).first().click();
  await page.waitForTimeout(600);
  const r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "CANCELLED", "the request is cancelled");
  ok(r.cancelReason === "Owner withdrew", "the reason is stored");
  const buttons = await page.locator(".card button").allInnerTexts();
  ok(!buttons.some(b => /hold|cancel|review/i.test(b)), "a cancelled request offers no further actions");
}

group("Per-request history is append-only");
{
  const entries = await page.evaluate(() => Object.entries(window.__stub.dump())
    .filter(([p]) => /^requests\/PTAA-00001\/activity\//.test(p)).map(([, v]) => v));
  ok(entries.length > 0, "transitions are written to the request's own history");
  ok(entries.some(e => /cancelled/i.test(e.summary || "")), "the cancellation is in the history");
  const t = await page.locator("#root").innerText();
  ok(/Append-only/.test(t), "the history states that it cannot be edited");
}

group("Properties registry");
{
  await scenario({ docs: { ...BOSS }, user: google("boss@gmail.com"), hash: "#/properties" });
  await page.fill("#p-name", "M ASTRA");
  await page.fill("#p-address", "Jalan Ampang, KL");
  await page.locator("button", { hasText: "Add" }).first().click();
  await page.waitForTimeout(500);
  const st = await dump();
  const added = Object.entries(st).find(([k]) => k.startsWith("properties/"));
  ok(!!added, "an admin can add a property");
  ok(added && added[1].name === "M ASTRA", "with the exact spelling that will reach the filename");

  await page.fill("#p-name", "m astra");
  await page.locator("button", { hasText: "Add" }).first().click();
  await page.waitForTimeout(400);
  ok(/already on the list/i.test(await page.locator("body").innerText()),
     "a differently-cased duplicate is refused, so one condo has one spelling");

  const propCount = Object.keys(await dump()).filter(k => k.startsWith("properties/")).length;
  ok(propCount === 1, "…and no second property was created");
}

group("An agent cannot reach admin-only request screens");
{
  await scenario({ docs: { ...SUZANNE, ...PROPS }, user: google("suzanne@gmail.com"), hash: "#/properties" });
  ok(/Administrators only/.test(await page.locator("#root").innerText()),
     "an agent typing #/properties is refused");
  const nav = await page.locator(".nav").innerText();
  ok(!/Properties/.test(nav), "and Properties is absent from their navigation");
}

// ---------------------------------------------------------------------------
// Phases 4 and 5 — the template registry and document generation
// ---------------------------------------------------------------------------

let PizZip = null;
try { ({ default: PizZip } = await import("pizzip")); } catch { /* optional */ }

const RUN = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const PARA = (t) => `<w:p>${RUN(t)}</w:p>`;

// Kept in step with js/placeholders.js by importing it, rather than by a copy
// here that quietly rots — this list changed once already when the real
// D TERRA template arrived.
const { REQUIRED_TAGS: REQUIRED, IMAGE_TAGS } = await import("../../js/placeholders.js");

/**
 * Build a .docx in memory.
 *  - omit           leaves those placeholders out
 *  - withLoop       include the optional special-terms block
 *  - withSignatures include the three signature slots
 */
function makeTemplate({ omit = [], withLoop = true, withSignatures = false } = {}) {
  const body = REQUIRED.filter(t => !omit.includes(t)).map(t => PARA(`Label: {{${t}}}`)).join("") +
    (withLoop ? PARA("{{#special_terms}}") + PARA("- {{.}}") + PARA("{{/special_terms}}") : "") +
    (withSignatures ? IMAGE_TAGS.map(t => PARA(`{{${t}}}`)).join("") : "") +
    PARA("11. {{utilities_owner}}") + PARA("12. {{utilities_advanced}}") + PARA("13. {{utilities_tenant}}") +
    PARA("Owner Group Admin: {{pic_nickname}} - {{pic_mobile}}") +
    PARA("Witnessed by: {{admin_full_name}} ({{admin_nric}})");
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}
<w:tbl><w:tr><w:tc>${PARA("Unit")}</w:tc><w:tc>${PARA("{{property_unit_number}}")}</w:tc></w:tr></w:tbl>
</w:body></w:document>`;
  const zip = new PizZip();
  zip.file("[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels").file(".rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder("word").file("document.xml", doc);
  // A real .docx has this; embedSignatures needs it to add the image relationship.
  zip.folder("word").folder("_rels").file("document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  return zip.generate({ type: "nodebuffer" });
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

if (!PizZip) {
  group("Phases 4 and 5");
  console.log("  · skipped — run `npm install pizzip` to enable the template tests");
} else {

const TEMPLATE_DOCS = {
  ...BOSS, ...SUZANNE,
  "properties/p1": { name: "M ASTRA", nameLower: "m astra", address: "Jalan Ampang, KL", active: true },
  "properties/p2": { name: "THE ERA", nameLower: "the era", address: "Jalan Ipoh, KL", active: true },
};

group("Template registry (phase 4)");
{
  const t = await scenario({ docs: TEMPLATE_DOCS, user: google("boss@gmail.com"), hash: "#/templates" });
  ok(/2 properties have no template/i.test(t), "properties without a template are named up front");
  ok(/M ASTRA/.test(t) && /THE ERA/.test(t), "every property is listed");
  ok(/\{\{agent_full_name\}\}/.test(t), "the required placeholder list is shown on screen");
  ok(/\{\{#special_terms\}\}/.test(t), "…including the repeating block");
  ok(/\{\{utilities_owner\}\}/.test(t), "…and the three utilities rows");
  ok(/\{\{sig_director\}\}/.test(t), "…and the signature slots");

  // A template missing two placeholders must be refused, naming them.
  const bad = makeTemplate({ omit: ["owner_nric", "agent_mobile"] });
  await page.locator("tr", { hasText: "M ASTRA" }).locator('input[type="file"]')
            .setInputFiles({ name: "bad.docx", mimeType: DOCX_MIME, buffer: bad });
  await page.waitForTimeout(1200);
  const refusedCard = await page.locator(".card", { hasText: "Template refused" }).innerText()
                                .catch(() => "");
  ok(/Template refused/.test(refusedCard), "an incomplete template is refused");
  ok(/\{\{owner_nric\}\}/.test(refusedCard) && /\{\{agent_mobile\}\}/.test(refusedCard),
     "…and the message names exactly which placeholders are missing");
  ok(/2 required placeholders are missing/.test(refusedCard), "…and how many");
  ok(!/\{\{owner_name\}\}/.test(refusedCard), "…and does not list the ones that are present");
  ok(Object.keys(await dump()).every(k => !k.startsWith("templates/")),
     "nothing was saved");

  // The special-terms block is optional — his real D TERRA template has none.
  await page.locator("button", { hasText: "Discard" }).click();
  await page.waitForTimeout(200);
  await page.locator("tr", { hasText: "M ASTRA" }).locator('input[type="file"]')
            .setInputFiles({ name: "noloop.docx", mimeType: DOCX_MIME, buffer: makeTemplate({ withLoop: false }) });
  await page.waitForTimeout(1200);
  ok(/Template checked/.test(await page.locator("#root").innerText()),
     "a template with no special-terms block is accepted — the real one has none");

  // A non-Word file is refused before anything else happens.
  await page.locator("button", { hasText: "Discard" }).click();
  await page.waitForTimeout(200);
  await page.locator("tr", { hasText: "M ASTRA" }).locator('input[type="file"]')
            .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.waitForTimeout(800);
  ok(/is not a \.docx/i.test(await page.locator("#root").innerText()), "a non-.docx file is refused");

  // The good one is accepted and stored.
  await page.locator("tr", { hasText: "M ASTRA" }).locator('input[type="file"]')
            .setInputFiles({ name: "M-ASTRA-PTAA.docx", mimeType: DOCX_MIME, buffer: makeTemplate() });
  await page.waitForTimeout(1200);
  const checked = await page.locator("#root").innerText();
  ok(/Template checked/.test(checked), "a complete template passes the check");
  ok(new RegExp(`All\\s+${REQUIRED.length}\\s+required placeholders are present`).test(checked),
     "…and says how many");
  ok(/No signature slots/.test(checked),
     "…and says plainly that this template has no signature slots");

  await page.locator("button", { hasText: "Save this template" }).click();
  await page.waitForTimeout(1200);
  const st = await dump();
  ok(!!st["templates/p1"], "the template is stored against the property, not globally");
  ok(st["templates/p1"].fileName === "M-ASTRA-PTAA.docx", "the original filename is kept");
  ok(st["templates/p1"].chunkCount >= 1 && !!st["templates/p1/chunks/0"], "the file bytes are stored");
  ok(st["templates/p1"].version === 1, "it is version 1");

  const after = await page.locator("#root").innerText();
  ok(/1 property has no template/i.test(after), "the warning now names only the remaining property");
}

group("Document generation (phase 5)");
{
  const REQ = {
    ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "UNDER_REVIEW", currentAction: "PTAA Admin",
    agentEmail: "suzanne@gmail.com",
    agentSnapshot: { fullName: "CHAN SIEW SIN", nric: "000908-14-0426",
                     phone: "019-400 9082", nickname: "Suzanne", profileVersion: 1 },
    adminSnapshot: null,
    owner: { name: "LOY HUI TING", nric: "880214-10-5566", phone: "012-345 6789",
             address: "12 Jalan Ampang, KL", email: "",
             bankName: "MALAYAN BANKING BERHAD (MAYBANK)", accountNumber: "512345678901" },
    propertyId: "p2", propertyName: "THE ERA", propertyAddress: "Jalan Ipoh, KL",
    unitNo: "B-07-11", ptaaType: "WUR", propertySize: 1151,
    tenancy: { initialTermMonths: 24, commencementDate: "2026-10-01", expiryDate: "2028-09-30" },
    financial: { monthlyAdminFeePercent: 12, renovationCost: null },
    utilities: {
      electricity: { label: "Electricity", party: "advanced", standard: true },
      water:       { label: "Water", party: "advanced", standard: true },
      internet:    { label: "Wi-Fi / Internet", party: "advanced", standard: true },
      cleaning:    { label: "Cleaning Services", party: "tenant", standard: true },
      aircond:     { label: "AC Usage via Smart Meter", party: "owner", standard: true },
    },
    specialTerms: ["Owner keeps the built-in wardrobe."], notes: "", updatedAt: "@now",
  };

  const GEN_DOCS = {
    ...BOSS_WITH_PROFILE, ...SUZANNE,
    "properties/p1": { name: "M ASTRA", nameLower: "m astra", address: "Jalan Ampang, KL", active: true },
    "properties/p2": { name: "THE ERA", nameLower: "the era", address: "Jalan Ipoh, KL",
                       active: true, picNickname: "Keith", picMobile: "012-999 8888" },
  };

  // No template registered for THE ERA yet.
  await scenario({ docs: { ...GEN_DOCS, "requests/PTAA-00001": REQ },
                   user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);
  let t = await page.locator("#root").innerText();
  ok(/No template is registered for/.test(t) && /THE ERA/.test(t),
     "generation is blocked and the message names the property (brief §5.3)");
  let buttons = await page.locator(".card button").allInnerTexts();
  ok(!buttons.some(b => /generate/i.test(b)), "no Generate button is offered without a template");

  ok(/Cleaning Services/.test(t) && /Borne by the Tenant/.test(t),
     "the utilities the schedule will carry are shown on the request");
  ok(/Whole Unit Rental/.test(t),
     "…with a note explaining why cleaning fell to the tenant on a WUR");
  ok(/MALAYAN BANKING BERHAD/.test(t), "the owner's bank details are shown");
  ok(/12 %/.test(t), "the admin fee is shown as a percentage, not an amount");

  // Register a template with signature slots, then generate.
  const tpl = makeTemplate({ withSignatures: true });
  const seedTemplate = async (buf) => {
    await page.evaluate(([b64, bytes]) => {
      window.__stub.seed("templates/p2", {
        propertyId: "p2", propertyName: "THE ERA", fileName: "THE-ERA-PTAA.docx",
        bytes, chunkCount: 1, version: 1, uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
      });
      window.__stub.seed("templates/p2/chunks/0", { data: b64 });
    }, [buf.toString("base64"), buf.length]);
  };
  const reopen = async () => {
    await page.evaluate(() => { location.hash = "#/dashboard"; });
    await page.waitForTimeout(200);
    await page.evaluate(() => { location.hash = "#/request:PTAA-00001"; });
    await page.waitForTimeout(900);
  };

  await seedTemplate(tpl);
  await reopen();
  t = await page.locator("#root").innerText();
  ok(/THE-ERA-PTAA\.docx/.test(t), "the registered template is shown on the request");
  ok(/PTAA \(THE ERA B-07-11\) LOY HUI TING\.docx/.test(t),
     "the filename to be produced follows the pattern actually in use");
  ok(/No signature images have been uploaded yet/.test(t),
     "with no signatures stored, the request says so rather than offering empty pickers");

  const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
  await page.locator("button", { hasText: "Generate document" }).click();
  const download = await downloadPromise;
  ok(download.suggestedFilename() === "PTAA (THE ERA B-07-11) LOY HUI TING.docx",
     "the download is named by the pattern, never typed: " + download.suggestedFilename());

  // Verify the produced file really is a filled Word document.
  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  const produced = new PizZip(readFileSync(path));
  const xml = produced.file("word/document.xml").asText();
  ok(xml.includes("LOY HUI TING"), "the owner's name is in the document");
  ok(xml.includes("CHAN SIEW SIN"), "the agent's snapshotted name is in the document");
  ok(xml.includes("019-400 9082"), "the agent's mobile is in the document");
  ok(xml.includes("01st October 2026"), "dates carry the ordinal day");
  ok(xml.includes("Twenty-four") && /Label: 24</.test(xml),
     "the term appears as words and as digits");
  ok(xml.includes("Twelve Per centum") && /Label: 12</.test(xml),
     "the admin fee is a percentage in words and digits, not a Ringgit amount");
  ok(!/RM\s*\d/.test(xml), "…and nowhere is it rendered as a Ringgit amount");
  ok(xml.includes("Keith") && xml.includes("012-999 8888"),
     "the Owner Group Admin came from the property record");
  ok(xml.includes("NUR AFIQAH BINTI RAZAK"),
     "the admin who generated it is named in the witness block");
  ok(xml.includes("Cleaning Services"), "the tenant's utilities row is filled");
  ok(xml.includes("wardrobe"), "the special term was rendered by the repeating block");
  ok(!xml.includes("{{"), "no placeholder was left unfilled");
  ok(!xml.includes("ANCHORSIG"),
     "an unfilled signature slot is stripped, never left as a marker in the agreement");
  ok(xml.includes("<w:tbl>"), "the template's table survived the fill");

  await page.waitForTimeout(1000);
  let st = await dump();
  let req = st["requests/PTAA-00001"];
  ok(req.workingDoc && req.workingDoc.source === "generated", "the document is stored against the request");
  ok(req.manuallyEdited === false, "and is not marked as manually edited");
  ok(!!st["requests/PTAA-00001/docChunks/0"], "its bytes are stored");
  ok(req.adminSnapshot && req.adminSnapshot.email === "boss@gmail.com",
     "who prepared it is recorded on the request, not recomputed later");
  ok(req.adminSnapshot.fullName === "NUR AFIQAH BINTI RAZAK", "…with the details as they stood");
}

group("An admin with no profile cannot generate (their name goes in the document)");
{
  const REQ = (await dump())["requests/PTAA-00001"];
  await scenario({
    docs: {
      ...BOSS, ...SUZANNE,     // BOSS, deliberately without a profile
      "properties/p2": { name: "THE ERA", nameLower: "the era", address: "Jalan Ipoh, KL", active: true },
      "requests/PTAA-00001": { ...REQ, workingDoc: null, manuallyEdited: false },
    },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001",
  });
  const tpl = makeTemplate({ withSignatures: true });
  await page.evaluate(([b64, bytes]) => {
    window.__stub.seed("templates/p2", {
      propertyId: "p2", propertyName: "THE ERA", fileName: "THE-ERA-PTAA.docx",
      bytes, chunkCount: 1, version: 1, uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
    });
    window.__stub.seed("templates/p2/chunks/0", { data: b64 });
  }, [tpl.toString("base64"), tpl.length]);
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = "#/request:PTAA-00001"; });
  await page.waitForTimeout(900);

  await page.locator("button", { hasText: "Generate document" }).click();
  await page.waitForTimeout(900);
  const toastText = await page.locator(".toast").last().innerText().catch(() => "");
  ok(/profile is incomplete/i.test(toastText),
     "generation is refused and says why: " + toastText.slice(0, 80));
  const st = await dump();
  ok(!st["requests/PTAA-00001"].workingDoc, "and no document was produced");
}

group("Signature images (his fourth question)");
{
  const REQ = {
    ptaaId: "PTAA-00002", type: "NEW_PTAA", status: "UNDER_REVIEW", currentAction: "PTAA Admin",
    agentEmail: "suzanne@gmail.com",
    agentSnapshot: { fullName: "CHAN SIEW SIN", nric: "000908-14-0426",
                     phone: "019-400 9082", nickname: "Suzanne", profileVersion: 1 },
    adminSnapshot: null,
    owner: { name: "LOY HUI TING", nric: "880214-10-5566", phone: "012-345 6789",
             address: "12 Jalan Ampang, KL", email: "" },
    propertyId: "p2", propertyName: "THE ERA", propertyAddress: "Jalan Ipoh, KL",
    unitNo: "B-07-11", ptaaType: "WUR",
    tenancy: { initialTermMonths: 24, commencementDate: "2026-10-01", expiryDate: "2028-09-30" },
    financial: { monthlyAdminFeePercent: 12, renovationCost: null },
    utilities: {}, specialTerms: [], notes: "", updatedAt: "@now",
  };

  // A 2x2 PNG stored the way the app stores one: base64 chunks under the key.
  const SIG_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAJUYAwXqBSGSAAAAAElFTkSuQmCC",
    "base64");

  await scenario({
    docs: {
      ...BOSS_WITH_PROFILE, ...SUZANNE,
      "properties/p2": { name: "THE ERA", nameLower: "the era", address: "Jalan Ipoh, KL", active: true },
      "requests/PTAA-00002": REQ,
      "signatures/shared:director-benjamin": {
        key: "shared:director-benjamin", kind: "shared", ownerEmail: null,
        label: "Director Benjamin", fileName: "Director_benjamin_sign.png",
        bytes: SIG_PNG.length, chunkCount: 1, width: 2, height: 2,
        isDirector: true, uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
      },
      "signatures/shared:director-benjamin/chunks/0": { data: SIG_PNG.toString("base64") },
      "signatures/user:suzanne@gmail.com": {
        key: "user:suzanne@gmail.com", kind: "user", ownerEmail: "suzanne@gmail.com",
        label: "CHAN SIEW SIN", fileName: "suzanne.png",
        bytes: SIG_PNG.length, chunkCount: 1, width: 2, height: 2,
        isDirector: false, uploadedBy: "suzanne@gmail.com", uploadedAt: new Date(),
      },
      "signatures/user:suzanne@gmail.com/chunks/0": { data: SIG_PNG.toString("base64") },
    },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00002",
  });

  const tpl = makeTemplate({ withSignatures: true });
  await page.evaluate(([b64, bytes]) => {
    window.__stub.seed("templates/p2", {
      propertyId: "p2", propertyName: "THE ERA", fileName: "THE-ERA-PTAA.docx",
      bytes, chunkCount: 1, version: 1, uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
    });
    window.__stub.seed("templates/p2/chunks/0", { data: b64 });
  }, [tpl.toString("base64"), tpl.length]);
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = "#/request:PTAA-00002"; });
  await page.waitForTimeout(1200);

  const t = await page.locator("#root").innerText();
  ok(/Signature images/.test(t), "the request offers a signature picker");
  ok(/Director Benjamin/.test(t), "the stored company signature is offered");

  ok(await page.locator("#sig-sig_director").inputValue() === "shared:director-benjamin",
     "the Director slot starts on the signature marked as the Director's");
  ok(await page.locator("#sig-sig_agent").inputValue() === "user:suzanne@gmail.com",
     "the agent slot starts on the agent's own signature");
  ok(await page.locator("#sig-sig_admin").inputValue() === "",
     "the admin slot is blank, because this admin has not uploaded one");

  // §10: it asks before placing anything.
  answer(false);
  await page.locator("button", { hasText: "Generate document" }).click();
  await page.waitForTimeout(700);
  ok(!(await dump())["requests/PTAA-00002"].workingDoc,
     "declining the signature confirmation produces nothing at all");

  answer(true);
  const dl = page.waitForEvent("download", { timeout: 20000 });
  await page.locator("button", { hasText: "Generate document" }).click();
  const download = await dl;
  const { readFileSync } = await import("node:fs");
  const produced = new PizZip(readFileSync(await download.path()));
  const xml = produced.file("word/document.xml").asText();

  ok(!!produced.file("word/media/anchor-sig_director.png"), "the Director's image is in the package");
  ok(!!produced.file("word/media/anchor-sig_agent.png"), "the agent's image is in the package");
  ok(!produced.file("word/media/anchor-sig_admin.png"),
     "the slot nobody was chosen for gets no image");
  ok((xml.match(/<w:drawing>/g) || []).length === 2, "two pictures, not three");
  ok(!xml.includes("ANCHORSIG"), "the unfilled slot's marker is stripped");
  ok(/Extension="png"/.test(produced.file("[Content_Types].xml").asText()),
     "the png content type was declared, or Word would refuse the file");

  await page.waitForTimeout(1000);
  const history = await page.locator("#root").innerText();
  ok(/Signature images placed/.test(history),
     "who was placed is written to the request history, not left to memory");
  ok(/Director Benjamin/.test(history), "…naming the signature used");
}

group("Manual edits block regeneration (brief §5.4, criterion #17)");
{
  // The signature group re-seeded the stub around PTAA-00002, so start from a
  // request that has a generated document again.
  await page.evaluate(() => {
    const d = window.__stub.dump()["requests/PTAA-00002"];
    window.__stub.seed("requests/PTAA-00002", { ...d, manuallyEdited: true,
      workingDoc: { ...d.workingDoc, source: "uploaded", fileName: "edited.docx" } });
  });
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(200);
  await page.evaluate(() => { location.hash = "#/request:PTAA-00002"; });
  await page.waitForTimeout(900);

  const t = await page.locator("#root").innerText();
  ok(/Manually edited/.test(t), "the document is flagged as hand-edited");
  ok(/discard those edits/i.test(t), "…and the consequence of regenerating is spelled out");
  ok(/no V1\/V2\/V3 copies/i.test(t), "…and that only the current document is kept (brief §11.5)");

  // Declining the confirmation must leave everything alone.
  answer(false);
  await page.locator("button", { hasText: "Regenerate from template" }).click();
  await page.waitForTimeout(700);
  const st = await dump();
  ok(st["requests/PTAA-00002"].manuallyEdited === true,
     "declining the confirmation leaves the edited document in place");
  ok(st["requests/PTAA-00002"].workingDoc.source === "uploaded", "…and unchanged");
}

group("Templates are admin-only");
{
  await scenario({ docs: TEMPLATE_DOCS, user: google("suzanne@gmail.com"), hash: "#/templates" });
  ok(/Administrators only/.test(await page.locator("#root").innerText()),
     "an agent typing #/templates is refused");
  ok(!/Templates/.test(await page.locator(".nav").innerText()),
     "and Templates is absent from their navigation");
}

}   // end PizZip guard

// ---------------------------------------------------------------------------
// Phases 7 to 10 — notifications, change requests, signatures, checklist
// ---------------------------------------------------------------------------

const BASE_REQ = (over = {}) => ({
  ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "READY_FOR_AGENT", currentAction: "Sales Agent",
  agentEmail: "suzanne@gmail.com",
  agentSnapshot: { fullName: "CHAN SIEW SIN", nric: "000908-14-0426",
                   phone: "019-400 9082", nickname: "Suzanne", profileVersion: 1 },
  owner: { name: "LOY HUI TING", nric: "880214-10-5566", phone: "012-345 6789",
           address: "12 Jalan Ampang, KL", email: "" },
  propertyId: "p1", propertyName: "M ASTRA", propertyAddress: "Jalan Ampang, KL",
  unitNo: "A-18-09", ptaaType: "Partition",
  tenancy: { initialTermMonths: 36, commencementDate: "2026-09-01", expiryDate: "2029-08-31" },
  financial: { monthlyAdminFeePercent: 10, renovationCost: null },
  specialTerms: ["Owner keeps the built-in wardrobe."], notes: "",
  signatories: {}, finalChecklist: {}, openChangeRequest: null,
  attachmentCount: 0, revision: 1, manuallyEdited: false, updatedAt: "@now",
  ...over,
});

const WORLD = { ...BOSS, ...SUZANNE, ...PROPS };
const notices = () => page.evaluate(() => Object.entries(window.__stub.dump())
  .filter(([p]) => p.startsWith("notifications/")).map(([, v]) => v));

group("In-app notifications (phase 7, brief §14.2)");
{
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({ status: "UNDER_REVIEW", currentAction: "PTAA Admin" }) },
                   user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(500);

  answer("Please confirm the Owner's address.");
  await page.locator("button", { hasText: "Request changes" }).click();
  await page.waitForTimeout(700);

  let all = await notices();
  ok(all.length === 1, "requesting changes notifies exactly one person");
  ok(all[0].forEmail === "suzanne@gmail.com", "…the Sales Agent whose PTAA it is");
  ok(/Changes are needed/.test(all[0].text), "…with what happened");
  ok(/Owner's address/.test(all[0].text), "…including the admin's note");
  ok(all[0].requestId === "PTAA-00001", "…linked to the PTAA");
  ok(all[0].readAt === null, "…and unread");

  // The example wording in the brief.
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({ status: "PTAA_OK", currentAction: "PTAA Admin" }) },
                   user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: "Release to agent" }).click();
  await page.waitForTimeout(700);
  all = await notices();
  ok(all.some(n => /PTAA \(M ASTRA A-18-09\) LOY HUI TING is ready for you\./.test(n.text)),
     "the release notice names the PTAA the way the filename does");
}

group("The agent reads their notifications");
{
  await scenario({
    docs: { ...WORLD,
      "requests/PTAA-00001": BASE_REQ(),
      "notifications/n1": { forEmail: "suzanne@gmail.com", requestId: "PTAA-00001",
        text: "PTAA (M ASTRA A-18-09) LOY HUI TING is ready for you.",
        event: "ready", createdAt: "@now", createdBy: "boss@gmail.com", readAt: null },
      "notifications/n2": { forEmail: "ali@gmail.com", requestId: "PTAA-00002",
        text: "Someone else's notification.", event: "ready",
        createdAt: "@now", createdBy: "boss@gmail.com", readAt: null },
    },
    user: google("suzanne@gmail.com"), hash: "#/notifications",
  });
  await page.waitForTimeout(500);
  const t = await page.locator("#root").innerText();
  ok(/is ready for you/.test(t), "the agent sees their notification");
  ok(!/Someone else's notification/.test(t), "and never another agent's");
  ok(/Email is not configured/.test(t), "the screen says plainly that no email is sent (§14.2)");

  const bell = await page.locator(".bell").innerText();
  ok(/1/.test(bell), "the header shows the unread count");

  await page.locator("button", { hasText: "Mark all 1 as read" }).click();
  await page.waitForTimeout(700);
  const after = await notices();
  ok(after.find(n => n.forEmail === "suzanne@gmail.com").readAt !== null, "marking read sticks");
  ok(after.find(n => n.forEmail === "ali@gmail.com").readAt === null,
     "and does not touch anyone else's");
}

group("Owner change requests (phase 8, brief §9.3)");
{
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ() },
                   user: google("suzanne@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);

  const btn = page.locator("button", { hasText: "Request changes" });
  ok(await btn.count() > 0, "an agent holding a released PTAA can request changes");
  ok(!(await btn.first().isDisabled()), "…and the button is live, not a placeholder");

  answer("Change the tenancy period from 36 months to 12 months");
  await btn.first().click();
  await page.waitForTimeout(800);

  const st = await dump();
  const r = st["requests/PTAA-00001"];
  ok(r.status === "UNDER_REVIEW", "the PTAA goes back to the admin for review");
  ok(r.currentAction === "PTAA Admin", "…and the admin has the ball");
  ok(r.openChangeRequest && /12 months/.test(r.openChangeRequest.text),
     "what the Owner asked for is recorded on the request");
  ok(r.openChangeRequest.by === "suzanne@gmail.com", "…with who raised it");

  const events = await page.evaluate(() => Object.entries(window.__stub.dump())
    .filter(([p]) => /^requests\/PTAA-00001\/activity\//.test(p)).map(([, v]) => v));
  ok(events.some(e => e.action === "change.requested"), "it is in the request's history");

  // The admin sees it prominently, and marking PTAA OK clears it.
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({
      status: "UNDER_REVIEW", currentAction: "PTAA Admin",
      openChangeRequest: { text: "Change the tenancy period from 36 months to 12 months",
                           by: "suzanne@gmail.com", at: "@now" } }) },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);
  const adminView = await page.locator("#root").innerText();
  ok(/The Owner has asked for a change/.test(adminView), "the admin sees the change request up front");
  ok(/12 months/.test(adminView), "…with the agent's own words");

  await page.locator("button", { hasText: "Mark PTAA OK" }).click();
  await page.waitForTimeout(700);
  ok(!(await dump())["requests/PTAA-00001"].openChangeRequest,
     "marking PTAA OK clears the open change request");
}

group("Signature tracking (phase 9, brief §9.2)");
{
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({
      status: "WAITING_FOR_SIGNATURE", currentAction: "Director" }) },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);

  let t = await page.locator("#root").innerText();
  ok(/No signatures required on this PTAA yet/.test(t),
     "nothing is assumed — a PTAA starts with no signatories");
  ok(/nothing is inserted automatically/.test(t),
     "the screen states that a signature is never applied automatically (§10)");

  const row = (name) => page.locator("tr", { hasText: name });
  await row("Director").locator("button", { hasText: "Mark required" }).click();
  await page.waitForTimeout(600);
  await row("Witness").locator("button", { hasText: "Mark required" }).click();
  await page.waitForTimeout(600);

  t = await page.locator("#root").innerText();
  ok(/0 of 2 recorded/.test(t), "each signatory is counted separately");
  ok(/Waiting for Director and Witness/.test(t), "the summary lists everyone outstanding");

  await row("Director").locator("button", { hasText: "Record signature" }).click();
  await page.waitForTimeout(700);
  let r = (await dump())["requests/PTAA-00001"];
  ok(r.signatories.director.status === "SIGNED", "a signature can be recorded");
  ok(!!r.signatories.director.signedAt, "…with the date it happened");
  ok(r.currentAction === "Witness",
     "who has the ball moves to the next outstanding signatory, not back to the admin");
  ok(/Waiting for Witness/.test(await page.locator("#root").innerText()),
     "the derived summary reads 'Waiting for Witness' (brief §9.2)");

  const n = await notices();
  ok(n.some(x => /Signature update/.test(x.text) && x.forEmail === "suzanne@gmail.com"),
     "the agent is told about signature progress");

  await row("Witness").locator("button", { hasText: "Record signature" }).click();
  await page.waitForTimeout(700);
  r = (await dump())["requests/PTAA-00001"];
  ok(r.currentAction === "PTAA Admin", "once everyone has signed it returns to the admin");
  ok(/All required signatures recorded/.test(await page.locator("#root").innerText()),
     "…and the summary says so");
}

group("Final checklist (phase 10, brief §11.1)");
{
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({
      status: "FINAL_CHECK", currentAction: "PTAA Admin" }) },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);

  let t = await page.locator("#root").innerText();
  ok(/Final checklist \(0 of 11\)/.test(t), "all eleven items from the brief are listed");
  ok(/No document has been produced for this request yet/.test(t),
     "an item the system can answer for itself is blocked rather than takeable on trust");
  ok(await page.locator("#cl-document").isDisabled(), "…and its checkbox cannot be ticked");
  ok(!(await page.locator("#cl-ptaa_info").isDisabled()), "items that need judgement are tickable");

  await page.locator("#cl-ptaa_info").check();
  await page.waitForTimeout(600);
  ok(/Final checklist \(1 of 11\)/.test(await page.locator("#root").innerText()),
     "ticking one is recorded");
  const rec = (await dump())["requests/PTAA-00001"];
  ok(rec.finalChecklist.ptaa_info.by === "boss@gmail.com", "…against who confirmed it");

  // Editing the data must invalidate the confirmations.
  await page.locator("button", { hasText: "Edit details" }).click();
  await page.waitForTimeout(700);
  await page.fill("#ed-owner-name", "LOY HUI TING (REVISED)");
  await page.waitForTimeout(200);
  await page.locator("button", { hasText: "Save changes" }).click();
  await page.waitForTimeout(900);

  const after = (await dump())["requests/PTAA-00001"];
  ok(Object.keys(after.finalChecklist || {}).length === 0,
     "editing the request data clears the checklist — a stale confirmation is not a confirmation");
  const events = await page.evaluate(() => Object.entries(window.__stub.dump())
    .filter(([p]) => /^requests\/PTAA-00001\/activity\//.test(p)).map(([, v]) => v));
  ok(events.some(e => e.action === "checklist.cleared"), "…and the history says why");
}

// ---------------------------------------------------------------------------
// Phase 11 — completion and the Drive upload
//
// The upload now goes straight from the browser to the Google Drive API, as
// the admin, with a token from Google's permission pop-up. Google is not
// reachable here, so www.googleapis.com is answered by a small fake Drive.
// That is the point: these tests are about what the APP does with each answer,
// and the most important one is what it does when the upload fails.
// ---------------------------------------------------------------------------

const FOLDER_MIME = "application/vnd.google-apps.folder";
const drive = { mode: "ok", files: new Map(), pending: new Map(), seq: 0, uploads: [] };
function resetDrive(mode = "ok") {
  drive.mode = mode; drive.files.clear(); drive.pending.clear(); drive.uploads.length = 0;
  drive.files.set("root1", { id: "root1", name: "PTAA", mimeType: FOLDER_MIME, parents: [] });
  drive.files.set("folder1", { id: "folder1", name: "M ASTRA", mimeType: FOLDER_MIME, parents: ["root1"] });
  if (mode === "clash") {
    drive.files.set("other", { id: "other", name: "PTAA (M ASTRA A-18-09) LOY HUI TING.docx",
      mimeType: "application/octet-stream", parents: ["folder1"], appProperties: { anchorPtaa: "PTAA-00077:ptaa" } });
  }
}
const DRIVE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Content-Type, X-Upload-Content-Length",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  "Access-Control-Expose-Headers": "Location",
};
await page.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request(), url = new URL(req.url()), method = req.method();
  const reply = (body, status = 200, extra = {}) => route.fulfill({ status,
    headers: { ...DRIVE_CORS, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
  if (method === "OPTIONS") return route.fulfill({ status: 204, headers: DRIVE_CORS });
  const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const f = drive.files.get(one[1]);
    return f ? reply({ ...f, trashed: false }) : reply({ error: { message: "File not found" } }, 404);
  }
  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const q = url.searchParams.get("q");
    const parent = /'([^']+)' in parents/.exec(q)[1];
    const want = /mimeType = '/.test(q) ? "folders" : /mimeType != '/.test(q) ? "files" : "all";
    return reply({ files: [...drive.files.values()].filter(f => (f.parents || []).includes(parent))
      .filter(f => want === "all" || (want === "folders") === (f.mimeType === FOLDER_MIME)) });
  }
  if (url.pathname.startsWith("/upload/drive/v3/files")) {
    const uid = url.searchParams.get("upload_id");
    if (uid) {
      if (drive.mode === "fail") return reply({ error: { message: "Backend Error" } }, 500);
      const p = drive.pending.get(uid);
      const id = p.fileId || ("drivefile" + (++drive.seq));
      drive.files.set(id, { ...(drive.files.get(id) || {}), ...p.meta, id,
                            webViewLink: `https://drive.google.com/file/d/${id}/view` });
      drive.uploads.push({ ...p.meta, bytes: req.postDataBuffer().length, auth: req.headers()["authorization"] });
      return reply({ id, name: drive.files.get(id).name, webViewLink: drive.files.get(id).webViewLink });
    }
    const newId = "u" + (++drive.seq);
    drive.pending.set(newId, { meta: JSON.parse(req.postData() || "{}"),
      fileId: (/\/files\/([^/?]+)/.exec(url.pathname) || [])[1] || null });
    return reply({}, 200, { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${newId}` });
  }
  return reply({ error: { message: "unhandled " + url.pathname } }, 400);
});

const DRIVE_SETTINGS = { "settings/app": { ptaaFolderId: "root1", ptaaFolderName: "PTAA", ptaaSubfolder: true } };

const ALL_TICKED = {};
for (const k of ["ptaa_info","owner_info","property_unit","tenancy","special_terms",
                 "quotation","signatures","no_changes","no_requests","filename","document"]) {
  ALL_TICKED[k] = { checked: true, by: "boss@gmail.com", at: "@now" };
}

const READY_TO_COMPLETE = () => BASE_REQ({
  status: "FINAL_CHECK", currentAction: "PTAA Admin",
  finalChecklist: ALL_TICKED,
  // bytes must match what the seeded chunk actually decodes to, or readChunks
  // rejects it — the same integrity check that protects a real stored document.
  workingDoc: { fileName: "x.docx", bytes: 10, chunkCount: 1, source: "generated" },
  signatories: { director: { status: "SIGNED" } },
});

async function openReadyRequest(extraDocs = {}) {
  await scenario({
    docs: { ...WORLD, ...extraDocs, "requests/PTAA-00001": READY_TO_COMPLETE() },
    user: google("boss@gmail.com"), hash: "#/request:PTAA-00001",
  });
  // The stored document's bytes have to exist for the upload to read them.
  await page.evaluate(() => window.__stub.seed("requests/PTAA-00001/docChunks/0",
    { data: "UEsDBBQAAAAIAA==" }));
  await page.evaluate(() => { location.hash = "#/dashboard"; });
  await page.waitForTimeout(150);
  await page.evaluate(() => { location.hash = "#/request:PTAA-00001"; });
  await page.waitForTimeout(1100);
}

group("Drive not connected: the app says so instead of pretending");
{
  resetDrive("ok");
  await openReadyRequest({ "settings/app": { ptaaFolderId: "" } });   // no Drive folder chosen

  const t = await page.locator("#root").innerText();
  ok(/Final checklist \(11 of 11\)/.test(t), "every line is confirmed");
  ok(/Google Drive is not connected/.test(t), "the Drive state is stated up front");
  ok(/under Settings/.test(t), "…with what to do about it");

  const btn = page.locator("button", { hasText: "Complete and file to Drive" });
  ok(await btn.count() === 1, "the Complete action exists now that phase 11 is built");
  ok(await btn.isDisabled(), "…but is disabled while Drive is unreachable");
}

group("A failed upload changes NOTHING (brief §11.2)");
{
  resetDrive("fail");
  await openReadyRequest(DRIVE_SETTINGS);

  ok(/Drive is connected/.test(await page.locator("#root").innerText()),
     "with Drive up, the card says so");

  answer(true);
  await page.locator("button", { hasText: "Complete and file to Drive" }).click();
  await page.waitForTimeout(1600);

  const t = await page.locator("#root").innerText();
  ok(/Not completed/.test(t), "the failure is reported");
  ok(/still at Final check/.test(t), "…and says the request is untouched");

  const r = (await dump())["requests/PTAA-00001"];
  ok(r.status === "FINAL_CHECK", "the status did not move: " + r.status);
  ok(!r.drive, "no Drive record was written");
  ok(!r.completedAt && !r.completedBy, "no completion stamp was written");

  const notices = Object.values(await dump()).filter(v => v && v.forEmail === "suzanne@gmail.com");
  ok(!notices.some(n => /completed/i.test(n.text || "")),
     "and the agent was NOT told it was completed");
}

group("A name clash stops the completion rather than overwriting");
{
  resetDrive("clash");
  await openReadyRequest(DRIVE_SETTINGS);

  answer(true);
  await page.locator("button", { hasText: "Complete and file to Drive" }).click();
  await page.waitForTimeout(1600);

  const t = await page.locator("#root").innerText();
  ok(/PTAA-00077/.test(t), "the clashing PTAA is named");
  ok(/nothing was overwritten/i.test(t), "…and it says nothing was overwritten");
  ok((await dump())["requests/PTAA-00001"].status === "FINAL_CHECK", "still not completed");
  ok(drive.uploads.length === 0, "and no bytes were sent");
}

group("A successful upload completes the PTAA, in the brief's order");
{
  resetDrive("ok");
  await openReadyRequest(DRIVE_SETTINGS);

  answer(true);
  await page.locator("button", { hasText: "Complete and file to Drive" }).click();
  await page.waitForTimeout(1800);

  const uploaded = drive.uploads[0];
  ok(!!uploaded, "the upload actually happened");
  ok(uploaded && uploaded.appProperties && uploaded.appProperties.anchorPtaa === "PTAA-00001:ptaa",
     "it carried the PTAA id, so Drive can tell whose file it is");
  ok(uploaded && (uploaded.parents || [])[0] === "folder1", "and went into the property's existing folder");
  ok(uploaded && uploaded.name === "PTAA (M ASTRA A-18-09) LOY HUI TING.docx",
     "the filename follows Irfan's pattern: " + (uploaded && uploaded.name));
  ok(uploaded && uploaded.auth === "Bearer stub-drive-token", "it was sent with the Drive permission token");
  ok(uploaded && uploaded.bytes === 10, "the document went with it");

  const st = await dump();
  const r = st["requests/PTAA-00001"];
  ok(r.status === "COMPLETED", "the status moved to Completed");
  ok(r.currentAction === "None", "and nobody has the ball any more");
  ok(r.drive && /^drivefile/.test(r.drive.fileId), "the Drive file id is stored");
  ok(r.drive.webViewLink.includes("drive.google.com"), "…with the link");
  ok(r.completedBy === "boss@gmail.com", "who completed it is recorded");
  ok(!!r.completedAt, "…and when");

  const notices = Object.values(st).filter(v => v && v.forEmail === "suzanne@gmail.com");
  ok(notices.some(n => /completed and filed/i.test(n.text || "")),
     "the Sales Agent was notified (step 8)");

  const events = Object.entries(st)
    .filter(([k]) => k.startsWith("requests/PTAA-00001/activity/"))
    .map(([, v]) => v);
  ok(events.some(e => e.action === "request.completed"), "the completion is in the history");

  const t = await page.locator("#root").innerText();
  ok(/Filed in Google Drive/.test(t), "the request now shows where it went");
  ok(/no V1\/V2\/V3 copies/.test(t), "…and restates §11.5's one-document rule");
}

group("A completed PTAA is closed");
{
  const t = await page.locator("#root").innerText();
  ok(/Completed/.test(t), "it reads as completed");
  const buttons = await page.locator(".card button").allInnerTexts();
  ok(!buttons.some(b => /Complete and file/.test(b)),
     "the Complete action is gone — it cannot be done twice");
  ok(!buttons.some(b => /Edit details/.test(b)) ||
     !(await page.locator("button", { hasText: "Edit details" }).count()),
     "and the request can no longer be edited");
}

group("Global search (phase 13, brief §8.4)");
{
  await scenario({
    docs: { ...WORLD,
      "requests/PTAA-00001": BASE_REQ({}),
      "requests/PTAA-00002": BASE_REQ({
        ptaaId: "PTAA-00002", propertyName: "ONE EQUINE", unitNo: "C-01-03",
        owner: { name: "YEN POH WE", nric: "800101-10-1111", phone: "012-000 0000", address: "KL", email: "" },
      }),
    },
    user: google("boss@gmail.com"), hash: "#/dashboard",
  });
  await page.waitForTimeout(500);

  // The box is in the header, so it is reachable from every screen (§8.4).
  ok(await page.locator("#global-search").count() === 1, "a search box is in the header");
  await page.fill("#global-search", "yen poh");
  await page.press("#global-search", "Enter");
  await page.waitForTimeout(900);

  let t = await page.locator("#root").innerText();
  ok(/1 result/.test(t), "the owner's name finds it: " + (t.match(/\d+ results?/) || [""])[0]);
  ok(/PTAA-00002/.test(t), "…the right one");
  ok(!/PTAA-00001/.test(t.split("result")[1] || ""), "…and not the other one");

  await page.fill("#search-q", "equine c-01-03");
  await page.waitForTimeout(500);
  t = await page.locator("#root").innerText();
  ok(/PTAA-00002/.test(t), "the condo and unit find it too");

  await page.fill("#search-q", "nothing matches this");
  await page.waitForTimeout(500);
  ok(/Nothing matches all of those words/.test(await page.locator("#root").innerText()),
     "a miss says so plainly rather than showing an empty table");
}

group("An agent's search only ever reaches their own requests");
{
  await scenario({
    docs: { ...WORLD,
      "requests/PTAA-00001": BASE_REQ({ agentEmail: "suzanne@gmail.com" }),
      "requests/PTAA-00002": BASE_REQ({
        ptaaId: "PTAA-00002", agentEmail: "ali@gmail.com",
        owner: { name: "SOMEONE ELSE", nric: "800101-10-2222", phone: "012-111 1111", address: "KL", email: "" },
      }),
    },
    user: google("suzanne@gmail.com"), hash: "#/search:someone",
  });
  await page.waitForTimeout(1000);
  const t = await page.locator("#root").innerText();
  ok(!/PTAA-00002/.test(t), "another agent's request is not in the results");
  ok(/Nothing matches|0 results/.test(t), "…it simply is not there to be found");
}

group("Reporting (phase 13)");
{
  await scenario({
    docs: { ...WORLD,
      "requests/PTAA-00001": BASE_REQ({ status: "UNDER_REVIEW", currentAction: "PTAA Admin" }),
      "requests/PTAA-00002": BASE_REQ({ ptaaId: "PTAA-00002", status: "READY_FOR_AGENT", currentAction: "Sales Agent" }),
      "requests/PTAA-00003": BASE_REQ({
        ptaaId: "PTAA-00003", status: "COMPLETED", currentAction: "None",
        completedAt: "@now", completedBy: "boss@gmail.com",
        drive: { fileId: "f1", fileName: "x.docx", webViewLink: "https://drive.google.com/x" },
      }),
    },
    user: google("boss@gmail.com"), hash: "#/reports",
  });
  await page.waitForTimeout(1000);

  const t = await page.locator("#root").innerText();
  ok(/Reporting/.test(t), "the reporting screen renders");
  ok(/With the admin/.test(t) && /With an agent/.test(t),
     "open work is split by who has the ball");
  ok(/Open work by status/.test(t), "and broken down by status");
  ok(!/completed PTAA\(s\) have no Drive link/.test(t),
     "no impossible-state warning when every completed PTAA has its link");
}

group("An agent cannot tick the checklist or touch signatures");
{
  await scenario({ docs: { ...WORLD, "requests/PTAA-00001": BASE_REQ({ status: "NEW", currentAction: "PTAA Admin" }) },
    user: google("suzanne@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(600);
  ok(await page.locator("#cl-ptaa_info").isDisabled(), "the checklist is read-only for an agent");
  const buttons = await page.locator(".card button").allInnerTexts();
  ok(!buttons.some(b => /Record signature|Mark required/.test(b)),
     "and no signature controls are offered");
}

group("An agent asks for a condo that is not on the list (his fifth question)");
{
  await scenario({ docs: { ...SUZANNE, ...PROPS }, user: google("suzanne@gmail.com"), hash: "#/new-request" });
  const t = await page.locator("#root").innerText();
  ok(/Condo not on the list/.test(t), "the form says what to do when the condo is missing");

  answer("D TERRA", "Jalan Kuching, KL", "Owner is signing next week.");
  await page.locator("button", { hasText: "Ask an admin to add it" }).click();
  await page.waitForTimeout(700);

  const st = await dump();
  const asks = Object.entries(st).filter(([k]) => k.startsWith("propertyRequests/"));
  ok(asks.length === 1, "the request is recorded");
  const ask = asks[0][1];
  ok(ask.name === "D TERRA", "with the condo the agent typed");
  ok(ask.address === "Jalan Kuching, KL", "and the address they gave");
  ok(ask.note === "Owner is signing next week.", "and their note");
  ok(ask.requestedBy === "suzanne@gmail.com", "against the agent who asked");
  ok(ask.status === "PENDING", "waiting for an admin");
  ok(Object.keys(st).filter(k => k.startsWith("properties/")).length === 2,
     "asking does NOT create the property — an admin decides the spelling");

  // The admin sees it and approves, correcting the spelling as they go.
  await page.evaluate(() => {
    const d = window.__stub.dump();
    window.__stub.reset();
    for (const [k, v] of Object.entries(d)) if (!k.startsWith("users/")) window.__stub.seed(k, v);
    window.__stub.seed("users/boss@gmail.com",
      { email: "boss@gmail.com", role: "admin", active: true, firstLoginAt: new Date() });
    location.hash = "#/properties";
    window.__stub.setUser({ uid: "uid-boss", email: "boss@gmail.com", displayName: "Boss", photoURL: null });
  });
  await page.waitForTimeout(800);

  const admin = await page.locator("#root").innerText();
  ok(/Requests from agents \(1 waiting\)/.test(admin), "the admin sees it waiting");
  ok(/D TERRA/.test(admin) && /suzanne@gmail\.com/.test(admin), "with the condo and who asked");

  answer("D'TERRA RESIDENCY", "Jalan Kuching, 51200 Kuala Lumpur", "Keith", "012-777 6666");
  await page.locator("button", { hasText: "Add it" }).click();
  await page.waitForTimeout(900);

  const after = await dump();
  const created = Object.entries(after).find(([k, v]) =>
    k.startsWith("properties/") && v.name === "D'TERRA RESIDENCY");
  ok(!!created, "approving is what creates the property");
  ok(created[1].picNickname === "Keith" && created[1].picMobile === "012-777 6666",
     "…with the Owner Group Admin the agreement needs");
  ok(after[asks[0][0]].status === "APPROVED", "the request is marked approved");
  ok(after[asks[0][0]].decidedBy === "boss@gmail.com", "…by the admin who decided");

  const notices = Object.values(after).filter(v => v && v.forEmail === "suzanne@gmail.com");
  ok(notices.some(n => /D'TERRA RESIDENCY/.test(n.text || "")),
     "the agent is told, with the spelling the admin settled on");
}

group("An agent's request for a condo can be declined, with a reason");
{
  await scenario({
    docs: {
      ...BOSS, ...SUZANNE, ...PROPS,
      "propertyRequests/pr1": {
        name: "M ASTRA TOWER", address: "", note: "", status: "PENDING",
        requestedBy: "suzanne@gmail.com", requestedAt: new Date(),
        decidedBy: null, decidedAt: null, decisionNote: null, propertyId: null,
      },
    },
    user: google("boss@gmail.com"), hash: "#/properties",
  });
  await page.waitForTimeout(400);

  answer("Already on the list as M ASTRA.");
  await page.locator("button", { hasText: "Decline" }).click();
  await page.waitForTimeout(800);

  const st = await dump();
  ok(st["propertyRequests/pr1"].status === "REJECTED", "the request is declined");
  ok(/Already on the list/.test(st["propertyRequests/pr1"].decisionNote || ""),
     "with the reason recorded");
  ok(Object.keys(st).filter(k => k.startsWith("properties/")).length === 2,
     "and no property was created");
  const notices = Object.values(st).filter(v => v && v.forEmail === "suzanne@gmail.com");
  ok(notices.some(n => /Already on the list/.test(n.text || "")),
     "the agent is told why, so they can act on it");
}

group("The signature library");
{
  const SIG_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAJUYAwXqBSGSAAAAAElFTkSuQmCC";

  await scenario({
    docs: {
      ...BOSS,
      "signatures/shared:director-benjamin": {
        key: "shared:director-benjamin", kind: "shared", ownerEmail: null,
        label: "Director Benjamin", fileName: "Director_benjamin_sign.png",
        bytes: 100, chunkCount: 1, width: 2, height: 2, isDirector: true,
        uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
      },
      "signatures/shared:director-benjamin/chunks/0": { data: SIG_PNG_B64 },
      "signatures/shared:old-director": {
        key: "shared:old-director", kind: "shared", ownerEmail: null,
        label: "Previous Director", fileName: "old.png",
        bytes: 100, chunkCount: 1, width: 2, height: 2, isDirector: false,
        uploadedBy: "boss@gmail.com", uploadedAt: new Date(),
      },
      "signatures/shared:old-director/chunks/0": { data: SIG_PNG_B64 },
      "signatures/user:suzanne@gmail.com": {
        key: "user:suzanne@gmail.com", kind: "user", ownerEmail: "suzanne@gmail.com",
        label: "CHAN SIEW SIN", fileName: "suzanne.png",
        bytes: 100, chunkCount: 1, width: 2, height: 2, isDirector: false,
        uploadedBy: "suzanne@gmail.com", uploadedAt: new Date(),
      },
      "signatures/user:suzanne@gmail.com/chunks/0": { data: SIG_PNG_B64 },
    },
    user: google("boss@gmail.com"), hash: "#/signatures",
  });
  await page.waitForTimeout(700);

  const t = await page.locator("#root").innerText();
  ok(/Company signatures \(2\)/.test(t), "company signatures are listed");
  ok(/Personal signatures \(1\)/.test(t), "…separately from people's own");
  ok(/Director Benjamin/.test(t), "the Director's is named");
  ok(/storing one signs nothing|Storing one signs nothing/i.test(t),
     "the screen is explicit that storing an image signs nothing");

  answer(true);
  await page.locator("tr", { hasText: "Previous Director" })
            .locator("button", { hasText: "Mark as Director's" }).click();
  await page.waitForTimeout(800);

  const st = await dump();
  ok(st["signatures/shared:old-director"].isDirector === true, "the mark moves");
  ok(st["signatures/shared:director-benjamin"].isDirector === false,
     "…and only ever sits on one, so the Director slot has one obvious default");
}

group("An agent can upload their own signature, and reach nothing else");
{
  await scenario({ docs: { ...SUZANNE }, user: google("suzanne@gmail.com"), hash: "#/profile" });
  await page.waitForTimeout(700);
  const t = await page.locator("#root").innerText();
  ok(/My signature/.test(t), "the profile offers a signature upload");
  ok(/Nothing is placed without/.test(t),
     "…and says an admin still has to choose it on the request");

  await page.setInputFiles('input[type="file"][accept="image/png,image/*"]',
    { name: "sig.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.waitForTimeout(1200);

  const st = await dump();
  const mine = st["signatures/user:suzanne@gmail.com"];
  ok(!!mine, "it is stored under their own address, not a shared key");
  ok(mine.kind === "user" && mine.ownerEmail === "suzanne@gmail.com", "…owned by them");
  ok(mine.isDirector === false, "…and cannot claim to be the Director's");
  ok(!!st["signatures/user:suzanne@gmail.com/chunks/0"], "the image bytes are stored");

  await page.evaluate(() => { location.hash = "#/signatures"; });
  await page.waitForTimeout(600);
  ok(/Administrators only/.test(await page.locator("#root").innerText()),
     "the signature library itself is admin-only");
}

// ---------------------------------------------------------------------------
group("Console");
{
  const noise = /favicon|net::ERR|Failed to load resource/i;
  const real = consoleErrors.filter(e => !noise.test(e));
  ok(real.length === 0, "no unexpected console errors across the whole run" +
     (real.length ? "\n      " + real.slice(0, 8).join("\n      ") : ""));
}

// ---------------------------------------------------------------------------
group("Screenshots");
{
  await scenario({ user: null });
  await page.screenshot({ path: "shot-1-signin.png" });

  await scenario({ docs: {}, user: google("irfankimie321@gmail.com") });
  await page.screenshot({ path: "shot-2-denied.png" });

  await scenario({
    docs: { "users/suzanne@gmail.com": { email: "suzanne@gmail.com", role: "agent", active: true } },
    user: google("suzanne@gmail.com"),
  });
  await page.fill("#pf-fullName", "CHAN SIEW SIN");
  await page.fill("#pf-nric", "000908140426");
  await page.fill("#pf-phone", "+60194009082");
  await page.fill("#pf-nickname", "Suzanne");
  await page.waitForTimeout(200);
  await page.screenshot({ path: "shot-3-profile.png", fullPage: true });

  await scenario({ docs: ADMIN_DOCS, user: google("boss@gmail.com"), hash: "#/dashboard" });
  await page.screenshot({ path: "shot-4-admin.png", fullPage: true });

  await scenario({ docs: ADMIN_DOCS, user: google("boss@gmail.com"), hash: "#/users" });
  await page.screenshot({ path: "shot-5-users.png", fullPage: true });

  const DEMO = {
    ...BOSS, ...SUZANNE, ...OTHER_AGENT, ...PROPS,
    "requests/PTAA-00001": { ptaaId: "PTAA-00001", type: "NEW_PTAA", status: "NEW",
      currentAction: "PTAA Admin", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
      owner: { name: "LOY HUI TING", nric: "880214-10-5566", phone: "012-345 6789",
               address: "12 Jalan Ampang, 50450 Kuala Lumpur", email: "" },
      propertyName: "M ASTRA", propertyAddress: "Jalan Ampang, KL", unitNo: "A-18-09",
      ptaaType: "Partition",
      tenancy: { initialTermMonths: 36, commencementDate: "2026-09-01", expiryDate: "2029-08-31" },
      financial: { monthlyAdminFeePercent: 10, renovationCost: 12000 },
      specialTerms: ["Owner keeps the built-in wardrobe."], notes: "From WhatsApp, 26 Aug.",
      attachmentCount: 0, dueDate: "2026-08-31", updatedAt: "@now" },
    "requests/PTAA-00002": { ptaaId: "PTAA-00002", type: "NEW_PTAA", status: "READY_FOR_AGENT",
      currentAction: "Sales Agent", agentEmail: "ali@gmail.com", agentSnapshot: AGENT_PROFILE,
      owner: { name: "SITI BINTI OMAR" }, propertyName: "THE ERA", unitNo: "B-07-11",
      ptaaType: "WUR", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
    "requests/PTAA-00003": { ptaaId: "PTAA-00003", type: "NEW_PTAA", status: "ON_HOLD",
      previousStatus: "UNDER_REVIEW", holdReason: "Waiting for Owner",
      currentAction: "None", agentEmail: "suzanne@gmail.com", agentSnapshot: AGENT_PROFILE,
      owner: { name: "TAN WEI MING" }, propertyName: "M ASTRA", unitNo: "C-03-02",
      ptaaType: "Partition", tenancy: {}, financial: {}, specialTerms: [], updatedAt: "@now" },
  };

  await scenario({ docs: DEMO, user: google("boss@gmail.com"), hash: "#/dashboard" });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot-6-admin-dashboard.png", fullPage: true });

  await scenario({ docs: DEMO, user: google("boss@gmail.com"), hash: "#/requests" });
  await page.screenshot({ path: "shot-7-queue.png", fullPage: true });

  await scenario({ docs: DEMO, user: google("boss@gmail.com"), hash: "#/request:PTAA-00001" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "shot-8-request-detail.png", fullPage: true });

  await scenario({ docs: { ...SUZANNE, ...PROPS }, user: google("suzanne@gmail.com"), hash: "#/new-request" });
  await fillNewRequest();
  await page.screenshot({ path: "shot-9-new-request.png", fullPage: true });

  await scenario({
    docs: { ...BOSS, ...PROPS,
      "templates/p1": { propertyId: "p1", propertyName: "M ASTRA", fileName: "M-ASTRA-PTAA-2026.docx",
                        bytes: 96_300, chunkCount: 1, version: 2,
                        uploadedBy: "boss@gmail.com", uploadedAt: "@now" } },
    user: google("boss@gmail.com"), hash: "#/templates",
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot-10-templates.png", fullPage: true });

  console.log("  ✓ ten screenshots written");
}

await browser.close();
console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails ? 1 : 0);
