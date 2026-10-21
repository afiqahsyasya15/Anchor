// ---------------------------------------------------------------------------
// End-to-end checks for the SOLO workflow (config.js → workflow.solo = true):
// start a PTAA with the agent picked from a list, read the items out of a real
// quotation PDF, draft the Word agreement and the Excel invoice, upload the
// confirmed copies, and file both to a (fake) Google Drive.
//
//   python3 -m http.server 8123        # from the project root, in another shell
//   QUOTE_PDF=… TEMPLATE_DOCX=… node tests/browser/run-solo.mjs
//
// QUOTE_PDF is a BLANKCO quotation PDF, TEMPLATE_DOCX a condo's PTAA template.
// Neither ships with the app (they are the office's documents), so the test
// is told where they are.
// ---------------------------------------------------------------------------
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let PDFLib = null;
try { PDFLib = require(process.env.PDF_LIB || "pdf-lib"); } catch { /* the PDF step is skipped */ }

async function makePdf(pages) {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([595, 842]).drawText(text, { x: 60, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}
const PTAA_PDF = PDFLib ? await makePdf(["Agreement page 1", "Agreement page 2",
  "APPENDIX A Renovation Cost Details / Invoice", "APPENDIX B SPECIAL TERMS"]) : null;
const INVOICE_PDF = PDFLib ? await makePdf(["INVOICE page 1", "INVOICE page 2"]) : null;

const PORT = process.env.PORT || 8123;
const BASE = `http://localhost:${PORT}/tests/browser/harness-solo.html`;
const QUOTE_PDF = process.env.QUOTE_PDF;
const TEMPLATE_DOCX = process.env.TEMPLATE_DOCX;
const AGENTS_CSV = process.env.AGENTS_CSV || null;
const OUT = process.env.OUT_DIR || "/tmp/solo-test";
mkdirSync(OUT, { recursive: true });

if (!QUOTE_PDF || !TEMPLATE_DOCX) {
  console.log("Set QUOTE_PDF and TEMPLATE_DOCX."); process.exit(2);
}

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) fails++; };
const group = (t) => console.log("\n" + t);

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", e => consoleErrors.push("PAGEERROR: " + e.message));

const dialogAnswers = [];
page.on("dialog", async (d) => {
  if (!dialogAnswers.length) { await d.accept(); return; }
  const next = dialogAnswers.shift();
  if (next === false) await d.dismiss(); else await d.accept(typeof next === "string" ? next : undefined);
});

