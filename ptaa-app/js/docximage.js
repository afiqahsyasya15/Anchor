// ---------------------------------------------------------------------------
// docximage.js — putting a signature image into the generated .docx.
//
// docxtemplater's image module is a paid add-on, so this does it directly on the
// Word package instead, which is only a few well-defined steps:
//
//   1. the template renders {{sig_agent}} as a unique text marker
//   2. the PNG is added to word/media/
//   3. a relationship is added to word/_rels/document.xml.rels
//   4. [Content_Types].xml gains a Default for the png extension
//   5. the run holding the marker is replaced by a <w:drawing> pointing at it
//
// Nothing is ever inserted automatically: the caller decides which signatures to
// pass in, and the UI asks for confirmation first (brief §10).
// ---------------------------------------------------------------------------

/** English Metric Units — Word's internal length. 914400 per inch. */
const EMU_PER_CM = 360000;

/** Signatures print at this height; width follows the image's aspect ratio. */
export const SIGNATURE_HEIGHT_CM = 2.0;
export const SIGNATURE_MAX_WIDTH_CM = 5.0;

/**
 * How big each kind of image prints, and whether one marker may become several.
 *
 * A signature is sized by HEIGHT — it has to match the line it sits on, and its
 * width follows from the handwriting. An I/C and a quotation are sized by WIDTH
 * — they fill the page they are pasted onto, and their height follows from the
 * scan. Getting that the wrong way round is what makes a scanned document look
 * like a ransom note.
 *
 * `multi` marks the slots where one placeholder can expand into several images,
 * which is what a quotation that arrives as a five-page PDF needs.
 */
export const IMAGE_SLOTS = {
  sig_director: { by: "height", cm: SIGNATURE_HEIGHT_CM, maxCm: SIGNATURE_MAX_WIDTH_CM },
  sig_agent:    { by: "height", cm: SIGNATURE_HEIGHT_CM, maxCm: SIGNATURE_MAX_WIDTH_CM },
  sig_admin:    { by: "height", cm: SIGNATURE_HEIGHT_CM, maxCm: SIGNATURE_MAX_WIDTH_CM },
  // A Malaysian MyKad is 85.6 x 54 mm. At 9 cm wide it reads comfortably and
  // two of them still fit on one page with room to breathe, which is how the
  // finished agreements have always looked.
  ic_front:     { by: "width", cm: 9.0, maxCm: 13.0 },
  ic_back:      { by: "width", cm: 9.0, maxCm: 13.0 },
  // A quotation gets a sheet of its own, starting straight after the Appendix A
  // heading. Squeezing it under that heading was tried and abandoned: only about
  // 13 cm of height is left there, which shrinks an A4 invoice to roughly 40% —
  // small enough that the line items stop being readable. A legal appendix whose
  // heading page introduces the document overleaf is normal; an unreadable
  // invoice is not.
  //
  // The break lives here rather than in the template so that a request with NO
  // quotation does not leave an empty sheet behind: no image, no break.
  quotation:    { by: "width", cm: 16.0, maxCm: 19.0, multi: true, breakBefore: true },
};

const DEFAULT_SLOT = { by: "width", cm: 12.0, maxCm: 20.0 };

/** A marker that will not occur in a legal document and needs no XML escaping. */
export function signatureMarker(tag) {
  return `[[ANCHORSIG:${tag}]]`;
}

/** Read width and height out of a PNG's IHDR chunk. */
export function pngSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (b[i] !== signature[i]) throw new Error("That image is not a PNG.");
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Read width and height out of a JPEG's frame header.
 *
 * Signatures are PNG because they need a transparent background, but a
 * photographed I/C or a rendered quotation page is a photograph: as PNG it
 * would be several megabytes and as JPEG it is a couple of hundred kilobytes,
 * for a document nobody will zoom into. So both formats have to work.
 */
export function jpegSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("That image is not a JPEG.");

  let at = 2;
  while (at < b.length - 1) {
    if (b[at] !== 0xff) { at++; continue; }            // resynchronise on padding
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = (b[at + 2] << 8) | b[at + 3];
    // SOF0..SOF15 hold the dimensions; C4 (Huffman), C8 (JPG) and CC (arithmetic
    // coding) share the range but are not frame headers.
    const isFrame = marker >= 0xc0 && marker <= 0xcf &&
                    marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: (b[at + 5] << 8) | b[at + 6], width: (b[at + 7] << 8) | b[at + 8] };
    }
    if (length < 2) break;                              // malformed; stop rather than loop
    at += 2 + length;
  }
  throw new Error("That JPEG has no frame header, so its size cannot be read.");
}

