// ---------------------------------------------------------------------------
// images.js — taking a photo or picking one from the album, then shrinking it
// enough to store.
//
// Why not Firebase Storage: since September 2024, provisioning a Cloud Storage
// bucket requires the Blaze (pay-as-you-go) plan, and this project is on Spark.
// So supporting images are downscaled in the browser and stored one-per-document
// in Firestore, which is on the free tier.
//
// That also makes brief §12 easy to honour: "not retained permanently" becomes
// a document delete, with nothing left behind in a bucket. If the project moves
// to Blaze later, swapping this for Storage touches only this file and the
// attachment helpers in requests.js.
// ---------------------------------------------------------------------------

import { findCardRects, contentRect } from "./icsplit.js";

/** Firestore's hard limit is 1 MiB per document. Stay well clear of it. */
export const MAX_STORED_BYTES = 600 * 1024;

/** Tried in order until the encoded result fits. */
const STEPS = [
  { maxEdge: 1600, quality: 0.75 },
  { maxEdge: 1400, quality: 0.70 },
  { maxEdge: 1100, quality: 0.65 },
  { maxEdge: 900,  quality: 0.60 },
  { maxEdge: 700,  quality: 0.55 },
];

export function isImageFile(file) {
  return !!file && typeof file.type === "string" && file.type.startsWith("image/");
}

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}

function draw(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";           // JPEG has no alpha; avoid black edges
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width: w, height: h };
}

/**
 * Shrink a picked or captured photo until it fits.
 * @returns {Promise<{dataUrl,bytes,width,height,originalBytes,originalName}>}
 */
export async function prepareImage(file) {
  if (!isImageFile(file)) {
    throw new Error(`“${file && file.name ? file.name : "That file"}” is not an image. Photos and screenshots only.`);
  }
  const img = await loadBitmap(file);

  let best = null;
  for (const step of STEPS) {
    best = draw(img, step.maxEdge, step.quality);
    if (best.dataUrl.length <= MAX_STORED_BYTES) break;
  }
  if (best.dataUrl.length > MAX_STORED_BYTES) {
    throw new Error("That image is too large even after shrinking. Crop it, or take the photo again at a lower resolution.");
  }

  return {
    dataUrl: best.dataUrl,
    bytes: best.dataUrl.length,
    width: best.width,
    height: best.height,
    originalBytes: file.size || 0,
    originalName: file.name || "photo.jpg",
  };
}

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

// ---------------------------------------------------------------------------
// PDF quotations
//
// A quotation arrives as whatever the renovation contractor sent the owner —
// a photo of a printout, a screenshot, or (usually) a PDF. Word cannot embed a
// PDF page, so each page is rendered to an image here, in the agent's browser,
// at the moment they attach it. Doing it at attach time rather than at document
// generation means what is stored IS what goes into the agreement: no surprises
// for the admin an hour later, and no PDF library needed on the generating side.
//
// pdf.js is 1.7 MB, so it is imported on demand. An agent who only ever attaches
// photographs never downloads it.
// ---------------------------------------------------------------------------

/** More than this and it is not a quotation, it is a brochure. */
export const MAX_PDF_PAGES = 10;

/** Rendered wide enough to stay sharp at ~16 cm across on the printed page. */
const PDF_RENDER_WIDTH = 1600;

let pdfLibPromise = null;

export function loadPdfLib() {
  if (pdfLibPromise) return pdfLibPromise;
  // Resolved from this module's own URL, not the page's, so it still works
  // wherever the app is not served from the site root (the test harness).
  const base = new URL("../vendor/", import.meta.url);
  pdfLibPromise = import(new URL("pdf.min.mjs", base).href)
    .then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", base).href;
      return lib;
    })
    .catch((err) => {
      pdfLibPromise = null;
      throw new Error(
        "The PDF reader could not be loaded, so this PDF cannot be attached. " +
        "It ships with the app, so this usually means vendor/ is missing from the " +
        "deployment. You can attach a screenshot of the quotation instead. " +
        `(${err.message})`);
    });
  return pdfLibPromise;
}

export function isPdfFile(file) {
  return !!file && (file.type === "application/pdf" ||
                    /\.pdf$/i.test(file.name || ""));
}

/**
 * Render every page of a PDF to a stored-size JPEG.
 * @param {File} file
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Array<{dataUrl,bytes,width,height,page,originalName,originalBytes}>>}
 */
