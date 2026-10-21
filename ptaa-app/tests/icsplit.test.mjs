import test from "node:test";
import assert from "node:assert/strict";
import { findCardRects, contentRect } from "../js/icsplit.js";

// A synthetic picture: background colour, with filled rectangles ("cards")
// that have some darker "text" lines inside and gaps between them.
function picture(w, h, bg, cards) {
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, c) => { const i = (y * w + x) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, bg);
  for (const r of cards) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      // light card colour, with a text line every 12 px
      put(x, y, (y - r.y) % 12 < 3 && x > r.x + 10 && x < r.x + r.w - 10 ? [40, 40, 60] : [200, 215, 232]);
    }
  }
  return { width: w, height: h, data };
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test("two cards one above the other are split at the gap and trimmed", () => {
  const img = picture(400, 600, [255, 255, 255], [
    { x: 60, y: 40, w: 280, h: 180 },
    { x: 60, y: 320, w: 280, h: 180 },
  ]);
  const found = findCardRects(img);
  assert.equal(found.layout, "stacked");
  const [a, b] = found.rects;
  assert.ok(near(a.y, 40, 8) && near(a.h, 180, 16) && near(a.x, 60, 8) && near(a.w, 280, 16), JSON.stringify(a));
  assert.ok(near(b.y, 320, 8) && near(b.h, 180, 16), JSON.stringify(b));
});

test("two cards side by side are split left and right", () => {
  const img = picture(700, 300, [250, 250, 250], [
    { x: 20, y: 60, w: 300, h: 190 },
    { x: 380, y: 50, w: 300, h: 190 },
  ]);
  const found = findCardRects(img);
  assert.equal(found.layout, "side-by-side");
  assert.ok(found.rects[0].x < found.rects[1].x);
  assert.ok(near(found.rects[1].x, 380, 8), JSON.stringify(found.rects[1]));
});

test("works on a coloured table, not only white paper", () => {
  const img = picture(400, 600, [120, 90, 60], [
    { x: 50, y: 30, w: 300, h: 190 },
    { x: 55, y: 330, w: 300, h: 190 },
  ]);
  const found = findCardRects(img);
  assert.equal(found && found.layout, "stacked");
});

test("a single card is not split", () => {
  const img = picture(500, 350, [255, 255, 255], [{ x: 40, y: 40, w: 420, h: 270 }]);
  assert.equal(findCardRects(img), null);
});

test("the text lines inside a card are not mistaken for the gap between cards", () => {
  const img = picture(400, 700, [255, 255, 255], [
    { x: 60, y: 20, w: 280, h: 300 },
    { x: 60, y: 370, w: 280, h: 300 },
  ]);
  const found = findCardRects(img);
  assert.equal(found.layout, "stacked");
  assert.ok(near(found.rects[1].y, 370, 8));
});

test("a blank picture gives nothing", () => {
  assert.equal(findCardRects(picture(100, 100, [255, 255, 255], [])), null);
});

test("contentRect trims the white margin around one card", () => {
  const r = contentRect(picture(600, 800, [255, 255, 255], [{ x: 100, y: 200, w: 300, h: 190 }]));
  assert.ok(near(r.x, 100, 10) && near(r.y, 200, 10) && near(r.w, 300, 20) && near(r.h, 190, 20), JSON.stringify(r));
});