/** PNG or JPEG, whichever it turns out to be. */
export function imageKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0x89 && b[1] === 0x50) return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  throw new Error("That file is neither a PNG nor a JPEG, so it cannot go into the document.");
}

export function imageSize(bytes) {
  return imageKind(bytes) === "png" ? pngSize(bytes) : jpegSize(bytes);
}

/**
 * Work out the printed size in EMU, preserving the aspect ratio.
 * `by: "height"` fixes the height and caps the width; `by: "width"` the reverse.
 */
export function imageExtent({ width, height }, slot = DEFAULT_SLOT) {
  const spec = slot || DEFAULT_SLOT;
  const ratio = width / height;
  let cx, cy;

  if (spec.by === "height") {
    cy = spec.cm * EMU_PER_CM;
    cx = cy * ratio;
    const maxCx = spec.maxCm * EMU_PER_CM;
    if (cx > maxCx) { cx = maxCx; cy = cx / ratio; }
  } else {
    cx = spec.cm * EMU_PER_CM;
    cy = cx / ratio;
    const maxCy = spec.maxCm * EMU_PER_CM;
    if (cy > maxCy) { cy = maxCy; cx = cy * ratio; }
  }
  return { cx: Math.max(1, Math.round(cx)), cy: Math.max(1, Math.round(cy)) };
}

/** Kept for the signature call sites and their tests. */
export function signatureExtent(size) {
  return imageExtent(size, IMAGE_SLOTS.sig_director);
}

const NS = {
  wp:  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a:   "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  r:   "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};

