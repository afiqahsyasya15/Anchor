// ---------------------------------------------------------------------------
// pdfsign.js — putting signature images onto a PTAA that has come back signed
// by the Owner (the Director signs after the Owner, so this happens on the
// PDF, not on the Word draft).
//
// Where a PDF still has its text (saved from Word, or signed digitally), the
// signature lines are found by themselves: every "……………" line with a
// "Signed by / Signed for … / Witnessed by" heading above it and a
// "Full Name: …" below it. A scanned PDF has no text, so the signature is
// placed by clicking on the page instead. Both end in the same list of
// placements, stamped in with pdf-lib.
// ---------------------------------------------------------------------------

const DOTS = /^[\s.…·_…-]{8,}$/;

/**
 * @param {Array<{items:Array<{str,x,y,w,h}>}>} pages   text per page (PDF points, y up)
 * @returns {Array<{page:number, x:number, y:number, lineWidth:number, role:string, heading:string, name:string, isCompany:boolean}>}
 */
export function detectSignatureSpots(pages) {
  const spots = [];
  (pages || []).forEach((pg, pageIndex) => {
    const items = (pg.items || []).filter(i => String(i.str || "").trim());
    const lineText = (y, x0, x1, tol = 2.5) => items
      .filter(i => Math.abs(i.y - y) <= tol && i.x >= x0 - 4 && i.x <= x1)
      .sort((a, b) => a.x - b.x).map(i => i.str.trim()).join(" ").replace(/\s+/g, " ").trim();

    for (const d of items.filter(i => DOTS.test(i.str) && String(i.str).replace(/\s/g, "").length >= 8)) {
      const x0 = d.x, x1 = d.x + Math.max(d.w || 0, 120);

      // Heading: the nearest "Signed …" / "Witnessed …" line above, in this column.
      const heads = items
        .filter(i => i.y > d.y && i.y - d.y < 140 && i.x >= x0 - 12 && i.x <= x1 && /^(Signed|Witnessed)\b/i.test(i.str.trim()))
        .sort((a, b) => a.y - b.y);
      const head = heads[0];
      let heading = head ? lineText(head.y, x0 - 12, x1) : "";
      // "Signed for and on behalf of the Tenancy" wraps onto a second line.
      if (head) {
        const next = items.filter(i => i.y < head.y && head.y - i.y < 16 && i.y > d.y && i.x >= x0 - 12 && i.x <= x1)
                          .sort((a, b) => b.y - a.y)[0];
        if (next) heading = `${heading} ${lineText(next.y, x0 - 12, x1)}`.trim();
      }

      // Name: the "Full Name:" line just below.
      const nameItem = items
        .filter(i => i.y < d.y && d.y - i.y < 22 && i.x >= x0 - 12 && i.x <= x1 && /Full\s*Name/i.test(i.str))
        .sort((a, b) => b.y - a.y)[0];
      const name = nameItem ? lineText(nameItem.y, x0 - 12, x1).replace(/^Full\s*Name\s*:\s*/i, "") : "";

      const h = heading.toLowerCase();
      const isCompany = /tenancy\s+administrator|on behalf/.test(h);
      const role = /witness/.test(h) ? "Witness" : isCompany ? "Tenancy Administrator" : /owner/.test(h) ? "Owner" : "Signature";
      spots.push({ page: pageIndex, x: d.x, y: d.y, lineWidth: d.w || 0, role, heading, name, isCompany });
    }
  });
  return spots;
}

/** Where a signature of this width sits on a detected line: just above it. */
export function placementForSpot(spot, width = 110, aspect = 0.4) {
  const w = Math.min(width, Math.max(60, (spot.lineWidth || 200) - 20));
  return { page: spot.page, x: spot.x + 12, y: spot.y + 4, width: w, height: w * aspect };
}

/**
 * @param {Uint8Array} pdfBytes
 * @param {Array<{page:number,x:number,y:number,width:number,png:Uint8Array}>} placements
 * @param {object} PDFLib
 */
export async function stampSignatures(pdfBytes, placements, PDFLib) {
  const doc = await PDFLib.PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const cache = new Map();
  for (const p of placements) {
    let img = cache.get(p.png);
    if (!img) {
      img = await (isPng(p.png) ? doc.embedPng(p.png) : doc.embedJpg(p.png));
      cache.set(p.png, img);
    }
    const page = doc.getPage(p.page);
    const h = p.width * (img.height / img.width);
    page.drawImage(img, { x: p.x, y: p.y, width: p.width, height: h });
  }
  return doc.save();
}

function isPng(b) {
  return b && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}
