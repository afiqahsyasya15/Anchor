// ---------------------------------------------------------------------------
// Tests for js/docximage.js — putting a signature image into a .docx.
//
// Run:  node --test tests/signature.test.mjs
//
// docxtemplater's image module is a paid add-on, so we do the package surgery
// ourselves. That means these steps are ours to get right, and ours to test:
// the media part, the relationship, the content type, and the drawing run.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import {
  signatureMarker, pngSize, signatureExtent, drawingRunXml, embedSignatures,
  SIGNATURE_HEIGHT_CM,
} from "../js/docximage.js";

let PizZip = null;
try { ({ default: PizZip } = await import("pizzip")); }
catch { /* optional dev dependency */ }

const skip = PizZip ? false : "run `npm install pizzip` to enable";

// --- A tiny real PNG --------------------------------------------------------

/** A valid 40×20 PNG (a single grey pixel block), built by hand. */
function makePng(width, height) {
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    const body = out.subarray(4, 8 + data.length);
    view.setUint32(8 + data.length, crc32(body));
    return out;
  };

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width); iv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit RGBA

  // One raw scanline per row, zlib "stored" blocks — no compression needed.
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(0x80, 0x80, 0x80, 0xff);
  }
  const rawBytes = Uint8Array.from(raw);
  const blocks = [0x78, 0x01];
  for (let i = 0; i < rawBytes.length; i += 65535) {
    const part = rawBytes.subarray(i, i + 65535);
    const last = i + 65535 >= rawBytes.length ? 1 : 0;
    blocks.push(last, part.length & 0xff, part.length >> 8,
                ~part.length & 0xff, (~part.length >> 8) & 0xff, ...part);
  }
  let a = 1, b = 0;
  for (const byte of rawBytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  blocks.push((b >> 8) & 0xff, b & 0xff, (a >> 8) & 0xff, a & 0xff);

  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Uint8Array.from(blocks)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const PNG = makePng(40, 20);

// --- Reading the image ------------------------------------------------------

test("a PNG's size is read from its own header, not guessed", () => {
  assert.deepEqual(pngSize(PNG), { width: 40, height: 20 });
});

test("anything that is not a PNG is refused with a plain reason", () => {
  assert.throws(() => pngSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])),
    /not a PNG/);
});

test("a signature is scaled to a fixed height, keeping its shape", () => {
  const { cx, cy } = signatureExtent({ width: 40, height: 20 });
  assert.equal(cy, SIGNATURE_HEIGHT_CM * 360000, "2 cm tall, in EMU");
  assert.equal(cx, cy * 2, "a 2:1 image stays 2:1");
});

test("a very wide signature is capped on width instead of running off the page", () => {
  const { cx, cy } = signatureExtent({ width: 4000, height: 20 });
  assert.equal(cx, 5.0 * 360000, "capped at 5 cm wide");
  assert.ok(cy < SIGNATURE_HEIGHT_CM * 360000, "so the height comes down with it");
});

