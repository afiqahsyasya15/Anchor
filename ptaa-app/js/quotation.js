// ---------------------------------------------------------------------------
// quotation.js — reading the line items out of a BLANKCO renovation quotation
// PDF, so the invoice can be pre-filled instead of retyped.
//
// The quotations are generated PDFs with real text in them (not scans), laid
// out as a table:
//
//   Item  Description                                   Nos  Unit  Total Price
//   1.1   Whole Unit Raid LED Track Light Set & ...
//         4000k Cool White with 12 watt power            1   Job    RM1,400
//         Work-safe with SIRIM Certified
//
// Two things make this less simple than it looks, and both are handled here:
//
//   1. The item number is vertically centred, so for a three-line item it sits
//      on the MIDDLE line, and the first line of the description is ABOVE it.
//      Items are therefore split on the white space between them, not on the
//      item number.
//   2. One item can hold several priced rows (1.3 "Shh Shh Toilet" has a mirror
//      AND a water heater, each with its own quantity). Each priced row becomes
//      its own invoice line, and the heading above them is dropped — which is
//      what the office's hand-made invoices do.
//
// Everything below the PDF-reading function is pure and has no DOM dependency,
// so it is tested directly — see tests/quotation.test.mjs.
// ---------------------------------------------------------------------------

/** "4   Nos   RM1,199" at the right-hand end of a line. */
const QTY_RE = /(?:^|\s)(\d{1,4})\s+([A-Za-z]{2,8})\.?\s+RM\s?([\d,]+(?:\.\d{1,2})?)\s*$/;

/** Item number at the start of a line: 1.1, 10.12 … */
const ITEM_NO_RE = /^(\d{1,2}\.\d{1,2})(?:\s+|$)/;