// --- a fake Google Drive ------------------------------------------------------
const drive = { files: new Map(), pending: new Map(), calls: [], failNext: null };
drive.files.set("ROOT123456789", { id: "ROOT123456789", name: "PTAA Filing", mimeType: "application/vnd.google-apps.folder", parents: [] });
drive.files.set("INVFOLDER9999", { id: "INVFOLDER9999", name: "INVOICE", mimeType: "application/vnd.google-apps.folder", parents: [] });
drive.files.set("SEPFOLDER", { id: "SEPFOLDER", name: "SEP 26 INV", mimeType: "application/vnd.google-apps.folder", parents: ["INVFOLDER9999"] });
let seq = 0;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Content-Type, X-Upload-Content-Length",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  "Access-Control-Expose-Headers": "Location",
};
const json = (route, body, status = 200, extra = {}) =>
  route.fulfill({ status, headers: { ...CORS, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });

await context.route("https://www.googleapis.com/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  drive.calls.push(`${method} ${url.pathname}`);
  if (req.headers()["authorization"] !== "Bearer stub-drive-token") return json(route, { error: { message: "no token" } }, 401);

  if (drive.failNext && method === "PUT") {
    const f = drive.failNext; drive.failNext = null;
    return json(route, { error: { message: f } }, 500);
  }

  // export as PDF
  const ex = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
  if (ex && method === "GET") {
    const f = drive.files.get(ex[1]);
    const pdf = f && f.mimeType === "application/vnd.google-apps.document" ? PTAA_PDF
              : f && f.mimeType === "application/vnd.google-apps.spreadsheet" ? INVOICE_PDF : null;
    if (!pdf) return json(route, { error: { message: "Export only supports Docs Editors files." } }, 403);
    return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/pdf" }, body: pdf });
  }
  // metadata
  const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (m && method === "PATCH") {
    const f = drive.files.get(m[1]); Object.assign(f, JSON.parse(req.postData() || "{}"));
    return json(route, { id: m[1] });
  }
  if (m && method === "GET") {
    const f = drive.files.get(m[1]);
    return f ? json(route, { ...f, trashed: false }) : json(route, { error: { message: "File not found" } }, 404);
  }
  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const q = url.searchParams.get("q");
    const parent = /'([^']+)' in parents/.exec(q)[1];
    const foldersOnly = /mimeType = 'application\/vnd.google-apps.folder'/.test(q);
    const filesOnly = /mimeType != /.test(q);
    const files = [...drive.files.values()].filter(f => (f.parents || []).includes(parent))
      .filter(f => !foldersOnly || f.mimeType === "application/vnd.google-apps.folder")
      .filter(f => !filesOnly || f.mimeType !== "application/vnd.google-apps.folder");
    return json(route, { files });
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const body = JSON.parse(req.postData());
    const id = "F" + (++seq);
    drive.files.set(id, { id, ...body });
    return json(route, { id, name: body.name });
  }
  // uploads
  if (url.pathname === "/upload/drive/v3/files" && url.searchParams.get("uploadType") === "multipart" && method === "POST") {
    const raw = req.postDataBuffer().toString("latin1");
    const meta = JSON.parse(/\{[^\r\n]*\}/.exec(raw)[0]);
    const id = "F" + (++seq);
    drive.files.set(id, { id, ...meta, parents: meta.parents || ["MYDRIVE"] });
    return json(route, { id, name: meta.name });
  }
  if (url.pathname.startsWith("/upload/drive/v3/files") && url.searchParams.get("uploadType") === "resumable") {
    if (url.searchParams.get("upload_id")) {
      const p = drive.pending.get(url.searchParams.get("upload_id"));
      const bytes = req.postDataBuffer();
      const id = p.fileId || ("F" + (++seq));
      const prev = drive.files.get(id) || {};
      drive.files.set(id, { ...prev, ...p.meta, id, size: bytes.length, content: bytes,
                            webViewLink: `https://drive.google.com/file/d/${id}/view` });
      const f = drive.files.get(id);
      return json(route, { id, name: f.name, webViewLink: f.webViewLink });
    }
    const uploadId = "U" + (++seq);
    const fileId = (/\/upload\/drive\/v3\/files\/([^/?]+)/.exec(url.pathname) || [])[1] || null;
    drive.pending.set(uploadId, { meta: JSON.parse(req.postData() || "{}"), fileId });
    return json(route, {}, 200, { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}` });
  }
  return json(route, { error: { message: "unhandled " + url.pathname } }, 400);
});

// The Sheets export link (no gridlines) — answered like Google does.
const sheetExports = [];
await context.route("https://docs.google.com/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  const url = new URL(req.url());
  sheetExports.push(url.searchParams.toString());
  if (req.headers()["authorization"] !== "Bearer stub-drive-token") return route.fulfill({ status: 401, headers: CORS, body: "no" });
  const id = (/\/spreadsheets\/d\/([^/]+)\/export/.exec(url.pathname) || [])[1];
  const f = drive.files.get(id);
  if (!f || f.mimeType !== "application/vnd.google-apps.spreadsheet") return route.fulfill({ status: 404, headers: CORS, body: "no" });
  return route.fulfill({ status: 200, headers: { ...CORS, "Content-Type": "application/pdf" }, body: INVOICE_PDF });
});

// --- helpers --------------------------------------------------------------------
const google = (email) => ({ uid: "uid-" + email, email, displayName: "Syasya", photoURL: null });
const ADMIN = "afiqahsyasya15@gmail.com";

function templateDocs() {
  const b64 = readFileSync(TEMPLATE_DOCX).toString("base64");
  const docs = {};
  const CH = 250_000; let n = 0;
  for (let i = 0; i < b64.length; i += CH) docs[`templates/p1/chunks/${n++}`] = { data: b64.slice(i, i + CH) };
  docs["templates/p1"] = { propertyId: "p1", propertyName: "SUNWAY JERNIH", fileName: "TEMPLATE_D_TERRA_v3.docx",
    bytes: readFileSync(TEMPLATE_DOCX).length, chunkCount: n, placeholders: [], loops: [], version: 1, uploadedAt: "@now" };
  return docs;
}

const BASE_DOCS = {
  [`users/${ADMIN}`]: { email: ADMIN, role: "admin", active: true, invitedAt: "@now", firstLoginAt: "@now",
    profile: { fullName: "NUR AFIQAH SYASYA", nric: "990101-14-5678", phone: "012-345 6789", nickname: "Syasya", version: 1 } },
  "properties/p1": { name: "SUNWAY JERNIH", nameLower: "sunway jernih", address: "Jalan Jernih, Kuala Lumpur", active: true,
                     picNickname: "KEITH", picMobile: "012-499 4195" },
  "agents/a1": { fullName: "CHIN HAN TUNG", nickname: "Terence", nric: "990115-43-5553", phone: "018-356 6395", email: "", active: true },
  "agents/a2": { fullName: "", nickname: "YM", nric: "", phone: "012-290 7649", email: "wyming94@gmail.com", active: true },
  "settings/app": { ptaaFolderId: "ROOT123456789", ptaaFolderName: "PTAA Filing", ptaaSubfolder: true,
                    invoiceRootId: "INVFOLDER9999", invoiceRootName: "INVOICE", invoiceSubfolder: false,
                    invoiceMonthFolders: true, invoiceMonthPattern: "MMM YY INV",
                    payment1: 1000, payment2: 9000, payment3: 0, resetInvoiceMonthly: false,
                    focItems: ["High Security Smart Lock", "Smart Lock GateWay System"] },
  "counters/invoices": { last: "BLKINV-2609033" },
};

async function scenario({ docs = {}, user = null, hash = "#/dashboard", wait = 600 }) {
  await page.evaluate(([docs, user, hash]) => {
    window.__stub.reset();
    for (const [path, data] of Object.entries(docs)) {
      const d = { ...data };
      for (const k of ["invitedAt", "firstLoginAt", "uploadedAt", "createdAt", "updatedAt"]) if (d[k] === "@now") d[k] = new Date();
      window.__stub.seed(path, d);
    }
    location.hash = hash;
    window.__stub.setUser(user);
  }, [docs, user, hash]);
  await page.waitForTimeout(wait);
  return page.locator("#root").innerText();
}
const dump = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__stub.dump())));
const text = () => page.locator("#root").innerText();
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

await page.goto(BASE, { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

// ---------------------------------------------------------------------------
group("Solo shell");
{
  const t = await scenario({ docs: { ...BASE_DOCS, ...templateDocs() }, user: google(ADMIN) });
  ok(/PTAAs/.test(t) && /New PTAA/.test(t), "the dashboard is the PTAA list with a New PTAA button");
  const nav = await page.locator("nav.nav").innerText();
  ok(/Agents/.test(nav) && /Settings/.test(nav) && /Condos/.test(nav), "nav has Agents, Settings and Condos");
  ok(!/Notifications/.test(nav) && !/Reporting/.test(nav), "no team-only screens in the nav");
  ok((await page.locator(".bell").count()) === 0, "no notification bell");
  await page.screenshot({ path: `${OUT}/solo-1-dashboard.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
group("New PTAA — agent from the list, quotation read automatically");
{
  await page.evaluate(() => { location.hash = "#/new-request"; });
  await page.waitForTimeout(500);
  let t = await text();
  ok(/Sales Agent/.test(t) && /Start PTAA/.test(t), "the form asks for the Sales Agent and says Start PTAA");
  ok(await page.locator("#nr-agent").count() === 1, "there is an agent picker");

  const fill = async (id, v) => { await page.fill("#" + id, v); };
  await fill("nr-owner-name", "Chua  Sheng arn");
  await fill("nr-owner-nric", "900101-14-5555");
  await fill("nr-owner-phone", "012-345 6789");
  await fill("nr-owner-address", "No 1, Jalan Test, 58200 Kuala Lumpur");
  await fill("nr-owner-bankName", "MALAYAN BANKING BERHAD (MAYBANK)");
  await fill("nr-owner-accountNumber", "114012345678");
  await page.selectOption("#nr-propertyId", "p1");
  await fill("nr-unitNo", "b-38-12");
  await page.selectOption("#nr-ptaaType", "Partition");
  await fill("nr-propertySize", "1151");
  await fill("nr-tenancy-initialTermMonths", "36");
  await fill("nr-tenancy-commencementDate", "2026-10-01");
  await fill("nr-financial-monthlyAdminFeePercent", "10");

  ok(await page.locator("button", { hasText: "Start PTAA" }).isDisabled(), "cannot start without choosing the agent");
  await page.selectOption("#nr-agent", "a1");
  t = await text();
  ok(/CHIN HAN TUNG/.test(t) && /990115-43-5553/.test(t), "the chosen agent's details are shown");

  await page.selectOption("#nr-agent", "a2");
  t = await text();
  ok(/full name missing/.test(t) && /I\/C missing/.test(t), "an agent with missing details is flagged");
  await page.selectOption("#nr-agent", "a1");

  const inputs = page.locator('.slot input[type="file"]:not([capture]):not([data-both])');
  await inputs.nth(0).setInputFiles({ name: "ic-front.png", mimeType: "image/png", buffer: PNG_1PX });
  await inputs.nth(1).setInputFiles({ name: "ic-back.png", mimeType: "image/png", buffer: PNG_1PX });
  await page.locator('.slot input[type="file"][accept*="pdf"]:not([data-both])').setInputFiles(QUOTE_PDF);
  await page.waitForFunction(() => /priced items read/.test(document.body.innerText), null, { timeout: 30000 });
  ok(true, "the quotation's items were read on attach");
  ok(await page.inputValue("#nr-financial-renovationCost") === "41433", "renovation cost filled from the grand total (RM41,433)");

  await page.locator("button", { hasText: "Start PTAA" }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/request:"), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const st = await dump();
  const r = st["requests/PTAA-00001"];
  ok(!!r, "PTAA-00001 was created");
  ok(r.agentEmail === ADMIN, "it is owned by the signed-in admin (the rules require it)");
  ok(r.agentSnapshot.fullName === "CHIN HAN TUNG" && r.agentSnapshot.nric === "990115-43-5553",
     "the agent's details were snapshotted from the list");
  ok(r.quotation && r.quotation.entries.length > 40 && r.quotation.grandTotal === 41433,
     `the quotation lines were stored (${r.quotation && r.quotation.entries.length} lines)`);
  ok(Object.keys(st).filter(k => k.startsWith("requests/PTAA-00001/attachments/")).length >= 3,
     "the I/C and the quotation pages were attached");
}

// ---------------------------------------------------------------------------
group("Draft the PTAA and the invoice");
{
  let t = await text();
  ok(/Details and files/.test(t) && /File to Drive/.test(t), "the five-step bar is shown");
  ok(/1 · Details/.test(t) && /2 · Draft the PTAA and the invoice/.test(t), "the steps are laid out in order");
  const rows = await page.locator(".inv-row").count();
  ok(rows === 29, `the invoice is pre-filled with 29 items (got ${rows}) — same item in several rooms added together`);
  ok(await page.inputValue("#inv-total") === "41433", "the invoice total is the grand total");
  ok(await page.inputValue("#inv-q27") === "FOC" && await page.inputValue("#inv-q28") === "FOC",
     "the smart lock and gateway are FOC, at the end");
  ok(await page.inputValue("#inv-q7") === "5", "ceiling fans from five rooms become one line of 5");
  ok(/Next number: BLKINV-2610034|Next number: BLKINV-26\d\d034/.test(await text()), "the next invoice number carries on from 033");
  await page.screenshot({ path: `${OUT}/solo-2-request.png`, fullPage: true });

  // PTAA
  const dl1 = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Draft the PTAA (Word)" }).click();
  const docx = await dl1;
  ok(docx.suggestedFilename() === "PTAA (SUNWAY JERNIH B-38-12) CHUA SHENG ARN.docx", "PTAA named by the pattern: " + docx.suggestedFilename());
  await docx.saveAs(`${OUT}/ptaa.docx`);
  const docXml = execFileSync("unzip", ["-p", `${OUT}/ptaa.docx`, "word/document.xml"]).toString().replace(/<[^>]+>/g, "");
  ok(/CHUA SHENG ARN/.test(docXml) && !/Chua/i.test(docXml.replace(/CHUA/g, "")), "the Owner's name is in capitals everywhere in the Word file, though typed in mixed case");
  const media = execFileSync("unzip", ["-l", `${OUT}/ptaa.docx`]).toString().split("\n").filter(l => /word\/media\//.test(l)).length;
  const tmplMedia = execFileSync("unzip", ["-l", TEMPLATE_DOCX]).toString().split("\n").filter(l => /word\/media\//.test(l)).length;
  ok(media === tmplMedia + 2, `only the two I/C images were added to the Word file, not the quotation (${media - tmplMedia} added)`);
  await page.waitForTimeout(1200);

  // Invoice
  const dl2 = page.waitForEvent("download", { timeout: 60000 });
  // Dated in September, so it files into the existing SEP 26 INV folder whatever today is.
  await page.fill("#inv-date", "2026-09-24");
  await page.locator("button", { hasText: "Make the invoice (Excel)" }).click();
  const xlsx = await dl2;
  await xlsx.saveAs(`${OUT}/invoice.xlsx`);
  {
    const list = execFileSync("unzip", ["-l", `${OUT}/invoice.xlsx`]).toString();
    ok(!/calcChain/.test(list), "the invoice has no stale formula list (Excel opens it without repairing)");
    const sx = execFileSync("unzip", ["-p", `${OUT}/invoice.xlsx`, "xl/worksheets/sheet1.xml"]).toString();
    ok(!/gridLines="1"/.test(sx) && /showGridLines="0"/.test(sx) && !/cellComments/.test(sx),
       "the invoice prints without gridlines or notes");
    ok(!/\{\{/.test(sx) && /BLKINV-26\d\d034/.test(sx), "the markers were filled (invoice number in H6)");
  }
  ok(xlsx.suggestedFilename() === "SUNWAY JERNIH B-38-12 INVOICE.xlsx",
     "invoice named like the office's files: " + xlsx.suggestedFilename());
  await page.waitForTimeout(1200);

  const st = await dump();
  const r = st["requests/PTAA-00001"];
  ok(r.workingDoc && r.workingDoc.confirmed === false, "the PTAA draft is stored, not yet confirmed");
  ok(r.invoice && /^BLKINV-26\d\d034$/.test(r.invoice.invoiceNo), "the invoice number was taken: " + (r.invoice || {}).invoiceNo);
  ok(st["counters/invoices"].last === r.invoice.invoiceNo, "the counter moved on");
  ok(r.invoice.file && r.invoice.file.confirmed === false, "the invoice draft is stored");
  t = await text();
  ok(/Edit and confirm/.test(t), "stage is now Edit and confirm");
}

// ---------------------------------------------------------------------------
group("Upload the confirmed files and file to Drive");
{
  let t = await text();
  ok(/Before filing/.test(t), "filing is blocked until both confirmed files are in");
  ok(await page.locator("button", { hasText: "File to Google Drive" }).isDisabled(), "…and the button is disabled");

  await page.locator('input[type="file"][accept=".docx"]').setInputFiles(`${OUT}/ptaa.docx`);
  await page.waitForTimeout(1500);
  await page.locator(".confirm-row", { hasText: "Invoice (Excel)" }).locator("button", { hasText: "Use the draft as final" }).click();
  await page.waitForTimeout(1200);
  t = await text();
  ok(/Ready to file/.test(t), "stage is Ready to file");
  const st = await dump();
  ok(st["requests/PTAA-00001"].workingDoc.confirmed === true && st["requests/PTAA-00001"].workingDoc.source === "uploaded",
     "the uploaded PTAA is the confirmed one");

  // A failed upload changes nothing.
  drive.failNext = "backend error";
  await page.locator("button", { hasText: "File to Google Drive" }).click();
  await page.waitForTimeout(2500);
  t = await text();
  ok(/Not filed/.test(t), "a failed upload says Not filed");
  let s2 = await dump();
  ok(s2["requests/PTAA-00001"].status === "NEW" && !s2["requests/PTAA-00001"].drive, "…and the PTAA is untouched");

  await page.locator("button", { hasText: "File to Google Drive" }).click();
  await page.waitForTimeout(3000);
  t = await text();
  ok(/Filed in Google Drive/.test(t), "filed" + (/Not filed/.test(t) ? " — page says: " + t.slice(t.indexOf("Not filed"), t.indexOf("Not filed") + 400) : ""));
  if (!/Filed in Google Drive/.test(t)) console.log("    drive calls:", drive.calls.slice(-12).join(" | "));
  s2 = await dump();
  const r = s2["requests/PTAA-00001"];
  ok(r.status === "COMPLETED" && r.drive && r.drive.fileId && r.drive.invoice && r.drive.invoice.fileId,
     "status Filed, with both Drive files recorded");
  const folder = [...drive.files.values()].find(f => f.name === "SUNWAY JERNIH");
  ok(!!folder && folder.parents[0] === "ROOT123456789", "a condo folder was made inside the chosen folder");
  const inFolder = (id) => [...drive.files.values()].filter(f => f.parents && f.parents.includes(id) && f.mimeType !== "application/vnd.google-apps.folder");
  ok(inFolder(folder.id).length === 1 && /^PTAA \(/.test(inFolder(folder.id)[0].name), "the PTAA is in PTAA Filing / SUNWAY JERNIH");
  const invFile = inFolder("SEPFOLDER")[0] || {};
  ok(invFile.name === "SUNWAY JERNIH B-38-12 INVOICE" && invFile.mimeType === "application/vnd.google-apps.spreadsheet",
     "the invoice is saved as a Google Sheet named like the office's: " + invFile.name);
  ok(inFolder("SEPFOLDER").length === 1 && /INVOICE/.test(inFolder("SEPFOLDER")[0].name),
     "the invoice is in INVOICE / SEP 26 INV — the existing month folder, picked from the invoice date");
  ok([...drive.files.values()].filter(f => f.name === "SEP 26 INV").length === 1, "no duplicate month folder was made");
  ok(/Invoice → SEP 26 INV/.test(await text()) || /SEP 26 INV/.test(await text()), "the page says where each went");

  // Filing again replaces, never duplicates.
  await page.locator("button", { hasText: "File again" }).click();
  await page.waitForTimeout(3000);
  ok(inFolder(folder.id).length === 1 && inFolder("SEPFOLDER").length === 1,
     "filing again replaces the two files rather than adding copies");
  await page.screenshot({ path: `${OUT}/solo-3-filed.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
group("Complete PTAA as one PDF");
if (!PDFLib) console.log("  · skipped — set PDF_LIB to pdf-lib's path");
else {
  let t = await text();
  ok(/6 · Complete PTAA as PDF/.test(t), "a filed PTAA offers the complete PDF");
  const dl = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Download the complete PDF" }).click();
  const pdf = await dl;
  ok(pdf.suggestedFilename() === "PTAA (SUNWAY JERNIH B-38-12) CHUA SHENG ARN.pdf", "named like the PTAA: " + pdf.suggestedFilename());
  await pdf.saveAs(`${OUT}/complete.pdf`);
  const pages = execFileSync("pdftotext", ["-layout", `${OUT}/complete.pdf`, "-"]).toString()
    .split("\f").map(x => x.trim()).filter(Boolean).map(x => x.split("\n")[0].trim());
  ok(JSON.stringify(pages) === JSON.stringify(["Agreement page 1", "Agreement page 2",
    "APPENDIX A Renovation Cost Details / Invoice", "INVOICE page 1", "INVOICE page 2", "APPENDIX B SPECIAL TERMS"]),
    "the invoice sits after the Appendix A page, before Appendix B: " + pages.join(" | "));
  const temp = [...drive.files.values()].find(f => f.mimeType === "application/vnd.google-apps.document");
  ok(temp && temp.trashed === true, "the temporary Google Doc was moved to the bin");
  await page.waitForTimeout(800);
  ok(![...drive.files.values()].some(f => /\.pdf$/.test(f.name || "")), "and nothing was saved to Drive");
  t = await text();
  ok(/Done — 6 pages/.test(t), "the page says what it did");
  ok(sheetExports.some(q => /gridlines=false/.test(q) && /printnotes=false/.test(q)),
     "the invoice was exported without gridlines or notes");
  await page.screenshot({ path: `${OUT}/solo-3b-pdf.png`, fullPage: true });
}

group("Sign a PDF — the Director signs after the Owner");
if (process.env.SIGNED_PDF) {
  const png = readFileSync(process.env.SIG_PNG);
  await scenario({ docs: { ...BASE_DOCS,
    "signatures/shared:director": { label: "Benjamin (Director)", kind: "shared", isDirector: true,
      bytes: png.length, chunkCount: 1, width: 300, height: 120 },
    "signatures/shared:director/chunks/0": { data: png.toString("base64") },
  }, user: google(ADMIN), hash: "#/sign" });
  let t = await text();
  ok(/Sign a PDF/.test(t) && /Upload the PDF/.test(t), "the Sign PDF screen asks for the PDF");
  await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(process.env.SIGNED_PDF);
  await page.waitForFunction(() => /Tick which signature/.test(document.body.innerText), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  t = await text();
  const found = (t.match(/Page \d+ · (Owner|Tenancy Administrator|Witness)/g) || []);
  ok(found.length === 6, `all six signature lines were found (${found.join(", ")})`);
  const dirSel = await page.$$eval("select[id^=spot-]", els => els.map(e => e.value));
  ok(dirSel.filter(v => v === "shared:director").length === 2 && dirSel.filter(v => !v).length === 4,
     "the Director's signature is ticked for the two Tenancy Administrator lines only");
  ok(await page.locator(".sign-mark").count() >= 1, "it shows on the page preview");
  await page.screenshot({ path: `${OUT}/solo-7-sign.png`, fullPage: true });
  const dl = page.waitForEvent("download", { timeout: 30000 });
  await page.locator("button", { hasText: "Download the signed PDF" }).click();
  const d = await dl;
  await d.saveAs(`${OUT}/signed.pdf`);
  ok(/\(signed\)\.pdf$/.test(d.suggestedFilename()), "downloaded as “… (signed).pdf”");
  const imgs = execFileSync("pdfimages", ["-list", `${OUT}/signed.pdf`]).toString();
  const onPage = (n) => imgs.split("\n").filter(l => new RegExp(`^\\s*${n}\\s`).test(l) && /image|smask/.test(l)).length;
  ok(onPage(16) >= 1 && onPage(23) >= 1, "the signature is stamped on page 16 and on Appendix B");
}

group("Agents, condos, settings");
{
  await scenario({ docs: BASE_DOCS, user: google(ADMIN), hash: "#/agents" });
  let t = await text();
  ok(/Sales Agents/.test(t) && /nobody here can sign in/i.test(t), "the agents screen says it is a list, not accounts");
  ok(/YM — full name missing, I\/C missing/.test(t), "incomplete agents are called out");

  if (AGENTS_CSV) {
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles(AGENTS_CSV);
    await page.waitForTimeout(3000);
    const st = await dump();
    const agents = Object.entries(st).filter(([k]) => /^agents\/[^/]+$/.test(k)).map(([, v]) => v);
    ok(agents.length === 38, `after importing, 38 agents on the list (got ${agents.length}) — Terence and YM were already there`);
    const users = Object.keys(st).filter(k => /^users\//.test(k));
    ok(users.length === 1, "importing agents registered no sign-in accounts");
    await page.screenshot({ path: `${OUT}/solo-4-agents.png`, fullPage: true });
  }

  await scenario({ docs: BASE_DOCS, user: google(ADMIN), hash: "#/properties" });
  t = await text();
  ok(/Customer Relationship team/.test(t), "the condo screen has the CRD team list");
  await page.locator("button", { hasText: "Add the 9 from the CRD team list" }).click();
  await page.waitForTimeout(1200);
  t = await text();
  ok(/AMELIE/.test(t) && /MIYUKI/.test(t), "the nine CRD names are on the list");
  const picVal = await page.inputValue("#pic-p1");
  ok(!!picVal && picVal !== "__other__", "SUNWAY JERNIH's PIC (KEITH) is matched to the list");
  await page.screenshot({ path: `${OUT}/solo-5-condos.png`, fullPage: true });

  await scenario({ docs: BASE_DOCS, user: google(ADMIN), hash: "#/settings" });
  t = await text();
  ok(/PTAAs \(Word\)/.test(t) && /invoices \(Excel\)/.test(t) && /Invoice numbering/.test(t),
     "settings has a PTAA folder, a separate invoice folder, and invoice numbering");
  ok(/BLKINV-26\d\d034/.test(t), "it shows the next invoice number");
  await page.screenshot({ path: `${OUT}/solo-6-settings.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
group("No Partition, no invoice, an owner from overseas");
{
  const docText = (f) => execFileSync("unzip", ["-p", f, "word/document.xml"]).toString().replace(/<[^>]+>/g, "");
  const partitionDoc = docText(`${OUT}/ptaa.docx`);
  ok(/APPENDIX B/.test(partitionDoc) && /SPECIAL TERMS FOR PARTITION WORKS/.test(partitionDoc),
     "a Partition PTAA has Appendix B");
  ok(!/\{\{[#/]?is_partition\}\}/.test(partitionDoc), "…and no block markers are left in it");

  await scenario({ docs: { ...BASE_DOCS, ...templateDocs() }, user: google(ADMIN), hash: "#/new-request" });
  const opts = await page.locator("#nr-ptaaType option").allInnerTexts();
  ok(opts.includes("Partition") && opts.includes("No Partition") && opts.includes("WUR"), "three PTAA types: " + opts.join(", "));
  const fill = async (id, v) => { await page.fill("#" + id, v); };
  await page.selectOption("#nr-agent", "a1");
  await fill("nr-owner-name", "John Tan Wei Ming");
  await fill("nr-owner-nric", "E1234 5678");
  await fill("nr-owner-phone", "+65 9123 4567");
  await fill("nr-owner-address", "10 Orchard Road, Singapore 238826");
  await page.selectOption("#nr-propertyId", "p1");
  await fill("nr-unitNo", "A-10-01");
  await page.selectOption("#nr-ptaaType", "No Partition");
  await fill("nr-tenancy-initialTermMonths", "12");
  await fill("nr-tenancy-commencementDate", "2026-11-01");
  await fill("nr-financial-monthlyAdminFeePercent", "10");
  const t0 = await text();
  ok(/passport/.test(t0), "the passport number is accepted, with a note that it is not a Malaysian I/C");
  const start = page.locator("button", { hasText: "Start PTAA" });
  ok(!(await start.isDisabled()), "an overseas phone (+65) and a passport number do not block the PTAA");
  await start.click();
  await page.waitForFunction(() => location.hash.startsWith("#/request:"), null, { timeout: 20000 });
  await page.waitForTimeout(900);
  let st = await dump();
  const id = Object.keys(st).filter(k => /^requests\/PTAA-\d+$/.test(k)).pop();
  const r0 = st[id];
  ok(r0.owner.phone === "+65 9123 4567" && r0.owner.nric === "E12345678" && r0.ptaaType === "No Partition",
     "stored: +65 9123 4567, passport E12345678, No Partition");

  const dl = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Draft the PTAA (Word)" }).click();
  await (await dl).saveAs(`${OUT}/ptaa-nopartition.docx`);
  const np = docText(`${OUT}/ptaa-nopartition.docx`);
  // Clause 6A still mentions "APPENDIX B" in passing; the appendix itself is gone.
  ok(!/SPECIAL TERMS FOR PARTITION WORKS/.test(np) && !/Appendix B shall only take effect/.test(np) && /APPENDIX A/.test(np),
     "a No Partition PTAA has Appendix A but no Appendix B");
  ok(/\+65 9123 4567/.test(np) && /E12345678/.test(np), "the overseas phone and the passport print in the agreement");
  await page.waitForTimeout(900);

  ok(/Before filing/.test(await text()) && /no invoice yet/i.test(await text()), "without an invoice, filing is blocked at first");
  await page.locator("button", { hasText: "No invoice for this PTAA" }).click();
  await page.waitForTimeout(900);
  let t = await text();
  ok(/goes ahead without an invoice/.test(t), "the invoice card says there is no invoice");
  await page.locator(".confirm-row", { hasText: "PTAA (Word)" }).locator("button", { hasText: "Use the draft as final" }).click();
  await page.waitForTimeout(1200);
  t = await text();
  ok(/Ready to file/.test(t), "with the PTAA confirmed and no invoice, it is Ready to file");
  await page.locator("button", { hasText: "File to Google Drive" }).click();
  await page.waitForTimeout(3000);
  st = await dump();
  const r1 = st[id];
  ok(r1.status === "COMPLETED" && r1.drive && r1.drive.fileId && r1.drive.invoice === null,
     "filed and completed with the agreement only");
  t = await text();
  ok(/None for this PTAA/.test(t), "the filed card says there is no invoice");
  if (PDFLib) {
    const dl2 = page.waitForEvent("download", { timeout: 60000 });
    await page.locator("button", { hasText: "Download the complete PDF" }).click();
    await (await dl2).saveAs(`${OUT}/complete-noinvoice.pdf`);
    const pages = execFileSync("pdftotext", ["-layout", `${OUT}/complete-noinvoice.pdf`, "-"]).toString()
      .split("\f").map(x => x.trim()).filter(Boolean);
    ok(pages.length === 4 && !pages.some(p => /INVOICE page/.test(p)), "the complete PDF is the agreement alone");
  }
}

// ---------------------------------------------------------------------------
group("Invoice: 4th payment, paid in full, and the cost check");
{
  const REQ = {
    ptaaId: "PTAA-00050", type: "NEW_PTAA", status: "NEW", agentEmail: ADMIN,
    agentSnapshot: { fullName: "CHIN HAN TUNG", nric: "990115-43-5553", phone: "018-356 6395", nickname: "Terence" },
    owner: { name: "LIM AH KOW", nric: "800101-14-1234", phone: "012-345 6789", address: "KL" },
    propertyId: "p1", propertyName: "SUNWAY JERNIH", propertyAddress: "Jalan Jernih", unitNo: "C-01-01", ptaaType: "Partition",
    tenancy: { initialTermMonths: 12, commencementDate: "2026-11-01", expiryDate: "2027-10-31" },
    financial: { monthlyAdminFeePercent: 10, renovationCost: 40000 },
    utilities: {}, specialTerms: [], attachmentCount: 0, createdBy: ADMIN, createdAt: "@now", updatedAt: "@now",
    invoice: { invoiceNo: "", date: "2026-10-07", billTo: "LIM AH KOW\nSUNWAY JERNIH C-01-01", remark: "",
               items: [{ description: "Kitchen cabinet", qty: 1 }, { description: "Wardrobe", qty: 2 }],
               total: 41433, pay1: 1000, pay2: 9000, pay3: 0, pay4: 0, file: null },
  };
  await scenario({ docs: { ...BASE_DOCS, ...templateDocs(), "requests/PTAA-00050": REQ }, user: google(ADMIN) });
  let t = await text();
  ok(/Renovation cost and invoice don't match \(1\)/.test(t) && /RM 40,000\.00/.test(t) && /\+RM 1,433\.00/.test(t),
     "the dashboard flags PTAA-00050: RM40,000 on the PTAA vs RM41,433 on the invoice");
  await page.evaluate(() => { location.hash = "#/requests"; });
  await page.waitForTimeout(700);
  ok(/Cost ≠ invoice/.test(await text()), "the PTAA list marks it too");
  await page.evaluate(() => { location.hash = "#/request:PTAA-00050"; });
  await page.waitForTimeout(900);
  t = await text();
  ok(/Renovation cost and invoice don't match/.test(t), "and so does the PTAA itself");
  ok((await page.locator("#inv-p4").count()) === 1, "there is a 4th payment box");
  ok(/Blank Finance terms \(8 and 9\) stay in/.test(t), "with a balance left, terms 8 and 9 stay");

  // Save details → the difference is asked about; keep both. The page keeps its place.
  const saveBtn = page.locator("button", { hasText: "Save details" });
  await saveBtn.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200));
  const before = await page.evaluate(() => window.scrollY);
  await saveBtn.click();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.screenshot({ path: `${OUT}/solo-8-cost-dialog.png` });
  const modal = await page.locator(".modal").innerText();
  ok(/Renovation cost on the PTAA: RM 40,000\.00/.test(modal) && /Invoice total: RM 41,433\.00/.test(modal),
     "a dialog shows both amounts");
  ok(/Change the renovation cost to RM 41,433\.00/.test(modal) && /Keep both/.test(modal), "…and offers to change the cost or keep both");
  await page.locator(".modal button", { hasText: "Keep both" }).click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.scrollY);
  ok(before > 400 && Math.abs(after - before) < 60, `the page stays where it was after reloading (${before} → ${after})`);
  let st = await dump();
  const ack = st["requests/PTAA-00050"].invoice.costAck;
  ok(ack && ack.renovationCost === 40000 && ack.invoiceTotal === 41433 && ack.by === ADMIN, "the confirmation is recorded with who and the amounts");
  t = await text();
  ok(!/Renovation cost and invoice don't match/.test(t) && /differ on purpose — confirmed by/.test(t),
     "the warning becomes a note that it was confirmed");

  // 4th payment
  await page.fill("#inv-p3", "10000");
  await page.fill("#inv-p4", "5000");
  let dl = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Make the invoice (Excel)" }).click();
  ok((await page.locator(".modal").count()) === 0, "a confirmed difference is not asked about again");
  await (await dl).saveAs(`${OUT}/invoice-4pay.xlsx`);
  let sx = execFileSync("unzip", ["-p", `${OUT}/invoice-4pay.xlsx`, "xl/worksheets/sheet1.xml"]).toString();
  ok(/4th Payment/.test(sx) && /<f>G15-G16-G17-G18-G19<\/f><v>16433<\/v>/.test(sx),
     "a 4th Payment row, and the balance (RM16,433) takes off all four payments");
  ok(/<v>23<\/v>/.test(sx), "with a balance left, the Blank Finance fee term is still there");
  await page.waitForTimeout(1000);

  // Paid in full
  await page.fill("#inv-p4", "26433");
  ok(/more than the total/.test(await text()), "overpaying is pointed out");
  await page.fill("#inv-p4", "21433");
  t = await text();
  ok(/Paid in full/.test(t), "paying the rest says: paid in full, term 8 left out");
  dl = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Remake the invoice" }).click();
  await (await dl).saveAs(`${OUT}/invoice-full.xlsx`);
  sx = execFileSync("unzip", ["-p", `${OUT}/invoice-full.xlsx`, "xl/worksheets/sheet1.xml"]).toString();
  ok(!/<c r="B\d+" s="\d+" t="s"><v>23<\/v>/.test(sx), "the Blank Finance fee term is gone");
  const last = [...sx.matchAll(/<c r="A(\d+)" s="\d+"><v>(\d+)<\/v><\/c><c r="B\1" s="\d+" t="s"><v>24<\/v>/g)].map(m => m[2]);
  ok(JSON.stringify(last) === '["8"]', "the old term 9 is now numbered 8");
  ok(/<f>G15-G16-G17-G18-G19<\/f><v>0<\/v>/.test(sx), "balance RM0.00");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/solo-7-invoice-extras.png`, fullPage: true });

  // A new total → asked again; this time change the renovation cost to match.
  await page.fill("#inv-total", "50000");
  await page.locator("button", { hasText: "Save details" }).click();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.locator(".modal button", { hasText: "Change the renovation cost to RM 50,000.00" }).click();
  await page.waitForTimeout(1500);
  st = await dump();
  ok(st["requests/PTAA-00050"].financial.renovationCost === 50000 && st["requests/PTAA-00050"].financial.monthlyAdminFeePercent === 10,
     "the PTAA's renovation cost is changed to the invoice total (the fee is untouched)");
  ok(/Renovation\s*RM 50,000\.00/.test(await text()), "and shows on the page");

  // Cancel leaves everything as it was.
  await page.fill("#inv-total", "51000");
  await page.locator("button", { hasText: "Save details" }).click();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.locator(".modal button", { hasText: "Cancel" }).click();
  await page.waitForTimeout(800);
  st = await dump();
  ok(st["requests/PTAA-00050"].invoice.total === 50000 && st["requests/PTAA-00050"].financial.renovationCost === 50000,
     "Cancel saves nothing");

  // No renovation cost: NIL on the page and in the agreement.
  await page.evaluate(() => { const s = window.__stub; const k = "requests/PTAA-00050"; const r = s.dump()[k];
    r.financial.renovationCost = null; r.invoice = null; s.seed(k, r); location.hash = "#/dashboard"; });
  await page.waitForTimeout(500);
  await page.evaluate(() => { location.hash = "#/request:PTAA-00050"; });
  await page.waitForTimeout(900);
  ok(/Renovation\s*NIL/.test(await text()), "a blank renovation cost shows as NIL");
  const dlw = page.waitForEvent("download", { timeout: 60000 });
  await page.locator("button", { hasText: "Draft the PTAA (Word)" }).click();
  await (await dlw).saveAs(`${OUT}/ptaa-nil.docx`);
  const nilDoc = execFileSync("unzip", ["-p", `${OUT}/ptaa-nil.docx`, "word/document.xml"]).toString().replace(/<[^>]+>/g, "");
  ok(/Renovation Cost \(if any\)NIL/.test(nilDoc), "Schedule 1 item 10 reads NIL (not “RM NIL”)");
}

// ---------------------------------------------------------------------------
group("Console");
// The one 500 is the upload failure staged on purpose above.
const unexpected = consoleErrors.filter(e => !/status of 500/.test(e));
consoleErrors.length = 0; consoleErrors.push(...unexpected);
ok(consoleErrors.length === 0, "no console errors" + (consoleErrors.length ? ":\n    " + consoleErrors.join("\n    ") : ""));

await browser.close();
console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