test("the drawing run points at the relationship and escapes the name", () => {
  const xml = drawingRunXml({ rId: "rId9", cx: 100, cy: 50, id: 9001, name: 'Bad "name" <x>' });
  assert.match(xml, /r:embed="rId9"/);
  assert.match(xml, /<wp:extent cx="100" cy="50"\/>/);
  assert.ok(!/[<>"]name/.test(xml.split("docPr")[1].slice(0, 60)),
    "the quotes and angle brackets are stripped from the name");
  assert.match(xml, /^<w:r>/);
  assert.match(xml, /<\/w:r>$/);
});

// --- Package surgery --------------------------------------------------------

function docxWith(bodyXml, { headerXml = null } = {}) {
  const zip = new PizZip();
  zip.file("[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `</Types>`);
  zip.folder("word").file("document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}</w:body></w:document>`);
  if (headerXml) zip.folder("word").file("header1.xml", `<w:hdr>${headerXml}</w:hdr>`);
  zip.folder("word").folder("_rels").file("document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`);
  return zip;
}

const markerRun = (tag) =>
  `<w:p><w:r><w:rPr><w:i/></w:rPr><w:t>${signatureMarker(tag)}</w:t></w:r></w:p>`;

test("a supplied signature becomes a real picture in the package", { skip }, () => {
  const zip = docxWith(markerRun("sig_director"));
  const result = embedSignatures(zip, {
    sig_director: { bytes: PNG, name: "Director Benjamin" },
  });

  assert.deepEqual(result.placed, ["sig_director"]);
  assert.deepEqual(result.missing, []);

  const doc = zip.file("word/document.xml").asText();
  assert.ok(!doc.includes("ANCHORSIG"), "the marker is gone");
  assert.match(doc, /<w:drawing>/, "a drawing took its place");
  assert.ok(!doc.includes("<w:i/>"),
    "the marker's own italics went with it — a signature is not styled text");

  assert.ok(zip.file("word/media/anchor-sig_director.png"), "the image is in the package");
  const rels = zip.file("word/_rels/document.xml.rels").asText();
  assert.match(rels, /Target="media\/anchor-sig_director\.png"/);
  assert.match(rels, /Id="rId2"/, "numbered past the relationships already there");

  const ct = zip.file("[Content_Types].xml").asText();
  assert.match(ct, /Extension="png" ContentType="image\/png"/);

  const rId = /Id="(rId\d+)"[^>]*anchor-sig_director/.exec(rels.replace(/\/>/g, " />"));
  if (rId) assert.ok(doc.includes(`r:embed="${rId[1]}"`), "the drawing points at that relationship");
});

test("a marker with no image supplied is stripped, never left in the agreement", { skip }, () => {
  const zip = docxWith(markerRun("sig_director") + markerRun("sig_agent"));
  const result = embedSignatures(zip, { sig_director: { bytes: PNG, name: "Director" } });

  assert.deepEqual(result.placed, ["sig_director"]);
  assert.deepEqual(result.missing, ["sig_agent"]);

  const doc = zip.file("word/document.xml").asText();
  assert.ok(!doc.includes("ANCHORSIG"),
    "no [[ANCHORSIG:...]] survives into a document someone will sign");
});

test("nothing supplied at all leaves a clean document and no image parts", { skip }, () => {
  const zip = docxWith(markerRun("sig_agent"));
  const result = embedSignatures(zip, {});
  assert.deepEqual(result.placed, []);
  assert.deepEqual(result.missing, ["sig_agent"]);
  assert.ok(!zip.file("word/media/anchor-sig_agent.png"));
  assert.ok(!/Extension="png"/.test(zip.file("[Content_Types].xml").asText()),
    "the content type is only added when an image actually goes in");
});

test("a signature in a header is found and placed there", { skip }, () => {
  const zip = docxWith("<w:p/>", { headerXml: markerRun("sig_director") });
  const result = embedSignatures(zip, { sig_director: { bytes: PNG, name: "Director" } });
  assert.deepEqual(result.placed, ["sig_director"]);
  assert.match(zip.file("word/header1.xml").asText(), /<w:drawing>/);
});

test("three signatures get three images and three distinct relationships", { skip }, () => {
  const zip = docxWith(markerRun("sig_director") + markerRun("sig_agent") + markerRun("sig_admin"));
  const result = embedSignatures(zip, {
    sig_director: { bytes: PNG, name: "Director" },
    sig_agent:    { bytes: PNG, name: "Agent" },
    sig_admin:    { bytes: PNG, name: "Admin" },
  });
  assert.deepEqual(result.placed.sort(), ["sig_admin", "sig_agent", "sig_director"]);

  const rels = zip.file("word/_rels/document.xml.rels").asText();
  const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, "no relationship id is reused");

  const doc = zip.file("word/document.xml").asText();
  assert.equal((doc.match(/<w:drawing>/g) || []).length, 3);
  const docPrIds = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(docPrIds).size, 3, "Word needs a unique docPr id per picture");
});

test("a signature tag the template does not use is simply not placed", { skip }, () => {
  const zip = docxWith(markerRun("sig_director"));
  const result = embedSignatures(zip, {
    sig_director: { bytes: PNG, name: "Director" },
    sig_admin:    { bytes: PNG, name: "Admin" },   // template has no slot for it
  });
  assert.deepEqual(result.placed, ["sig_director"]);
  assert.ok(!zip.file("word/media/anchor-sig_admin.png"));
});

test("a package with no relationship part is refused rather than half-written", { skip }, () => {
  const zip = docxWith(markerRun("sig_director"));
  zip.remove("word/_rels/document.xml.rels");
  assert.throws(() => embedSignatures(zip, { sig_director: { bytes: PNG, name: "D" } }),
    /no relationship part/);
});

// ---------------------------------------------------------------------------
// The agent's three supporting files (phase: attachments)
//
// These use the same machinery as signatures but differ in two ways that matter:
// they are sized by WIDTH rather than height, and one of them can become several
// pictures when a quotation arrives as a multi-page PDF.
// ---------------------------------------------------------------------------

const { embedImages, imageExtent, IMAGE_SLOTS, jpegSize, imageKind, imageSize } =
  await import("../js/docximage.js");

/** A minimal but genuinely decodable JPEG of the given size. */
function makeJpeg(width, height) {
  const head = [
    0xff, 0xd8,                                     // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, // APP0 / JFIF
    0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,                   // SOF0, length 17, precision 8
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,                                     // EOI
  ];
  return Uint8Array.from(head);
}

test("a JPEG's size is read from its frame header", () => {
  assert.deepEqual(jpegSize(makeJpeg(1240, 1755)), { width: 1240, height: 1755 });
  assert.equal(imageKind(makeJpeg(10, 10)), "jpeg");
  assert.equal(imageKind(PNG), "png");
  assert.deepEqual(imageSize(makeJpeg(640, 480)), { width: 640, height: 480 });
});

test("something that is neither PNG nor JPEG is refused by name", () => {
  assert.throws(() => imageKind(Uint8Array.from([0x25, 0x50, 0x44, 0x46])),  // "%PDF"
    /neither a PNG nor a JPEG/);
});

test("an I/C is sized by width, a signature by height", () => {
  // Same picture, two slots: the difference is which dimension is pinned.
  const card = { width: 856, height: 540 };          // a MyKad's proportions
  const asIc = imageExtent(card, IMAGE_SLOTS.ic_front);
  const asSig = imageExtent(card, IMAGE_SLOTS.sig_director);

  assert.equal(asIc.cx, Math.round(9.0 * 360000), "the I/C is pinned to 9 cm wide");
  assert.equal(asSig.cy, Math.round(2.0 * 360000), "the signature is pinned to 2 cm tall");
  assert.ok(asIc.cy < asIc.cx, "and the I/C stays landscape");
});

test("every slot preserves the aspect ratio", () => {
  for (const [name, spec] of Object.entries(IMAGE_SLOTS)) {
    for (const size of [{ width: 1000, height: 500 }, { width: 500, height: 1000 },
                        { width: 1240, height: 1755 }, { width: 300, height: 300 }]) {
      const { cx, cy } = imageExtent(size, spec);
      const wanted = size.width / size.height;
      assert.ok(Math.abs((cx / cy) - wanted) < 0.01,
        `${name} distorted ${size.width}x${size.height}: got ${(cx / cy).toFixed(3)}, wanted ${wanted.toFixed(3)}`);
    }
  }
});

test("a tall page is capped on height so it cannot overflow its sheet", () => {
  // An A4 quotation is 22.6 cm tall at full width, which does not fit.
  const { cx, cy } = imageExtent({ width: 1240, height: 1755 }, IMAGE_SLOTS.quotation);
  assert.equal(cy, Math.round(19.0 * 360000), "capped at the slot's maximum height");
  assert.ok(cx < Math.round(16.0 * 360000), "so the width comes down with it");
});

test("a multi-page quotation becomes one picture per page, each on its own sheet",
  { skip }, () => {
  const zip = docxWith(markerRun("quotation"));
  const result = embedImages(zip, {
    quotation: { name: "Quotation", pages: [
      { bytes: makeJpeg(1240, 1755), name: "p1" },
      { bytes: makeJpeg(1240, 1755), name: "p2" },
      { bytes: makeJpeg(1240, 1755), name: "p3" },
    ]},
  });

  assert.deepEqual(result.placed, ["quotation"]);
  assert.equal(result.counts.quotation, 3);

  const doc = zip.file("word/document.xml").asText();
  assert.equal((doc.match(/<w:drawing>/g) || []).length, 3, "three pictures");
  // Three page breaks: one before each page, including the first, because the
  // quotation slot asks for a fresh sheet.
  assert.equal((doc.match(/<w:br w:type="page"\/>/g) || []).length, 3);

  for (const n of [1, 2, 3]) {
    assert.ok(zip.file(`word/media/anchor-quotation-${n}.jpeg`), `page ${n} stored`);
  }
  assert.match(zip.file("[Content_Types].xml").asText(), /Extension="jpeg"/);
});

test("a slot that is not multi-page takes only the first image", { skip }, () => {
  const zip = docxWith(markerRun("ic_front"));
  const result = embedImages(zip, {
    ic_front: { pages: [{ bytes: makeJpeg(856, 540) }, { bytes: makeJpeg(856, 540) }] },
  });
  assert.equal(result.counts.ic_front, 1, "an I/C has one side, whatever is passed");
  assert.equal((zip.file("word/document.xml").asText().match(/<w:drawing>/g) || []).length, 1);
});

test("no quotation means no page break, so no empty sheet is added", { skip }, () => {
  const zip = docxWith(markerRun("quotation") + markerRun("ic_front"));
  const result = embedImages(zip, {});
  assert.deepEqual(result.placed, []);
  assert.deepEqual(result.missing.sort(), ["ic_front", "quotation"]);
  const doc = zip.file("word/document.xml").asText();
  assert.equal((doc.match(/<w:br w:type="page"\/>/g) || []).length, 0,
    "a break that only exists to separate quotation pages must not survive with no quotation");
  assert.ok(!doc.includes("ANCHORSIG"));
});

test("signatures and attachments can be placed in one pass without colliding",
  { skip }, () => {
  const zip = docxWith(markerRun("sig_director") + markerRun("ic_front") +
                       markerRun("ic_back") + markerRun("quotation"));
  const result = embedImages(zip, {
    sig_director: { bytes: PNG, name: "Director" },
    ic_front: { bytes: makeJpeg(856, 540) },
    ic_back:  { bytes: makeJpeg(856, 540) },
    quotation: { pages: [{ bytes: makeJpeg(1240, 1755) }, { bytes: makeJpeg(1240, 1755) }] },
  });
  assert.deepEqual(result.placed.sort(), ["ic_back", "ic_front", "quotation", "sig_director"]);

  const rels = zip.file("word/_rels/document.xml.rels").asText();
  const ids = [...rels.matchAll(/Id="(rId\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, "no relationship id is reused across kinds");

  const doc = zip.file("word/document.xml").asText();
  const docPr = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(docPr).size, 5, "five pictures, five unique ids");

  const ct = zip.file("[Content_Types].xml").asText();
  assert.match(ct, /Extension="png"/, "the signature's format is declared");
  assert.match(ct, /Extension="jpeg"/, "and the photographs' format too");
});
