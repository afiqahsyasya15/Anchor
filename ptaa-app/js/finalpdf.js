// ---------------------------------------------------------------------------
// finalpdf.js — the complete PTAA as one PDF: the agreement, with the invoice
// placed inside Appendix A, exactly like the office's finished copies
// (e.g. "PTAA DTERRA B-40-09 Chester Tie Lik Hieng.pdf": pages 1–20 the
// agreement up to the Appendix A page, then the invoice, then Appendix B).
//
// The joining is done in the browser with pdf-lib (vendored). The two halves
// come either from Google Drive (the Word file converted, the invoice Sheet
// exported) or from PDFs the admin saved herself.
// ---------------------------------------------------------------------------

import { loadPdfLib } from "./images.js";

const VENDOR = new URL("../vendor/", import.meta.url).href;
let pdfLibPromise = null;

export function loadPdfJoiner() {
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((resolve, reject) => {
    if (window.PDFLib) { resolve(window.PDFLib); return; }
    const s = document.createElement("script");
    s.src = VENDOR + "pdf-lib.min.js";
    s.onload = () => window.PDFLib ? resolve(window.PDFLib)
      : reject(new Error("The PDF joiner loaded but did not register."));
    s.onerror = () => reject(new Error("The PDF joiner (vendor/pdf-lib.min.js) could not be loaded — check it was deployed."));
    document.head.append(s);
  }).catch(err => { pdfLibPromise = null; throw err; });
  return pdfLibPromise;
}

/**
 * Where the invoice goes, as a 0-based page index to insert BEFORE.
 *
 *   - before the page that starts APPENDIX B (so it closes Appendix A, even
 *     when Appendix A already holds quotation pages), else
 *   - straight after the APPENDIX A page, else
 *   - at the end.
 *
 * @param {string[]} pageTexts   the text of each page
 */
export function invoiceInsertIndex(pageTexts) {
  // The appendix HEADING opens its page (after any page number or blank
  // run); a clause elsewhere that merely mentions "Appendix B" does not count.
  const norm = (t) => String(t || "").replace(/[​\s]+/g, " ").trim().toUpperCase();
  const texts = pageTexts.map(norm);
  const opens = (t, letter) => new RegExp(`^(\\d+ )?APPENDIX ${letter}\\b`).test(t);
  const b = texts.findIndex(t => opens(t, "B"));
  const a = texts.findIndex(t => opens(t, "A"));
  if (b > 0 && (a < 0 || b > a)) return b;
  if (a >= 0) return a + 1;
  return texts.length;
}

export async function pdfPageTexts(bytes) {
  const pdfjs = await loadPdfLib();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    out.push(tc.items.map(i => i.str || "").join(" "));
  }
  return out;
}

/**
 * @returns {Promise<{ bytes: Uint8Array, pages: number, insertedAt: number, invoicePages: number }>}
 */
export async function joinPtaaAndInvoice(ptaaPdf, invoicePdf) {
  const PDFLib = await loadPdfJoiner();
  const texts = await pdfPageTexts(ptaaPdf.slice ? ptaaPdf.slice(0) : ptaaPdf);
  const at = invoiceInsertIndex(texts);

  const out = await PDFLib.PDFDocument.load(ptaaPdf, { ignoreEncryption: true });
  const inv = await PDFLib.PDFDocument.load(invoicePdf, { ignoreEncryption: true });
  const pages = await out.copyPages(inv, inv.getPageIndices());
  pages.forEach((p, i) => out.insertPage(at + i, p));
  const bytes = await out.save();
  return { bytes, pages: out.getPageCount(), insertedAt: at, invoicePages: pages.length };
}

export function looksLikePdf(file) {
  return !!file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
}