/** Lines that are never part of an item, and always end the current one. */
const SEPARATOR_RES = [
  /^Part\s*\d+\s*:/i,
  /^Total\s+Price\b/i,
  /^Page\s+\d+\s*$/i,
  /^Item\s+Description\b/i,
  /^Grand\s*total\b/i,
  /^Payment\s+terms/i,
  /^Full\s+payment\b/i,
  /^Bank\s+Account\b/i,
  /^Payable\s+to\b/i,
  /^For\s+Notes/i,
  /^QUOTATION\b/i,
  /^To\s+supply\s+&\s+install\s+unless/i,
  /^Address\s*:/i,
  /^Unit\s*:/i,
  /BLANKCO HOLDINGS SDN/i,
  /^\(Company No\./i,
  /^T:\s*\+?\d/i,
  /^E:\s*\S+@/i,
];

const isSeparator = (text) => SEPARATOR_RES.some(re => re.test(text));

export function parseAmount(s) {
  const n = Number(String(s || "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Text items → lines
// ---------------------------------------------------------------------------

/**
 * Group pdf.js text items into visual lines, top of the page first.
 *
 * @param {{items: Array<{str:string,x:number,y:number,w:number,h:number}>}} page
 * @returns {Array<{y:number, h:number, text:string}>}
 */
export function pageLines(page) {
  const items = (page.items || [])
    .filter(i => i && typeof i.str === "string" && i.str.trim() !== "")
    .map(i => ({ ...i, h: i.h || 8 }));

  // Highest first (PDF y grows upwards).
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines = [];
  for (const it of items) {
    const tol = Math.max(1.5, it.h * 0.35);
    let line = lines.find(l => Math.abs(l.y - it.y) <= tol);
    if (!line) { line = { y: it.y, h: it.h, items: [] }; lines.push(line); }
    line.items.push(it);
    line.h = Math.max(line.h, it.h);
  }

  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd = null;
    for (const it of l.items) {
      const gap = prevEnd === null ? 0 : it.x - prevEnd;
      if (text && gap > it.h * 0.2 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      text += it.str;
      prevEnd = it.x + (it.w || 0);
    }
    l.text = text.replace(/\s+/g, " ").trim();
    delete l.items;
  }
  lines.sort((a, b) => b.y - a.y);
  return lines;
}

// ---------------------------------------------------------------------------
// Lines → priced entries
// ---------------------------------------------------------------------------

/** Split a page's lines into blocks separated by white space or separator lines. */
function blocksOf(lines) {
  const blocks = [];
  let cur = [];
  let prev = null;
  const flush = () => { if (cur.length) blocks.push(cur); cur = []; };

  for (const line of lines) {
    if (isSeparator(line.text)) { flush(); prev = null; continue; }
    if (prev) {
      const gap = prev.y - line.y;
      const lh = Math.max(prev.h, line.h);
      // Lines inside one item are ~1.1 line-heights apart (up to ~1.6 where a
      // description wraps round a vertically centred price); consecutive items
      // are ~2 apart. 1.85 sits in the gap between the two on every quotation
      // seen so far.
      if (gap > lh * 1.85) flush();
    }
    cur.push(line);
    prev = line;
  }
  flush();
  return blocks;
}

/**
 * @param {Array<{items:Array}>} pages   pdf.js text content, one entry per page
 * @returns {{ entries: Array<{code,description,qty,unit,price}>, grandTotal: number|null }}
 */
export function parseQuotationPages(pages) {
  const entries = [];
  let grandTotal = null;
  let projectName = null;

  for (const page of pages || []) {
    const lines = pageLines(page);

    for (const l of lines) {
      const gt = /^Grand\s*total\b.*?RM\s?([\d,]+(?:\.\d{1,2})?)/i.exec(l.text);
      if (gt) grandTotal = parseAmount(gt[1]);
      const pj = /^QUOTATION\b.*?\bPROJECT\s+(.+)$/i.exec(l.text);
      if (pj && !projectName) projectName = pj[1].trim();
    }

    for (const block of blocksOf(lines)) {
      entries.push(...entriesFromBlock(block));
    }
  }
  return { entries, grandTotal, projectName };
}

function entriesFromBlock(block) {
  let code = null;
  const rows = block.map(l => {
    let text = l.text;
    const num = ITEM_NO_RE.exec(text);
    if (num) { code = code || num[1]; text = text.slice(num[0].length); }
    const q = QTY_RE.exec(text);
    if (q) {
      return {
        text: text.slice(0, q.index).trim(),
        qty: Number(q[1]), unit: q[2], price: parseAmount(q[3]),
      };
    }
    return { text: text.trim() };
  });

  const priced = rows.filter(r => r.qty !== undefined);
  if (!priced.length) return [];

  const clean = (parts) => joinWrapped(parts.map(s => s.trim()).filter(Boolean)).join("\n");

  if (priced.length === 1) {
    const p = priced[0];
    return [{ code, description: clean(rows.map(r => r.text)),
              qty: p.qty, unit: p.unit, price: p.price }];
  }

  // Several priced rows in one item: each starts its own entry, and anything
  // above the first one is a heading ("Shh Shh Toilet") that is dropped.
  const out = [];
  let current = null;
  for (const r of rows) {
    if (r.qty !== undefined) {
      current = { code, parts: [r.text], qty: r.qty, unit: r.unit, price: r.price };
      out.push(current);
    } else if (current) {
      current.parts.push(r.text);
    }
  }
  return out.map(e => ({ code: e.code, description: clean(e.parts),
                         qty: e.qty, unit: e.unit, price: e.price }));
}

/**
 * Put back together a sentence the PDF wrapped at the edge of the description
 * column, while keeping the deliberate line breaks (title / detail / warranty).
 *
 *   "…with Butter Cream in" + "color"             → joined (lower-case start)
 *   "…construction details" (long) + "drawing…"   → joined (previous line full)
 *   "…Latex Queen Size" + "Mattress"              → joined (one orphaned word)
 *   "Midea Dryer Machine" + "(5 year Warranty)"   → kept apart
 */
export function joinWrapped(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const wrapped = prev !== undefined && !/^[(\[]/.test(line) && (
      /^[a-z]/.test(line) ||
      /[+&,\-\/]$/.test(prev) ||
      prev.length >= 88 ||
      (/^[A-Z][\w'-]*$/.test(line) && prev.length >= 60)
    );
    if (wrapped) out[out.length - 1] = prev + " " + line;
    else out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entries → invoice lines
// ---------------------------------------------------------------------------

/** Items the office always shows as FOC on the invoice, whatever they cost. */
export const DEFAULT_FOC_ITEMS = [
  "High Security Smart Lock",
  "Smart Lock GateWay System",
];

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Turn quotation entries into invoice lines the way the hand-made invoices do:
 *
 *   - anything with quantity 0 is left out;
 *   - the same item in several rooms becomes ONE line with the quantities added
 *     (four rooms × 1 wardrobe → "Always Looking Good Wardrobe", 4);
 *   - the smart lock and its gateway are shown as FOC, at the end.
 *
 * @returns {Array<{description:string, qty:number|string, foc:boolean, amount:number}>}
 */
export function buildInvoiceItems(entries, { focItems = DEFAULT_FOC_ITEMS } = {}) {
  const foc = (focItems || []).map(norm).filter(Boolean);
  const merged = new Map();

  for (const e of entries || []) {
    if (!(Number(e.qty) > 0)) continue;
    const key = norm(e.description);
    if (!key) continue;
    if (merged.has(key)) {
      const m = merged.get(key);
      m.qty += Number(e.qty);
      m.amount += Number(e.price) || 0;
    } else {
      const firstLine = norm(String(e.description).split("\n")[0]);
      merged.set(key, {
        description: e.description,
        qty: Number(e.qty),
        amount: Number(e.price) || 0,
        foc: foc.some(f => firstLine.includes(f) || f.includes(firstLine)),
      });
    }
  }

  const all = [...merged.values()];
  const paid = all.filter(i => !i.foc);
  const free = all.filter(i => i.foc).map(i => ({ ...i, qty: "FOC" }));
  return [...paid, ...free];
}

/** Sum of the priced lines — used to sanity-check against the grand total. */
export function sumOfEntries(entries) {
  return (entries || []).reduce((s, e) => s + (Number(e.qty) > 0 ? (Number(e.price) || 0) : 0), 0);
}

// ---------------------------------------------------------------------------
// PDF → pages (browser only; pdf.js is loaded on demand by images.js)
// ---------------------------------------------------------------------------

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @param {object} pdfjs   the loaded pdf.js module
 */
export async function readPdfText(data, pdfjs) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items
        .filter(i => typeof i.str === "string")
        .map(i => ({
          str: i.str,
          x: i.transform[4], y: i.transform[5],
          w: i.width, h: i.height || Math.abs(i.transform[3]) || 8,
        })),
    });
  }
  return pages;
}
