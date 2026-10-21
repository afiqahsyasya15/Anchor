// ---------------------------------------------------------------------------
// invoice.js — the Excel invoice that goes with each PTAA.
//
// The template (assets/invoice-template.xlsx) is the office's own invoice with
// its logo, fonts, borders and payment terms untouched. Three item rows are
// kept in it as patterns — first, middle, last — because the box round the
// Amount column is drawn by the cells' borders, and the top, middle and bottom
// of that box are different. This file repeats the middle pattern once per
// item and moves everything below the table down to make room.
//
// Only the worksheet XML is rewritten; styles, the logo and the print setup are
// the template's own. fillInvoiceSheet() is pure string work so it can be
// tested without a browser — see tests/invoice.test.mjs.
// ---------------------------------------------------------------------------

export const INVOICE_TEMPLATE_URL = new URL("../assets/invoice-template.xlsx", import.meta.url).href;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Row numbers in the template. */
const T = {
  firstItem: 12,     // pattern for the first item row
  middleItem: 13,    // pattern for every row in between
  lastItem: 14,      // pattern for the last item row
  after: 15,         // first row below the item table
  total: 16, pay1: 17, pay2: 18, pay3: 19, balance: 20,
};

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// Invoice numbers:  BLKINV-2609033  =  BLKINV- + YY + MM + running number
// ---------------------------------------------------------------------------

export const INVOICE_PREFIX = "BLKINV-";

export function yymmOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return String(d.getFullYear() % 100).padStart(2, "0") + String(d.getMonth() + 1).padStart(2, "0");
}

export function formatInvoiceNo(yymm, seq, prefix = INVOICE_PREFIX) {
  return `${prefix}${yymm}${String(seq).padStart(3, "0")}`;
}

/** "BLKINV-2609033" → { prefix:"BLKINV-", yymm:"2609", seq:33 } or null. */
export function parseInvoiceNo(value) {
  const m = /^\s*([A-Za-z]+-?)(\d{2})(\d{2})(\d{3,})\s*$/.exec(String(value || ""));
  if (!m) return null;
  const month = Number(m[3]);
  if (month < 1 || month > 12) return null;
  const prefix = m[1].toUpperCase().endsWith("-") ? m[1].toUpperCase() : m[1].toUpperCase() + "-";
  return { prefix, yymm: m[2] + m[3], seq: Number(m[4]) };
}

/**
 * The number after `last`.
 *   resetMonthly = false:  …2609033 in October → BLKINV-2610034 (count carries on)
 *   resetMonthly = true:   …2609033 in October → BLKINV-2610001
 */
export function nextInvoiceNo(last, { now = new Date(), resetMonthly = false } = {}) {
  const yymm = yymmOf(now);
  const p = parseInvoiceNo(last);
  if (!p) return formatInvoiceNo(yymm, 1);
  const seq = resetMonthly && p.yymm !== yymm ? 1 : p.seq + 1;
  return formatInvoiceNo(yymm, seq, p.prefix);
}

/**
 * "SUNWAY JERNIH B-38-12 INVOICE.xlsx" — named exactly like the office's
 * invoices in the BLANK RENO INV month folders (which drop the ".xlsx" once
 * they are Google Sheets).
 */
export function invoiceFilename({ propertyName, unitNo }) {
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  return `${clean(propertyName) || "[property]"} ${clean(unitNo) || "[unit]"} INVOICE.xlsx`;
}

// ---------------------------------------------------------------------------
// Dates and money
// ---------------------------------------------------------------------------

/** Excel's serial day number for a local date (1900 date system). */
export function excelSerial(date) {
  const d = date instanceof Date ? date : new Date(date);
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round(utc / 86_400_000) + 25569;
}

export function toMoney(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// ---------------------------------------------------------------------------
// Row height: the template's description column is about 62 characters wide
// at 10 pt. Excel does not grow a custom-height row by itself.
// ---------------------------------------------------------------------------

const CHARS_PER_LINE = 62;
export function rowHeightFor(description) {
  const lines = String(description || "").split("\n")
    .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / CHARS_PER_LINE)), 0);
  return Math.max(15, Math.round((lines * 13.2 + 5) * 4) / 4);
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/** The first line in bold, the rest regular — as the office's invoices are. */
function richDescription(description) {
  const parts = String(description || "").replace(/\r/g, "").split("\n");
  const run = (text, bold) =>
    `<r><rPr>${bold ? "<b/>" : ""}<sz val="10"/><color theme="1"/><rFont val="Outfit"/></rPr>` +
    `<t xml:space="preserve">${esc(text)}</t></r>`;
  const head = parts.shift();
  return `<is>${run(head, true)}${parts.length ? run("\n" + parts.join("\n"), false) : ""}</is>`;
}

