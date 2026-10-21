// ---------------------------------------------------------------------------
// icsplit.js — finding the front and the back of an I/C in ONE picture.
//
// Owners often send a single scan or photo with both sides of the card on it,
// one above the other (or side by side). The agreement wants them as two
// pictures, so this looks for the empty band between the two cards and cuts
// there, then trims each card to its edges.
//
// Pure: works on anything shaped like ImageData ({ width, height, data }), so
// it is tested in Node without a browser.
// ---------------------------------------------------------------------------

/** Average colour of the outermost pixels — the paper or the table. */
export function backgroundOf(img) {
  const { width: w, height: h, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  const add = (x, y) => { const i = (y * w + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; };
  const stepX = Math.max(1, Math.floor(w / 200)), stepY = Math.max(1, Math.floor(h / 200));
  for (let x = 0; x < w; x += stepX) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y += stepY) { add(0, y); add(w - 1, y); }
  return [r / n, g / n, b / n];
}

/** A pixel is "ink" when it differs clearly from the background. */
function inkMask(img, bg, threshold = 30) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const d = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
    mask[p] = d > threshold ? 1 : 0;
  }
  return mask;
}

function profiles(mask, w, h) {
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) { const v = mask[y * w + x]; s += v; cols[x] += v; }
    rows[y] = s / w;
  }
  for (let x = 0; x < w; x++) cols[x] /= h;
  return { rows, cols };
}

/** First and last index whose ink share is above `min`. */
function extent(profile, min) {
  let lo = -1, hi = -1;
  for (let i = 0; i < profile.length; i++) if (profile[i] > min) { if (lo < 0) lo = i; hi = i; }
  return lo < 0 ? null : [lo, hi];
}

/**
 * The widest run of (nearly) empty lines strictly inside the content, if it
 * leaves a real card on each side.
 */
function widestGap(profile, [lo, hi], { blank = 0.006, minGapShare = 0.015, minPartShare = 0.2 } = {}) {
  const span = hi - lo + 1;
  let best = null, runStart = -1;
  for (let i = lo; i <= hi + 1; i++) {
    const empty = i <= hi && profile[i] <= blank;
    if (empty && runStart < 0) runStart = i;
    if (!empty && runStart >= 0) {
      const len = i - runStart;
      if (!best || len > best.len) best = { start: runStart, end: i - 1, len };
      runStart = -1;
    }
  }
  if (!best) return null;
  if (best.len < Math.max(2, span * minGapShare)) return null;
  const before = best.start - lo, after = hi - best.end;
  if (before < span * minPartShare || after < span * minPartShare) return null;
  return { ...best, share: best.len / span, cut: Math.round((best.start + best.end) / 2) };
}

/** Bounding box of the ink inside a rectangle, with a little margin. */
export function trimRect(mask, w, rect, pad = 0.02) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const colMin = Math.max(1, Math.round(rect.h * 0.01)), rowMin = Math.max(1, Math.round(rect.w * 0.01));
  const colCount = new Uint32Array(rect.w), rowCount = new Uint32Array(rect.h);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (mask[(rect.y + y) * w + rect.x + x]) { colCount[x]++; rowCount[y]++; }
    }
  }
  for (let x = 0; x < rect.w; x++) if (colCount[x] >= colMin) { x0 = Math.min(x0, x); x1 = x; }
  for (let y = 0; y < rect.h; y++) if (rowCount[y] >= rowMin) { y0 = Math.min(y0, y); y1 = y; }
  if (x1 < 0 || y1 < 0) return rect;
  const px = Math.round((x1 - x0 + 1) * pad), py = Math.round((y1 - y0 + 1) * pad);
  const nx0 = Math.max(0, x0 - px), ny0 = Math.max(0, y0 - py);
  const nx1 = Math.min(rect.w - 1, x1 + px), ny1 = Math.min(rect.h - 1, y1 + py);
  return { x: rect.x + nx0, y: rect.y + ny0, w: nx1 - nx0 + 1, h: ny1 - ny0 + 1 };
}

/**
 * Find two cards in one picture.
 * @returns {{ layout: "stacked"|"side-by-side", rects: [{x,y,w,h},{x,y,w,h}] } | null}
 *   rects in reading order (top then bottom, or left then right), or null
 *   when there is no clear gap between two cards.
 */
export function findCardRects(img) {
  const { width: w, height: h } = img;
  if (!w || !h) return null;
  const bg = backgroundOf(img);
  const mask = inkMask(img, bg);
  const { rows, cols } = profiles(mask, w, h);
  const rowSpan = extent(rows, 0.01), colSpan = extent(cols, 0.01);
  if (!rowSpan || !colSpan) return null;

  const stacked = widestGap(rows, rowSpan);
  const sideBySide = widestGap(cols, colSpan);
  const pick = stacked && (!sideBySide || stacked.share >= sideBySide.share) ? "stacked"
             : sideBySide ? "side-by-side" : null;
  if (!pick) return null;

  const full = { x: 0, y: 0, w, h };
  let a, b;
  if (pick === "stacked") {
    a = { ...full, h: stacked.cut };
    b = { ...full, y: stacked.cut, h: h - stacked.cut };
  } else {
    a = { ...full, w: sideBySide.cut };
    b = { ...full, x: sideBySide.cut, w: w - sideBySide.cut };
  }
  return { layout: pick, rects: [trimRect(mask, w, a), trimRect(mask, w, b)] };
}

/** Just trim the margins around a single card (a page of a two-page PDF). */
export function contentRect(img) {
  const bg = backgroundOf(img);
  const mask = inkMask(img, bg);
  return trimRect(mask, img.width, { x: 0, y: 0, w: img.width, h: img.height });
}
