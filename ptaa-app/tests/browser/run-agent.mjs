// ---------------------------------------------------------------------------
// Browser test: Sales Agents in the solo workflow.
//
//   agent saves a draft → continues it → submits (no tenancy, no special terms)
//   → admin sets the tenancy period (expiry fills itself) → drafts the PTAA
//   (empty utility rows print NIL) → sends a finished PDF → agent downloads it.
//
//   QUOTE_PDF=… TEMPLATE_DOCX=… FINAL_PDF=… node tests/browser/run-agent.mjs
// ---------------------------------------------------------------------------

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PORT = process.env.PORT || 8123;
const BASE = `http://localhost:${PORT}/tests/browser/harness-solo.html`;
const QUOTE_PDF = process.env.QUOTE_PDF;
const TEMPLATE_DOCX = process.env.TEMPLATE_DOCX;
const FINAL_PDF = process.env.FINAL_PDF;
const OUT = process.env.OUT_DIR || "/tmp/agent-test";
mkdirSync(OUT, { recursive: true });
if (!QUOTE_PDF || !TEMPLATE_DOCX || !FINAL_PDF) { console.log("Set QUOTE_PDF, TEMPLATE_DOCX and FINAL_PDF."); process.exit(2); }

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) fails++; };
const group = (t) => console.log("\n" + t);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));
page.on("dialog", d => d.accept());

const google = (email, name) => ({ uid: "uid-" + email, email, displayName: name, photoURL: null });
const ADMIN = "syasya.blankco@gmail.com";
const AGENT = "terence.agent@gmail.com";

function templateDocs() {
  const b64 = readFileSync(TEMPLATE_DOCX).toString("base64");
  const docs = {}; const CH = 250_000; let n = 0;
  // The one shared template, used for every condo.
  for (let i = 0; i < b64.length; i += CH) docs[`templates/default/chunks/${n++}`] = { data: b64.slice(i, i + CH) };
  docs["templates/default"] = { propertyId: "default", propertyName: "All condos", fileName: "TEMPLATE_PTAA_v5.docx",
    bytes: readFileSync(TEMPLATE_DOCX).length, chunkCount: n, placeholders: [], loops: [], version: 1, uploadedAt: "@now" };
  return docs;
}

const DOCS = {
  [`users/${ADMIN}`]: { email: ADMIN, role: "admin", active: true, invitedAt: "@now", firstLoginAt: "@now",
    profile: { fullName: "AFIQAH SYASYA BINTI ROSLI", nric: "020222-03-1258", phone: "011-6955 1233", nickname: "Arsyas", version: 1 } },
  [`users/${AGENT}`]: { email: AGENT, role: "agent", active: true, invitedAt: "@now", firstLoginAt: "@now",
    profile: { fullName: "CHIN HAN TUNG", nric: "990115-43-5553", phone: "018-356 6395", nickname: "Terence", version: 1 } },
  "properties/p1": { name: "SUNWAY JERNIH", nameLower: "sunway jernih", address: "Jalan Jernih, Kuala Lumpur", active: true,
                     picNickname: "KEITH", picMobile: "012-499 4195" },
  "settings/app": { ptaaFolderId: "ROOT1", ptaaFolderName: "PTAA", ptaaSubfolder: true,
                    invoiceRootId: "INV1", invoiceRootName: "BLANK RENO INV", invoiceMonthFolders: true,
                    invoiceMonthPattern: "MMM YY INV", payment1: 1000, payment2: 9000, payment3: 0,
                    focItems: ["High Security Smart Lock", "Smart Lock GateWay System"] },
  "counters/invoices": { last: "BLKINV-2609033" },
};

const text = () => page.locator("#root").innerText();
const dump = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__stub.dump())));
const as = async (email, name, hash) => {
  await page.evaluate(([u, hash]) => { location.hash = hash; window.__stub.setUser(u); }, [google(email, name), hash]);
  await page.waitForTimeout(700);
};
const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForTimeout(700); };
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
await page.evaluate((docs) => {
  window.__stub.reset();
  for (const [path, data] of Object.entries(docs)) {
    const d = { ...data };
    for (const k of ["invitedAt", "firstLoginAt", "uploadedAt"]) if (d[k] === "@now") d[k] = new Date();
    window.__stub.seed(path, d);
  }
}, { ...DOCS, ...templateDocs() });