function inlineText(text) {
  return `<is><t xml:space="preserve">${esc(text)}</t></is>`;
}

/** Rewrite a row's number and every cell reference in it. */
function renumberRow(rowXml, from, to) {
  return rowXml
    .replace(new RegExp(`(<row\\b[^>]*\\br=")${from}"`), `$1${to}"`)
    .replace(new RegExp(`(<c\\b[^>]*\\br="[A-Z]+)${from}"`, "g"), `$1${to}"`);
}

/** Replace one cell (by reference) inside a row, keeping its style. */
function setCell(rowXml, ref, { number = null, inline = null, formula = null, raw = null }) {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = re.exec(rowXml);
  if (!m) throw new Error(`The invoice template has no cell ${ref}.`);
  const style = (/\bs="(\d+)"/.exec(m[1]) || [])[1];
  const s = style ? ` s="${style}"` : "";
  let cell;
  if (raw !== null)          cell = `<c r="${ref}"${s} t="inlineStr">${raw}</c>`;
  else if (inline !== null)  cell = `<c r="${ref}"${s} t="inlineStr">${inlineText(inline)}</c>`;
  else if (formula !== null) cell = `<c r="${ref}"${s}><f>${formula}</f>${number !== null ? `<v>${number}</v>` : ""}</c>`;
  else if (number !== null)  cell = `<c r="${ref}"${s}><v>${number}</v></c>`;
  else                       cell = `<c r="${ref}"${s}/>`;
  return rowXml.replace(re, cell);
}

function setHeight(rowXml, ht) {
  const withoutHt = rowXml.replace(/\s(ht|customHeight)="[^"]*"/g, "");
  return withoutHt.replace(/^<row\b/, `<row ht="${ht}" customHeight="1"`);
}

/**
 * Fill the worksheet XML.
 *
 * @param {string} xml   xl/worksheets/sheet1.xml of the template
 * @param {object} d
 *   billTo      "OWNER NAME\nPROPERTY UNIT"
 *   invoiceNo   "BLKINV-2609033"
 *   date        Date
 *   remark      optional
 *   items       [{ description, qty }]   qty is a number or "FOC"
 *   total, pay1, pay2, pay3, pay4        numbers (a 4th payment row appears only when pay4 is not 0)
 *   fullPayment  true = paid in full, no Blank Finance: payment term 8 is removed and 9 becomes 8
 */
