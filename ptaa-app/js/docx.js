// ---------------------------------------------------------------------------
// docx.js — reading a .docx, checking it, and filling it.
//
// PizZip and docxtemplater are vendored in vendor/ and loaded on demand, only
// on the screens that need them. They are served from this app's own origin
// rather than a CDN, because a corporate proxy that blocks an unfamiliar domain
// would otherwise break document generation with no obvious cause.
//
// Brief §2: fill placeholders inside the existing .docx XML in place. Do NOT
// rebuild the layout, and do not generate the PTAA as HTML and convert it.
// ---------------------------------------------------------------------------

import { validateTemplate, buildTemplateData, DELIMITERS } from "./placeholders.js";
import { embedImages, signatureMarker } from "./docximage.js";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// --- Lazy library loading ---------------------------------------------------

let libsPromise = null;

// Resolved from this module's own URL, not the page's. A page-relative path
// would break wherever the app is not served from the site root — including the
// test harness, which lives in a subfolder.
const VENDOR = new URL("../vendor/", import.meta.url).href;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) { existing.addEventListener("load", resolve); existing.addEventListener("error", reject); return; }
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(
      `Could not load ${src}. It ships with the app, so this usually means the file is missing from the deployment.`));
    document.head.append(s);
  });
}

export function loadDocxLibs() {
  if (libsPromise) return libsPromise;
  libsPromise = (async () => {
    await injectScript(VENDOR + "pizzip.min.js");
    await injectScript(VENDOR + "docxtemplater.min.js");
    const PizZip = window.PizZip;
    const Docxtemplater = window.docxtemplater;
    if (!PizZip || !Docxtemplater) {
      throw new Error("The document libraries loaded but did not register. Check vendor/ is deployed.");
    }
    return { PizZip, Docxtemplater };
  })().catch(err => { libsPromise = null; throw err; });
  return libsPromise;
}

// --- Reading ----------------------------------------------------------------

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("That file could not be read."));
    r.readAsArrayBuffer(file);
  });
}

export function looksLikeDocx(file) {
  if (!file) return false;
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".doc")) return false;              // old binary format
  return name.endsWith(".docx") || file.type === DOCX_MIME;
}

/** The parts of a .docx that can carry a placeholder. */
function templateParts(zip) {
  const parts = [];
  const names = Object.keys(zip.files || {});
  for (const name of names) {
    if (/^word\/(document\d*\.xml|header\d*\.xml|footer\d*\.xml)$/.test(name)) {
      parts.push({ name, xml: zip.file(name).asText() });
    }
  }
  return parts;
}

/**
 * Open a .docx and check it against brief §5.2.
 * @returns {{ zip, parts, result, bytes }}
 */
export async function inspectTemplate(file) {
  if (!looksLikeDocx(file)) {
    throw new Error(String(file && file.name || "That file") +
      " is not a .docx. If it is an older .doc, open it in Word and use Save As → Word Document (.docx).");
  }
  const { PizZip } = await loadDocxLibs();
  const buffer = await readFileAsArrayBuffer(file);

  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw new Error("That file is not a readable Word document — it may be corrupted or password-protected.");
  }
  if (!zip.file("word/document.xml")) {
    throw new Error("That .docx has no document body. It may be corrupted, or saved in an unusual format.");
  }

  const parts = templateParts(zip);
  const result = validateTemplate(parts.map(p => p.xml));
  return { zip, parts, result, bytes: buffer.byteLength };
}

// --- Filling ----------------------------------------------------------------

/**
 * Fill a template with one request's data and return a Blob.
 *
 * @param {ArrayBuffer|Uint8Array} templateBytes
 * @param {object} request     the request record
 * @param {object} opts
 *   - property     the property record, for the Owner Group Admin details
 *   - signatures   { sig_director|sig_agent|sig_admin: { bytes, name } }
 *   - attachments  { ic_front|ic_back|quotation: { pages: [{bytes,name}] } }
 *                  Only what is passed gets placed; any image slot in the
 *                  template with nothing supplied is left blank, and its marker
 *                  is stripped rather than printed.
 */
export async function generateDocx(templateBytes, request, opts = {}) {
  const { PizZip, Docxtemplater } = await loadDocxLibs();
  const { property = null, signatures = {}, attachments = {} } = opts;

  const data = buildTemplateData(request, { property, signatureMarker });

  let doc;
  try {
    doc = new Docxtemplater(new PizZip(templateBytes), {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: DELIMITERS,
      // An unknown placeholder becomes empty rather than throwing, so one stray
      // tag cannot block a document. Unknown tags are reported at upload time.
      nullGetter: () => "",
    });
    doc.render(data);
  } catch (err) {
    throw new Error(explainRenderError(err));
  }

  const zip = doc.getZip();
  // Every picture goes in after rendering — see docximage.js for why. One pass
  // for both kinds, so a quotation and a signature cannot fight over
  // relationship ids.
  const signatureResult = embedImages(zip, { ...signatures, ...attachments });

  const out = zip.generate({
    type: "blob",
    mimeType: DOCX_MIME,
    compression: "DEFLATE",
  });
  return { blob: out, data, signatures: signatureResult };
}

/** docxtemplater's multi-error objects are unreadable raw; unwrap them. */
function explainRenderError(err) {
  const props = err && err.properties;
  if (props && Array.isArray(props.errors) && props.errors.length) {
    const lines = props.errors.slice(0, 6).map(e => {
      const p = e.properties || {};
      const where = p.xtag ? `{{${p.xtag}}}` : "";
      return `  ${p.explanation || e.message}${where ? ` — ${where}` : ""}`;
    });
    return "The template could not be filled:\n" + lines.join("\n") +
           "\n\nThis usually means a placeholder was typed with a missing or extra brace. " +
           "Fix it in Word and upload the template again.";
  }
  return "The template could not be filled: " + (err && err.message ? err.message : String(err));
}

// --- Download ---------------------------------------------------------------

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke a moment later; revoking immediately cancels the download in some
  // browsers before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// --- Base64 <-> bytes -------------------------------------------------------
// Templates are stored in Firestore as base64 chunks (see requests.js), because
// Cloud Storage needs the Blaze plan and this project is on Spark.

export function bytesToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;                       // avoid blowing the argument list
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
