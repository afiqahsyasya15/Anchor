// ---------------------------------------------------------------------------
// screens-sign.js — "Sign a PDF": the Director's signature goes on AFTER the
// Owner has signed, so it is put onto the returned PDF, not the Word draft.
//
//   Upload the PDF  →  tick which signature goes where  →  download the PDF
//
// A PDF with text (saved from Word, or signed digitally) has its signature
// lines found automatically. A scanned PDF has none, so a signature is placed
// by clicking on the page. Nothing is uploaded anywhere: the file is read,
// signed and downloaded in this browser only.
// ---------------------------------------------------------------------------

import { h, mount, friendlyError } from "./core.js";
import { card, button, badge, select, loading, errorBox, noticeBox, toast } from "./ui.js";
import { listSignatures, loadSignatureBytes } from "./signatures.js";
import { loadPdfLib } from "./images.js";
import { loadPdfJoiner, looksLikePdf } from "./finalpdf.js";
import { detectSignatureSpots, placementForSpot, stampSignatures } from "./pdfsign.js";
import { downloadBlob } from "./docx.js";

const VIEW_WIDTH = 760;        // on-screen page width, px

export function signPdfScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  let signatures = [];
  const sigBytes = new Map();   // key -> Uint8Array
  const sigUrl = new Map();     // key -> object URL
  let file = null, pdfBytes = null, pdfDoc = null;
  let spots = [];               // detected lines
  let chosen = new Map();       // spot index -> signature key ("" = none)
  let manual = [];              // { page, x, y, width, key }
  let pageNo = 1;
  let sigForClicks = "";
  let width = 110;              // signature width in PDF points (~3.9 cm)

  async function bytesOf(key) {
    if (!sigBytes.has(key)) sigBytes.set(key, await loadSignatureBytes(key));
    return sigBytes.get(key);
  }
  async function urlOf(key) {
    if (!sigUrl.has(key)) sigUrl.set(key, URL.createObjectURL(new Blob([await bytesOf(key)], { type: "image/png" })));
    return sigUrl.get(key);
  }
  const sigLabel = (key) => { const s = signatures.find(x => x.id === key); return s ? (s.label || s.id) : key; };
  const director = () => (signatures.find(s => s.isDirector) || {}).id || "";

  // --- reading the PDF -----------------------------------------------------

  async function take(f) {
    if (!looksLikePdf(f)) { toast("Choose a PDF file.", "error"); return; }
    file = f; manual = []; chosen = new Map(); pageNo = 1;
    mount(host, loading("Reading the PDF…"));
    try {
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      const pdfjs = await loadPdfLib();
      pdfDoc = await pdfjs.getDocument({ data: pdfBytes.slice(0), isEvalSupported: false }).promise;
      const pages = [];
      for (let n = 1; n <= pdfDoc.numPages; n++) {
        const tc = await (await pdfDoc.getPage(n)).getTextContent();
        pages.push({ items: tc.items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height })) });
      }
      spots = detectSignatureSpots(pages);
      // The Director signs for the Tenancy Administrator; the rest are left
      // for their owners unless ticked.
      spots.forEach((s, i) => chosen.set(i, s.isCompany ? director() : ""));
      const firstCompany = spots.find(s => s.isCompany);
      pageNo = firstCompany ? firstCompany.page + 1 : 1;
      sigForClicks = director() || (signatures[0] || {}).id || "";
      render();
    } catch (err) {
      mount(host, errorBox("That PDF could not be read: " + (err.message || err)));
    }
  }

  // --- the page view ---------------------------------------------------------

  const canvas = h("canvas", { class: "sign-canvas" });
  const overlay = h("div", { class: "sign-overlay" });
  const pageBox = h("div", { class: "sign-page" }, canvas, overlay);
  let viewport = null;

  async function drawPage() {
    const page = await pdfDoc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    viewport = page.getViewport({ scale: VIEW_WIDTH / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    pageBox.style.width = canvas.width + "px";
    pageBox.style.height = canvas.height + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    await drawOverlay();
  }

  function allPlacements() {
    const out = [];
    spots.forEach((s, i) => {
      const key = chosen.get(i);
      if (key) out.push({ ...placementForSpot(s, width), key, from: "spot", index: i });
    });
    manual.forEach((m, i) => out.push({ ...m, from: "manual", index: i }));
    return out;
  }

  async function drawOverlay() {
    overlay.replaceChildren();
    if (!viewport) return;
    for (const p of allPlacements().filter(p => p.page === pageNo - 1)) {
      const url = await urlOf(p.key);
      const img = h("img", { class: "sign-mark", src: url, alt: sigLabel(p.key),
        title: p.from === "manual" ? "Click to remove" : sigLabel(p.key) });
      // PDF points (y up) → pixels (y down); the image's BOTTOM-left sits at (x, y).
      const [left, bottom] = viewport.convertToViewportPoint(p.x, p.y);
      const pxWidth = p.width * viewport.scale;
      img.style.left = left + "px";
      img.style.width = pxWidth + "px";
      img.onload = () => {
        const ratio = img.naturalWidth ? img.naturalHeight / img.naturalWidth : 0.4;
        img.style.top = (bottom - pxWidth * ratio) + "px";
      };
      img.style.top = (bottom - pxWidth * 0.4) + "px";
      if (p.from === "manual") {
        img.addEventListener("click", (e) => { e.stopPropagation(); manual.splice(p.index, 1); drawOverlay(); renderList(); });
      }
      overlay.append(img);
    }
  }

  overlay.addEventListener("click", async (e) => {
    if (!sigForClicks) { toast("Choose which signature to place first.", "warn"); return; }
    const rect = overlay.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const [x, y] = viewport.convertToPdfPoint(px, py);
    // Clicked point = the middle of the signature's bottom edge.
    manual.push({ page: pageNo - 1, x: x - width / 2, y, width, key: sigForClicks });
    await drawOverlay(); renderList();
  });

  // --- the controls ----------------------------------------------------------

  const listHost = h("div", {});
  function renderList() {
    const opts = [{ value: "", label: "— none —" },
                  ...signatures.map(s => ({ value: s.id, label: (s.label || s.id) + (s.isDirector ? " (Director)" : "") }))];
    mount(listHost,
      spots.length
        ? h("div", { class: "sign-spots" }, spots.map((s, i) => h("div", { class: "confirm-row" },
            h("div", {},
              h("strong", {}, `Page ${s.page + 1} · ${s.role}`), " ",
              s.isCompany ? badge("Director signs here", "brand") : null,
              h("p", { class: "muted small" }, s.name || s.heading)),
            h("div", { class: "actions" },
              select({ id: `spot-${i}`, value: chosen.get(i) || "", options: opts,
                onChange: (e) => { chosen.set(i, e.target.value); drawOverlay(); } }),
              button("Show", { variant: "quiet", onClick: () => { pageNo = s.page + 1; renderPager(); drawPage(); } })),
          )))
        : noticeBox("info", h("p", { class: "small" },
            "No signature lines were found in this PDF — it is probably a scan. Click on the page below ",
            "where the signature should go.")),
      manual.length
        ? h("p", { class: "small" }, `${manual.length} placed by hand — click one on the page to remove it.`)
        : null,
    );
  }

  const pager = h("div", { class: "actions" });
  function renderPager() {
    mount(pager,
      button("‹ Previous", { variant: "quiet", disabled: pageNo <= 1, onClick: () => { pageNo--; renderPager(); drawPage(); } }),
      h("span", { class: "muted small" }, `Page ${pageNo} of ${pdfDoc.numPages}`),
      button("Next ›", { variant: "quiet", disabled: pageNo >= pdfDoc.numPages, onClick: () => { pageNo++; renderPager(); drawPage(); } }),
    );
  }

  async function download() {
    const placements = allPlacements();
    if (!placements.length) { toast("Nothing to sign yet — choose a signature for a line, or click on the page.", "warn"); return; }
    try {
      const PDFLib = await loadPdfJoiner();
      const withBytes = [];
      for (const p of placements) withBytes.push({ ...p, png: await bytesOf(p.key) });
      const out = await stampSignatures(pdfBytes, withBytes, PDFLib);
      const name = String(file.name || "signed.pdf").replace(/\.pdf$/i, "") + " (signed).pdf";
      downloadBlob(new Blob([out], { type: "application/pdf" }), name);
      toast(`Signed PDF downloaded — ${placements.length} signature${placements.length === 1 ? "" : "s"}.`);
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function render() {
    const clickSel = select({ id: "sig-click", value: sigForClicks,
      options: signatures.map(s => ({ value: s.id, label: (s.label || s.id) + (s.isDirector ? " (Director)" : "") })),
      onChange: (e) => { sigForClicks = e.target.value; } });
    const sizeSel = select({ id: "sig-size", value: String(width), options: [
      { value: "85", label: "Small (3 cm)" }, { value: "110", label: "Normal (4 cm)" }, { value: "140", label: "Large (5 cm)" }],
      onChange: (e) => { width = Number(e.target.value); drawOverlay(); } });

    mount(host,
      card("2 · Tick which signature goes where",
        h("p", { class: "muted small" }, `“${file.name}” — ${pdfDoc.numPages} pages.`),
        listHost,
        h("div", { class: "form-grid" },
          h("div", { class: "field" }, h("label", { class: "field-label", for: "sig-click" }, "Signature placed by clicking"), clickSel),
          h("div", { class: "field" }, h("label", { class: "field-label", for: "sig-size" }, "Size"), sizeSel)),
      ),
      card("Preview",
        pager,
        h("div", { class: "sign-scroll" }, pageBox),
        h("p", { class: "muted small" }, "Click anywhere on the page to put the chosen signature there."),
      ),
      h("div", { class: "form-actions" },
        button("3 · Download the signed PDF", { variant: "primary", onClick: download }),
        button("Start again", { variant: "quiet", onClick: () => { file = null; start(); } })),
    );
    renderList(); renderPager(); drawPage();
  }

  function start() {
    const input = h("input", { type: "file", accept: ".pdf,application/pdf", class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) take(f); } });
    mount(host,
      signatures.length ? null : noticeBox("warn",
        h("p", {}, "No signature images yet. Add the Director's under ",
          button("Signatures", { variant: "link", onClick: () => navigate("signatures") }), " first.")),
      card("1 · Upload the PDF",
        h("p", { class: "muted small" },
          "The PTAA as it came back signed by the Owner. It is read in this browser only — nothing is uploaded."),
        h("div", { class: "actions" }, input,
          button("Choose PDF…", { variant: "primary", onClick: () => input.click() }))),
    );
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Sign a PDF"),
      h("p", { class: "screen-sub" },
        "Upload the PTAA the Owner has signed, tick which signature goes on which line, and download it signed."),
      host);
    mount(host, loading());
    try {
      signatures = await listSignatures();
      start();
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}