export function fillInvoiceSheet(xml, d) {
  const items = (d.items || []).filter(i => String(i.description || "").trim());
  if (!items.length) throw new Error("The invoice needs at least one item.");

  const start = xml.indexOf("<sheetData>");
  const end = xml.indexOf("</sheetData>");
  if (start < 0 || end < 0) throw new Error("The invoice template is not a worksheet.");
  const head = xml.slice(0, start);
  const tail = xml.slice(end + "</sheetData>".length);
  const rows = xml.slice(start + "<sheetData>".length, end).match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) || [];

  const rowNo = (r) => Number(/<row\b[^>]*\br="(\d+)"/.exec(r)[1]);
  const byNo = new Map(rows.map(r => [rowNo(r), r]));
  for (const n of [T.firstItem, T.middleItem, T.lastItem, T.total, T.balance]) {
    if (!byNo.has(n)) throw new Error(`The invoice template is missing row ${n}.`);
  }

  const n = items.length;
  const shift = n - 3;                        // the template holds three item rows
  const at = (templateRow) => templateRow + shift;

  const out = [];

  // Header rows, with the three fields filled.
  for (const r of rows.filter(r => rowNo(r) < T.firstItem)) {
    let row = r;
    if (row.includes("{{BILL_TO}}")) row = setCell(row, "A7", { inline: d.billTo || "" });
    if (row.includes("{{INVOICE_NO}}")) row = setCell(row, "H6", { inline: d.invoiceNo || "" });
    if (row.includes("{{DATE}}")) row = setCell(row, "H7", { number: excelSerial(d.date || new Date()) });
    if (d.remark && /<c r="H8"/.test(row)) row = setCell(row, "H8", { inline: d.remark });
    out.push(row);
  }

  // One row per item.
  const total = toMoney(d.total);
  items.forEach((item, i) => {
    const target = T.firstItem + i;
    const pattern = i === 0 ? T.firstItem : i === n - 1 ? T.lastItem : T.middleItem;
    let row = renumberRow(byNo.get(pattern), pattern, target);
    row = setCell(row, `A${target}`, { number: i + 1 });
    row = setCell(row, `B${target}`, { raw: richDescription(item.description) });
    const q = item.qty;
    row = (q === "FOC" || (typeof q === "string" && !/^\d+$/.test(q.trim())))
      ? setCell(row, `F${target}`, { inline: String(q || "").trim() || "FOC" })
      : setCell(row, `F${target}`, { number: Number(q) || 0 });
    if (i === 0) row = setCell(row, `G${target}`, { number: total });
    row = setHeight(row, rowHeightFor(item.description));
    out.push(row);
  });
  // A single item still needs the box closed at the bottom.
  if (n === 1) {
    out[out.length - 1] = out[out.length - 1]
      .replace(/(<c r="H12") s="\d+"/, (m, a) => `${a} s="${(/<c r="H14" s="(\d+)"/.exec(byNo.get(T.lastItem)) || [])[1] || "47"}"`);
  }

  // Everything below the table, moved down — with a 4th payment row added
  // when there is one, and payment term 8 (the Blank Finance fee) taken out
  // when the invoice is paid in full.
  const pays = [toMoney(d.pay1), toMoney(d.pay2), toMoney(d.pay3), toMoney(d.pay4)];
  const balance = Math.round((total - pays[0] - pays[1] - pays[2] - pays[3]) * 100) / 100;
  const withPay4 = pays[3] !== 0;
  const termRow = (n) => {
    const r = rows.find(r => rowNo(r) > T.balance && new RegExp(`<c r="A${rowNo(r)}"[^>]*>\\s*<v>${n}</v>`).test(r));
    return r ? rowNo(r) : null;
  };
  const financeRow = d.fullPayment ? termRow(8) : null;     // "This Invoice includes a RM3,000 fee …"
  const mapRow = (from) => {
    if (from < T.after) return from;
    let to = from + shift;
    if (withPay4 && from > T.pay3) to += 1;
    if (financeRow && from > financeRow) to -= 1;
    return to;
  };

  for (const r of rows.filter(r => rowNo(r) >= T.after)) {
    const from = rowNo(r);
    if (from === financeRow) continue;
    const to = mapRow(from);
    let row = renumberRow(r, from, to);
    if (from === T.total) row = setCell(row, `G${to}`, { number: total });
    if (from === T.pay1)  row = setCell(row, `G${to}`, { number: pays[0] });
    if (from === T.pay2)  row = setCell(row, `G${to}`, { number: pays[1] });
    if (from === T.pay3)  row = setCell(row, `G${to}`, { number: pays[2] });
    if (from === T.balance) {
      const cells = [T.pay1, T.pay2, T.pay3].map(n => `G${mapRow(n)}`);
      if (withPay4) cells.push(`G${mapRow(T.pay3) + 1}`);
      row = setCell(row, `G${to}`, { formula: `G${mapRow(T.total)}-${cells.join("-")}`, number: balance });
    }
    // The term after the one removed moves up a number.
    if (financeRow && from > financeRow) {
      const m = new RegExp(`<c r="A${to}"[^>]*>\\s*<v>(\\d+)</v>`).exec(row);
      if (m) row = setCell(row, `A${to}`, { number: Number(m[1]) - 1 });
    }
    out.push(row);
    if (from === T.pay3 && withPay4) {
      const at4 = to + 1;
      let r4 = renumberRow(r, from, at4);
      r4 = setCell(r4, `E${at4}`, { inline: "4th Payment" });
      r4 = setCell(r4, `G${at4}`, { number: pays[3] });
      out.push(r4);
    }
  }

  // Merged ranges: one description merge per item, one Amount box for all.
  let newTail = tail.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/, (whole, inner) => {
    const refs = [...inner.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map(m => m[1]);
    const kept = [];
    for (const ref of refs) {
      const nums = (ref.match(/\d+/g) || []).map(Number);
      const lo = Math.min(...nums);
      if (lo >= T.firstItem && lo <= T.lastItem) continue;          // rebuilt below
      if (financeRow && nums.every(n => n === financeRow)) continue;  // the removed term
      kept.push(ref.replace(/([A-Z]+)(\d+)/g, (m, c, r) => c + mapRow(Number(r))));
    }
    for (let i = 0; i < n; i++) kept.push(`B${T.firstItem + i}:E${T.firstItem + i}`);
    kept.push(`G${T.firstItem}:H${T.firstItem + n - 1}`);
    if (withPay4) {
      const at4 = mapRow(T.pay3) + 1;
      kept.push(`E${at4}:F${at4}`, `G${at4}:H${at4}`);
    }
    return `<mergeCells count="${kept.length}">${kept.map(r => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>`;
  });

  const lastRow = mapRow(Math.max(...rows.map(rowNo)));
  const newHead = head.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:H${lastRow}"/>`);

  return newHead + "<sheetData>" + out.join("") + "</sheetData>" + newTail;
}