export async function preparePdf(file, onProgress = null) {
  const pdfjs = await loadPdfLib();
  const data = new Uint8Array(await file.arrayBuffer());

  let doc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    throw new Error(
      `“${file.name || "That PDF"}” could not be read. If it is password-protected, ` +
      `remove the password or attach a screenshot instead. (${err.message})`);
  }

  const total = Math.min(doc.numPages, MAX_PDF_PAGES);
  const out = [];

  for (let n = 1; n <= total; n++) {
    if (onProgress) onProgress(n - 1, total);
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_RENDER_WIDTH / base.width });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    // A PDF page is transparent where nothing is drawn; on a JPEG that becomes
    // black, so the paper has to be painted first.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    out.push(shrinkCanvas(canvas, {
      page: n,
      originalName: file.name || "quotation.pdf",
      originalBytes: file.size || 0,
    }));
  }
  if (onProgress) onProgress(total, total);

  if (doc.numPages > MAX_PDF_PAGES) {
    out.truncatedFrom = doc.numPages;
  }
  return out;
}

/** Step a canvas down in quality until the encoded result fits Firestore. */
function shrinkCanvas(canvas, meta) {
  for (const quality of [0.72, 0.62, 0.52, 0.42]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= MAX_STORED_BYTES) {
      return { dataUrl, bytes: dataUrl.length,
               width: canvas.width, height: canvas.height, ...meta };
    }
  }
  // Still too big: halve the pixels and try once more, which always succeeds
  // for a page of text or a photographed quotation.
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(canvas.width / 2));
  small.height = Math.max(1, Math.round(canvas.height / 2));
  const ctx = small.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, small.width, small.height);
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const dataUrl = small.toDataURL("image/jpeg", 0.6);
  if (dataUrl.length > MAX_STORED_BYTES) {
    throw new Error(`Page ${meta.page} of that PDF is too dense to store. ` +
                    `Attach a screenshot of the quotation instead.`);
  }
  return { dataUrl, bytes: dataUrl.length,
           width: small.width, height: small.height, ...meta };
}

/** dataUrl (as stored) back to the raw bytes the document embedder needs. */
export function dataUrlToBytes(dataUrl) {
  const comma = String(dataUrl || "").indexOf(",");
  if (comma < 0) throw new Error("That stored image is unreadable.");
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Both sides of the I/C in one file
//
// A two-page PDF: page 1 is the front, page 2 the back. One picture (or a
// one-page PDF) with both cards on it: the cards are found and cut apart —
// see icsplit.js. If they cannot be told apart, the whole picture is used as
// the front and the back is left out.
// ---------------------------------------------------------------------------


const IC_RENDER_EDGE = 2000;

async function fileToCanvases(file) {
  if (isPdfFile(file)) {
    const pdfjs = await loadPdfLib();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    const out = [];
    for (let n = 1; n <= Math.min(2, doc.numPages); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: IC_RENDER_EDGE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      out.push(canvas);
    }
    return out;
  }
  if (!isImageFile(file)) throw new Error("Choose a photo or a PDF of the I/C.");
  const img = await loadBitmap(file);
  const scale = Math.min(1, IC_RENDER_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return [canvas];
}

/** Look at a small copy (fast), return rectangles in the canvas's own pixels. */
function analyse(canvas, fn) {
  const k = Math.min(1, 600 / Math.max(canvas.width, canvas.height));
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(canvas.width * k));
  small.height = Math.max(1, Math.round(canvas.height * k));
  const ctx = small.getContext("2d");
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  const found = fn(ctx.getImageData(0, 0, small.width, small.height));
  const up = (r) => ({ x: Math.round(r.x / k), y: Math.round(r.y / k), w: Math.round(r.w / k), h: Math.round(r.h / k) });
  if (!found) return null;
  if (Array.isArray(found.rects)) return { ...found, rects: found.rects.map(up) };
  return up(found);
}

function crop(canvas, r) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.min(r.w, canvas.width - r.x));
  c.height = Math.max(1, Math.min(r.h, canvas.height - r.y));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, r.x, r.y, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

/** Stored-size JPEG of a canvas, capped at 1600 px on the long edge. */
function storeCanvas(canvas, meta) {
  const k = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
  let c = canvas;
  if (k < 1) {
    c = document.createElement("canvas");
    c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return shrinkCanvas(c, { page: null, ...meta });
}

/**
 * @returns {Promise<{ front, back, how: "pages"|"stacked"|"side-by-side"|"whole" }>}
 *   front/back are stored-size images (back is null when "whole").
 */
export async function prepareIcBothSides(file) {
  const canvases = await fileToCanvases(file);
  const meta = { originalName: file.name || "ic.jpg", originalBytes: file.size || 0 };
  if (canvases.length >= 2) {
    const [f, b] = canvases.map(c => crop(c, analyse(c, contentRect)));
    return { front: storeCanvas(f, meta), back: storeCanvas(b, meta), how: "pages" };
  }
  const canvas = canvases[0];
  const found = analyse(canvas, findCardRects);
  if (!found) {
    return { front: storeCanvas(crop(canvas, analyse(canvas, contentRect)), meta), back: null, how: "whole" };
  }
  const [a, b] = found.rects.map(r => crop(canvas, r));
  return { front: storeCanvas(a, meta), back: storeCanvas(b, meta), how: found.layout };
}