/** One inline picture, as a complete <w:r> run ready to drop into a paragraph. */
export function drawingRunXml({ rId, cx, cy, id, name }) {
  const safeName = String(name || "signature").replace(/[<>&"]/g, "");
  return `<w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="${NS.wp}">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${id}" name="${safeName}" descr="${safeName}"/>` +
      `<wp:cNvGraphicFramePr/>` +
      `<a:graphic xmlns:a="${NS.a}">` +
        `<a:graphicData uri="${NS.pic}">` +
          `<pic:pic xmlns:pic="${NS.pic}">` +
            `<pic:nvPicPr><pic:cNvPr id="${id}" name="${safeName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill>` +
              `<a:blip xmlns:r="${NS.r}" r:embed="${rId}"/>` +
              `<a:stretch><a:fillRect/></a:stretch>` +
            `</pic:blipFill>` +
            `<pic:spPr>` +
              `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
              `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
            `</pic:spPr>` +
          `</pic:pic>` +
        `</a:graphicData>` +
      `</a:graphic>` +
    `</wp:inline>` +
  `</w:drawing></w:r>`;
}

// --- Package surgery --------------------------------------------------------

const RELS_PATH = "word/_rels/document.xml.rels";
const CT_PATH = "[Content_Types].xml";

function nextRelationshipNumber(relsXml) {
  let max = 0;
  for (const m of String(relsXml).matchAll(/Id="rId(\d+)"/g)) {
    max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Word refuses a package whose parts have no declared content type. */
function ensureImageContentType(zip, ext) {
  const xml = zip.file(CT_PATH).asText();
  if (new RegExp(`Extension="${ext}"`, "i").test(xml)) return;
  const type = ext === "png" ? "image/png" : "image/jpeg";
  zip.file(CT_PATH, xml.replace(
    /<Types([^>]*)>/, `<Types$1><Default Extension="${ext}" ContentType="${type}"/>`));
}

/** Body plus any headers and footers — a signature could live in any of them. */
function bodyParts(zip) {
  return Object.keys(zip.files || {}).filter(name =>
    /^word\/(document\d*\.xml|header\d*\.xml|footer\d*\.xml)$/.test(name));
}

/**
 * Replace each image marker with the picture — or pictures — it stands for.
 *
 * A slot may supply one image (a signature, an I/C side) or several (a
 * quotation that arrived as a multi-page PDF). Several images are separated by
 * page breaks, because an eight-page quotation running inline down one
 * paragraph is not something anybody wants to read.
 *
 * @param {object} zip     a PizZip holding the RENDERED document
 * @param {object} images  { [tag]: { bytes, name } | { pages: [{bytes,name}], name } }
 * @returns {{ placed: string[], missing: string[], counts: object }}
 *   placed  — tags found in the document and filled
 *   missing — tags present in the document with nothing supplied; their markers
 *             are removed so nothing leaks into the finished agreement
 *   counts  — how many pictures each placed tag became
 */
export function embedImages(zip, images) {
  const supplied = Object.entries(images || {})
    .map(([tag, v]) => [tag, normaliseSlot(v)])
    .filter(([, v]) => v && v.pages.length);
  const placed = [], missing = [], counts = {};

  let relsXml = zip.file(RELS_PATH) ? zip.file(RELS_PATH).asText() : null;
  if (!relsXml) throw new Error("This document has no relationship part; it may be corrupted.");

  let nextRel = nextRelationshipNumber(relsXml);
  let nextDocPr = 9000;                       // well clear of Word's own ids
  const newRels = [];
  const usedExtensions = new Set();

  const parts = bodyParts(zip);
  const partXml = new Map(parts.map(p => [p, zip.file(p).asText()]));

  for (const [tag, slotValue] of supplied) {
    const marker = signatureMarker(tag);
    const target = parts.find(p => partXml.get(p).includes(marker));
    if (!target) continue;                    // template does not use this one

    const spec = IMAGE_SLOTS[tag] || DEFAULT_SLOT;
    const pages = spec.multi ? slotValue.pages : slotValue.pages.slice(0, 1);

    const runs = pages.map((page, i) => {
      const bytes = page.bytes instanceof Uint8Array ? page.bytes : new Uint8Array(page.bytes);
      const ext = imageKind(bytes) === "png" ? "png" : "jpeg";
      const { cx, cy } = imageExtent(imageSize(bytes), spec);
      usedExtensions.add(ext);

      const rId = `rId${nextRel++}`;
      const mediaName = `anchor-${tag}${pages.length > 1 ? `-${i + 1}` : ""}.${ext}`;
      zip.file(`word/media/${mediaName}`, bytes, { binary: true });
      newRels.push(
        `<Relationship Id="${rId}" ` +
        `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
        `Target="media/${mediaName}"/>`);

      const run = drawingRunXml({
        rId, cx, cy, id: nextDocPr++,
        name: page.name || slotValue.name || tag,
      });
      // A page break before every picture after the first, so each page of a
      // multi-page quotation starts on its own sheet — and before the first one
      // too when the slot asks for it.
      const needsBreak = i > 0 || spec.breakBefore;
      return needsBreak ? `<w:r><w:br w:type="page"/></w:r>${run}` : run;
    }).join("");

    // Replace the whole run that carries the marker, so the marker's own text
    // formatting does not survive around the picture.
    const runRe = new RegExp(
      `<w:r(?:\\s[^>]*)?>(?:(?!</w:r>)[\\s\\S])*?${escapeRe(marker)}(?:(?!</w:r>)[\\s\\S])*?</w:r>`, "g");

    let xml = partXml.get(target);
    if (runRe.test(xml)) {
      runRe.lastIndex = 0;
      xml = xml.replace(runRe, runs);
    } else {
      // Fall back to swapping just the marker text — happens only if Word split
      // it across runs, which docxtemplater normally prevents.
      xml = xml.split(marker).join("");
    }
    partXml.set(target, xml);
    placed.push(tag);
    counts[tag] = pages.length;
  }

  // Any marker still in the document had no image supplied. Strip it, so the
  // agreement shows an empty signature line rather than "[[ANCHORSIG:…]]".
  for (const [name, xml] of partXml) {
    let out = xml;
    const leftovers = out.match(/\[\[ANCHORSIG:([a-z_]+)\]\]/g) || [];
    for (const found of leftovers) {
      const tag = found.slice("[[ANCHORSIG:".length, -2);
      if (!missing.includes(tag)) missing.push(tag);
    }
    if (leftovers.length) out = out.replace(/\[\[ANCHORSIG:[a-z_]+\]\]/g, "");
    zip.file(name, out);
  }

  if (newRels.length) {
    for (const ext of usedExtensions) ensureImageContentType(zip, ext);
    relsXml = relsXml.replace(/<\/Relationships>\s*$/, newRels.join("") + "</Relationships>");
    zip.file(RELS_PATH, relsXml);
  }

  return { placed, missing, counts };
}

/** One image, or several pages, or nothing — all expressed the same way. */
function normaliseSlot(value) {
  if (!value) return null;
  if (Array.isArray(value.pages)) {
    return { name: value.name || null, pages: value.pages.filter(p => p && p.bytes) };
  }
  return value.bytes ? { name: value.name || null, pages: [value] } : null;
}

/**
 * Signatures were the first thing this file did, and the name is still how the
 * generation code talks about them. Kept so those call sites and their tests
 * read the way they always have.
 */
export function embedSignatures(zip, signatures) {
  const { placed, missing } = embedImages(zip, signatures);
  return { placed, missing };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