// ---------------------------------------------------------------------------
group("Agent — the shell");
await as(AGENT, "Terence", "#/dashboard");
{
  const nav = await page.locator("nav.nav").innerText();
  ok(/My PTAAs/.test(nav) && /New PTAA/.test(nav) && /My profile/.test(nav), "agent nav: My PTAAs, New PTAA, My profile");
  ok(!/Templates|Agents|Settings|Sign PDF|Condos/.test(nav), "no admin screens in the agent's nav");
  ok(/My PTAAs/.test(await text()), "the agent lands on My PTAAs");
}

// ---------------------------------------------------------------------------
group("I/C — both sides in one file");
await go("#/new-request");
{
  // Pictures made in the page: light-blue "cards" with dark text lines.
  const makeImage = (layout) => page.evaluate(async (layout) => {
    const c = document.createElement("canvas");
    const cards = layout === "stacked" ? [[60, 40], [60, 360]] : layout === "side" ? [[30, 80], [420, 80]] : [[80, 60]];
    c.width = layout === "side" ? 800 : 520; c.height = layout === "stacked" ? 640 : layout === "side" ? 380 : 380;
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
    cards.forEach(([cx, cy], k) => {
      x.fillStyle = "#c8d7e8"; x.fillRect(cx, cy, 350, 220);
      x.fillStyle = "#223"; for (let i = 0; i < 8; i++) x.fillRect(cx + 20, cy + 20 + i * 24, k ? 150 : 250, 6);
    });
    const b = await new Promise(r => c.toBlob(r, "image/png"));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, layout).then(a => Buffer.from(a));
  const both = page.locator('.slot input[data-both]');
  const sizes = () => page.evaluate(() => [...document.querySelectorAll(".slot")].slice(0, 2).map(sl => {
    const img = sl.querySelector(".thumb img"); return img ? [img.naturalWidth, img.naturalHeight] : null; }));
  const heads = () => page.evaluate(() => [...document.querySelectorAll(".slot .slot-head")].slice(0, 2).map(e => e.innerText));

  ok(/Both sides in one file/.test(await text()), "the front slot offers “Both sides in one file”");
  await both.setInputFiles({ name: "ic-both.png", mimeType: "image/png", buffer: await makeImage("stacked") });
  await page.waitForTimeout(1500);
  let sz = await sizes();
  ok(sz[0] && sz[1], "one picture filled both the front and the back");
  ok(sz[0] && sz[0][0] > sz[0][1] && sz[1][0] > sz[1][1], `each is a card, wider than tall (${JSON.stringify(sz)})`);
  ok(sz[0] && Math.abs(sz[0][0] / sz[0][1] - 350 / 220) < 0.15, "the front was trimmed to the card's edges");

  await page.locator("button", { hasText: "Swap front and back" }).click();
  await page.waitForTimeout(400);
  const swapped = await sizes();
  ok(JSON.stringify(swapped) === JSON.stringify([sz[1], sz[0]]) || JSON.stringify(sz[0]) === JSON.stringify(sz[1]),
     "Swap exchanges them");

  await both.setInputFiles({ name: "ic-side.png", mimeType: "image/png", buffer: await makeImage("side") });
  await page.waitForTimeout(1500);
  sz = await sizes();
  ok(sz[0] && sz[1] && sz[0][0] > sz[0][1], "side-by-side cards are split too");

  await both.setInputFiles({ name: "ic-one.png", mimeType: "image/png", buffer: await makeImage("one") });
  await page.waitForTimeout(1500);
  sz = await sizes();
  const hd = await heads();
  ok(sz[0] && !sz[1], "a picture with one card is not cut up");
  ok(/In the front picture/.test(hd[1]), "the back says it is in the front picture");

  // A two-page PDF: page 1 the front, page 2 the back.
  const pdf = await page.evaluate(async () => {
    const { loadPdfJoiner } = await import("/js/finalpdf.js");
    const PDFLib = await loadPdfJoiner();
    const doc = await PDFLib.PDFDocument.create();
    for (const shade of [0.8, 0.6]) {
      const p = doc.addPage([595, 842]);
      p.drawRectangle({ x: 120, y: 500, width: 340, height: 214, color: PDFLib.rgb(shade, shade, 0.9) });
    }
    return Array.from(await doc.save());
  }).then(a => Buffer.from(a));
  await both.setInputFiles({ name: "ic.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.waitForTimeout(2500);
  sz = await sizes();
  ok(sz[0] && sz[1] && sz[0][0] > sz[0][1] && sz[1][0] > sz[1][1], `pages 1 and 2 of a PDF become front and back, trimmed (${JSON.stringify(sz)})`);
}

// ---------------------------------------------------------------------------
group("Agent — New PTAA without the tenancy period, saved as a draft");
await go("#/dashboard");
await go("#/new-request");
await go("#/new-request");
{
  const t = await text();
  ok(!/Tenancy period/.test(t) && (await page.locator("#nr-tenancy-commencementDate").count()) === 0,
     "no tenancy period on the agent's form");
  ok(!/Special terms/.test(t), "no special terms on the agent's form");
  ok(!/Your details, recorded/.test(t), "no Sales Agent details block");
  ok(/Save draft/.test(t), "there is a Save draft button");

  await page.fill("#nr-owner-name", "Siti Amira Binti Mat Hussin");
  await page.fill("#nr-owner-nric", "910218-03-5058");
  await page.locator('.slot input[type="file"]:not([capture]):not([data-both])').nth(0)
    .setInputFiles({ name: "ic-front.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.waitForTimeout(500);
  await page.locator("button", { hasText: "Save draft" }).click();
  await page.waitForTimeout(800);
  const st = await dump();
  const draftKey = Object.keys(st).find(k => /^drafts\/[^/]+$/.test(k));
  ok(!!draftKey, "a draft was stored");
  const draft = st[draftKey];
  ok(draft && draft.agentEmail === AGENT && draft.form.owner.name === "Siti Amira Binti Mat Hussin", "the draft holds what was typed, under the agent");
  ok(Object.keys(st).filter(k => k.startsWith(draftKey + "/files/")).length === 1, "the I/C photo was kept with the draft");
  ok(!Object.keys(st).some(k => /^requests\//.test(k)), "no PTAA was created — nothing reaches the admin");
  ok(/new-request:D/.test(await page.evaluate(() => location.hash)), "the address now points at the draft");

  // Save again: the photo is not duplicated.
  await page.fill("#nr-owner-phone", "012-345 6789");
  await page.locator("button", { hasText: "Save draft" }).click();
  await page.waitForTimeout(800);
  const st2 = await dump();
  ok(Object.keys(st2).filter(k => /^drafts\/[^/]+$/.test(k)).length === 1, "saving again updates the same draft");
  ok(Object.keys(st2).filter(k => k.startsWith(draftKey + "/files/")).length === 1, "…without storing the photo twice");
}

group("Agent — the draft is listed and can be continued");
await go("#/dashboard");
{
  const t = await text();
  ok(/Drafts \(1\)/.test(t) && /SITI AMIRA BINTI MAT HUSSIN/.test(t), "My PTAAs lists the draft by owner");
  await page.locator("button", { hasText: "Continue" }).click();
  await page.waitForTimeout(900);
  ok(await page.inputValue("#nr-owner-name") === "Siti Amira Binti Mat Hussin", "the owner's name is back in the form");
  ok(await page.inputValue("#nr-owner-phone") === "012-345 6789", "…and the phone");
  ok((await page.locator(".slot .thumb").count()) === 1, "…and the I/C photo");
  ok(/Continuing a draft/.test(await text()), "it says it is continuing a draft");
}

group("Agent — finish and submit");
{
  await page.fill("#nr-owner-address", "No 1, Jalan Test, 58200 Kuala Lumpur");
  await page.fill("#nr-owner-bankName", "MALAYAN BANKING BERHAD (MAYBANK)");
  await page.fill("#nr-owner-accountNumber", "114012345678");
  await page.selectOption("#nr-propertyId", "p1");
  await page.fill("#nr-unitNo", "b-38-12");
  await page.selectOption("#nr-ptaaType", "Partition");
  await page.fill("#nr-propertySize", "1151");
  await page.fill("#nr-financial-monthlyAdminFeePercent", "10");
  await page.locator("button", { hasText: "Tenant pays" }).click();
  await page.locator('.slot input[type="file"]:not([capture]):not([data-both])').nth(1)
    .setInputFiles({ name: "ic-back.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.locator('.slot input[type="file"][accept*="pdf"]:not([data-both])').setInputFiles(QUOTE_PDF);
  await page.waitForFunction(() => /priced items read/.test(document.body.innerText), null, { timeout: 30000 });
  ok(true, "the quotation's items are read for the agent too");
  const submit = page.locator("button", { hasText: "Submit request" });
  ok(!(await submit.isDisabled()), "Submit is allowed without the tenancy period");
  await submit.click();
  await page.waitForFunction(() => location.hash.startsWith("#/request:"), null, { timeout: 20000 });
  await page.waitForTimeout(900);
  const st = await dump();
  const r = st["requests/PTAA-00001"];
  ok(!!r && r.agentEmail === AGENT && r.agentSnapshot.fullName === "CHIN HAN TUNG", "PTAA-00001 submitted as the agent, with their profile");
  ok(r.tenancy.commencementDate === "" && r.tenancy.initialTermMonths === null, "no tenancy period yet");
  ok(r.owner.name === "SITI AMIRA BINTI MAT HUSSIN", "owner's name stored in capitals");
  ok(r.quotation && r.quotation.grandTotal === 41433, "the quotation's items were stored for the invoice");
  ok(!Object.keys(st).some(k => /^drafts\//.test(k)), "the draft is gone once submitted");
}

group("Agent — the PTAA shows only what they need");
{
  const t = await page.locator("main.main").innerText();   // the page, not the top bar's role badge
  ok(/Submitted/.test(t), "status: Submitted");
  for (const hidden of ["Special terms", "Sales Agent", "PTAA Admin", "Signatures", "Final checklist", "History", "Current action"]) {
    ok(!new RegExp(hidden).test(t), `no “${hidden}”`);
  }
  ok(/Set by the admin/.test(t), "the tenancy says it is set by the admin");
  ok(/Edit details/.test(t), "they may still edit it before the admin starts");
  await page.screenshot({ path: `${OUT}/agent-1-request.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
group("Admin — sees it, sets the tenancy period, expiry fills itself");
await as(ADMIN, "Syasya", "#/dashboard");
{
  const t = await text();
  ok(/New from Sales Agents \(1\)/.test(t) && /Not set/.test(t), "the dashboard shows the new PTAA with the tenancy not set");
  await go("#/request:PTAA-00001");
  const d = await text();
  ok(/Tenancy period not set yet/.test(d), "the PTAA says the tenancy period is missing");
  ok(await page.locator("button", { hasText: "Draft the PTAA (Word)" }).isDisabled(), "drafting waits for the tenancy period");
  await page.locator("button", { hasText: "Set the tenancy period" }).click();
  await page.waitForTimeout(400);
  ok(/Tenancy period/.test(await text()) && (await page.locator("#ed-tenancy-commencementDate").count()) === 1, "the admin's form has the tenancy period");
  await page.fill("#ed-tenancy-initialTermMonths", "36");
  await page.fill("#ed-tenancy-commencementDate", "2026-10-01");
  ok(await page.inputValue("#ed-tenancy-expiryDate") === "2029-09-30", "expiry fills in: 1 Oct 2026 + 36 months → 30 Sep 2029");
  await page.fill("#ed-tenancy-commencementDate", "2026-11-15");
  ok(await page.inputValue("#ed-tenancy-expiryDate") === "2029-11-14", "and follows a changed commencement date → 14 Nov 2029");
  await page.fill("#ed-tenancy-initialTermMonths", "12");
  ok(await page.inputValue("#ed-tenancy-expiryDate") === "2027-11-14", "and a changed term → 14 Nov 2027");
  await page.fill("#ed-tenancy-expiryDate", "2027-12-31");
  await page.fill("#ed-tenancy-commencementDate", "2026-11-16");
  ok(await page.inputValue("#ed-tenancy-expiryDate") === "2027-12-31", "an expiry typed by hand is left alone");
  await page.fill("#ed-tenancy-expiryDate", "");
  await page.fill("#ed-tenancy-commencementDate", "2026-11-15");
  ok(await page.inputValue("#ed-tenancy-expiryDate") === "2027-11-14", "clearing it goes back to automatic");
  await page.locator("button", { hasText: "Save changes" }).click();
  await page.waitForTimeout(900);
  const st = await dump();
  const t2 = st["requests/PTAA-00001"].tenancy;
  ok(t2.initialTermMonths === 12 && t2.commencementDate === "2026-11-15" && t2.expiryDate === "2027-11-14", "the tenancy period is saved");
  ok(!/Tenancy period not set yet/.test(await text()), "the warning is gone");
}

group("Admin — drafts the PTAA; empty utility rows print NIL");
{
  const dl = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Draft the PTAA (Word)" }).click();
  const docx = await dl;
  await docx.saveAs(`${OUT}/ptaa.docx`);
  const xml = execFileSync("unzip", ["-p", `${OUT}/ptaa.docx`, "word/document.xml"]).toString().replace(/<[^>]+>/g, "");
  ok(/NIL/.test(xml) && !/\bNone\b/.test(xml), "the Owner's utilities row reads NIL");
  ok(/SITI AMIRA BINTI MAT HUSSIN/.test(xml), "the owner is in capitals");
  ok((xml.match(/B-38-12, SUNWAY JERNIH, Jalan Jernih, Kuala Lumpur/g) || []).length >= 2,
     "the full address (unit, condo, address) is on the front page and in Schedule 1 item 2");
  ok(/15th November 2026/i.test(xml) || /15th NOVEMBER 2026/.test(xml), "the commencement date is in the agreement");
  await page.waitForTimeout(900);
}

group("Admin — sends the finished PDF to the Sales Agent");
{
  ok(/7 · Finished PDF for the Sales Agent/.test(await text()), "step 7 is there");
  ok(/Nothing sent to Terence yet/.test(await text()), "nothing sent yet");
  await page.locator('input[type="file"][accept*="pdf"]').last().setInputFiles(FINAL_PDF);
  await page.waitForFunction(() => /Shared/.test(document.body.innerText), null, { timeout: 30000 });
  const st = await dump();
  const fp = st["requests/PTAA-00001"].finalPdf;
  ok(fp && fp.bytes === readFileSync(FINAL_PDF).length && fp.chunkCount > 1,
     `the PDF is stored (${fp && fp.chunkCount} parts)`);
  const note = Object.entries(st).find(([k, v]) => k.startsWith("notifications/") && v.forEmail === AGENT && v.event === "final_pdf");
  ok(!!note, "the agent is notified");
  await page.screenshot({ path: `${OUT}/agent-2-admin.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
group("Agent — downloads the finished PDF, and only that");
await as(AGENT, "Terence", "#/dashboard");
{
  const t = await text();
  ok(/Ready to download \(1\)/.test(t), "it shows under Ready to download");
  const dl = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("button", { hasText: "Download PDF" }).click();
  const f = await dl;
  await f.saveAs(`${OUT}/agent.pdf`);
  ok(readFileSync(`${OUT}/agent.pdf`).equals(readFileSync(FINAL_PDF)), "the downloaded PDF is exactly the one sent");
  ok(/\.pdf$/.test(f.suggestedFilename()), "named " + f.suggestedFilename());

  await go("#/request:PTAA-00001");
  const d = await text();
  ok(/Ready to download/.test(d) && /Download the PTAA \(PDF\)/.test(d), "the PTAA page offers the PDF");
  ok(!/Edit details/.test(d), "no more editing once the admin has started");
  ok((await page.locator("button", { hasText: /Word|Excel|invoice/i }).count()) === 0, "no Word or Excel downloads");
  await page.screenshot({ path: `${OUT}/agent-3-ready.png`, fullPage: true });
}

group("Console");
ok(consoleErrors.length === 0, "no console errors" + (consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""));

await browser.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