/**
 * Build the .xlsx in the browser.
 * @param {Uint8Array|ArrayBuffer} templateBytes
 * @param {object} data   see fillInvoiceSheet
 * @param {Function} PizZip
 * @returns {Blob}
 */
export function generateInvoiceXlsx(templateBytes, data, PizZip) {
  const zip = new PizZip(templateBytes);
  const sheetPath = "xl/worksheets/sheet1.xml";
  const sheet = zip.file(sheetPath);
  if (!sheet) throw new Error("The invoice template has no first worksheet.");
  const sst = zip.file("xl/sharedStrings.xml");
  let xml = inlineSharedMarkers(sheet.asText(), sst ? sst.asText() : "");
  xml = printWithoutGridlines(fillInvoiceSheet(xml, data));
  zip.file(sheetPath, xml);
  dropCalcChain(zip);
  return zip.generate({ type: "blob", mimeType: XLSX_MIME, compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// Making any saved-from-Excel template work
// ---------------------------------------------------------------------------

/** The text of each shared string, in order (rich text runs joined). */
export function sharedStringTexts(sstXml) {
  return [...String(sstXml || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(""));
}

/**
 * When Excel saves the template it moves {{BILL_TO}}, {{INVOICE_NO}} and
 * {{DATE}} into the shared-strings table, so the sheet only holds a number.
 * Put those three back into their cells as inline text, where the filler
 * looks for them.
 */
export function inlineSharedMarkers(sheetXml, sstXml) {
  const texts = sharedStringTexts(sstXml);
  return sheetXml.replace(/<c r="([A-Z]+\d+)"([^>]*?) t="s"([^>]*)>\s*<v>(\d+)<\/v>\s*<\/c>/g,
    (whole, ref, a, b, idx) => {
      const text = texts[Number(idx)];
      if (!/^\{\{[A-Z_]+\}\}$/.test(String(text || "").trim())) return whole;
      return `<c r="${ref}"${a}${b} t="inlineStr"><is><t xml:space="preserve">${text.trim()}</t></is></c>`;
    });
}

/**
 * No gridlines and no notes when the invoice is printed or saved as PDF —
 * from Excel, or once it is a Google Sheet.
 */
export function printWithoutGridlines(sheetXml) {
  return sheetXml
    .replace(/(<printOptions\b[^>]*?)\s+gridLines="[^"]*"/, "$1")
    .replace(/(<printOptions\b[^>]*?)\s+gridLinesSet="[^"]*"/, "$1")
    .replace(/(<pageSetup\b[^>]*?)\s+cellComments="[^"]*"/, "$1")
    .replace(/<sheetView\b(?![^>]*showGridLines)/, '<sheetView showGridLines="0"')
    .replace(/(<sheetView\b[^>]*?)showGridLines="1"/, '$1showGridLines="0"');
}

/**
 * calcChain.xml lists every formula cell by address. Adding item rows moves
 * the Balance formula, and a stale list makes Excel "repair" the file — so it
 * is removed; Excel rebuilds it on the next save.
 */
function dropCalcChain(zip) {
  if (!zip.file("xl/calcChain.xml")) return;
  zip.remove("xl/calcChain.xml");
  const ct = zip.file("[Content_Types].xml");
  if (ct) zip.file("[Content_Types].xml", ct.asText().replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ""));
  const rels = zip.file("xl/_rels/workbook.xml.rels");
  if (rels) zip.file("xl/_rels/workbook.xml.rels", rels.asText().replace(/<Relationship[^>]*Target="(?:\/xl\/)?calcChain\.xml"[^>]*\/>/, ""));
}

export async function fetchInvoiceTemplate() {
  const res = await fetch(INVOICE_TEMPLATE_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error(`The invoice template could not be loaded (HTTP ${res.status}). ` +
                               "It ships with the app in assets/ — check it was deployed.");
  return new Uint8Array(await res.arrayBuffer());
}

export function looksLikeXlsx(file) {
  return !!file && (/\.xlsx$/i.test(file.name || "") || file.type === XLSX_MIME);
}

export { XLSX_MIME };
