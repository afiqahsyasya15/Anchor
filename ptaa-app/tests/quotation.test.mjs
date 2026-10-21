// Reading line items out of a quotation, and turning them into invoice lines.
import test from "node:test";
import assert from "node:assert/strict";
import { parseQuotationPages, buildInvoiceItems, joinWrapped, sumOfEntries } from "../js/quotation.js";

// Build a fake pdf.js page from [y, x, text] triples (y grows upwards, as in PDF).
const page = (rows) => ({ items: rows.map(([y, x, str]) => ({ str, x, y, w: str.length * 3.5, h: 7.7 })) });

const Q = page([
  [750, 80, "Part 1 : General Area"],
  [733, 85, "1.1"], [733, 110, "Whole Unit Raid LED Track Light Set"],
  [725, 110, "4000k Cool White with 12 watt power"], [725, 425, "1"], [725, 442, "Job"], [725, 490, "RM1,400"],
  [717, 110, "Work-safe with SIRIM Certified"],
  // heading with two priced rows
  [700, 85, "1.3"], [700, 110, "Shh Shh Toilet"],
  [692, 110, "To supply mounted mirror"], [692, 425, "2"], [692, 442, "Set"], [692, 490, "RM140"],
  [684, 110, "To supply and install instant water heater"], [684, 425, "0"], [684, 442, "Set"], [684, 490, "RM0"],
  // description ABOVE a vertically centred item number
  [667, 110, "Always Looking Good Wardrobe"],
  [659, 85, "3.1"], [659, 425, "1"], [659, 442, "Set"], [659, 490, "RM648"],
  [651, 110, "To supply & install 4 x 6ft anti-jam sliding door"],
  [634, 80, "Total Price - Part 1 RM2,188"],
  [617, 85, "4.1"], [617, 110, "Always Looking Good Wardrobe"],
  [609, 110, "To supply & install 4 x 6ft anti-jam sliding door"], [609, 425, "1"], [609, 442, "Set"], [609, 490, "RM648"],
  [592, 85, "6.4"], [592, 110, "High Security Smart Lock"], [592, 425, "1"], [592, 442, "Set"], [592, 490, "RM1,250"],
  [575, 85, "8.4"], [575, 110, "A-Z Logistics"], [575, 425, "1"], [575, 442, "Job"], [575, 490, "RM600"],
  [540, 80, "Grand total"], [540, 490, "RM4,686"],
]);

test("reads priced rows, splits a heading with two rows, keeps a description above its number", () => {
  const r = parseQuotationPages([Q]);
  assert.equal(r.grandTotal, 4686);
  const d = r.entries.map(e => `${e.qty}|${e.description.split("\n")[0]}`);
  assert.deepEqual(d, [
    "1|Whole Unit Raid LED Track Light Set",
    "2|To supply mounted mirror",
    "0|To supply and install instant water heater",
    "1|Always Looking Good Wardrobe",
    "1|Always Looking Good Wardrobe",
    "1|High Security Smart Lock",
    "1|A-Z Logistics",
  ]);
  assert.equal(r.entries[0].description.split("\n").length, 3);
  assert.equal(sumOfEntries(r.entries), 1400 + 140 + 648 + 648 + 1250 + 600);
});

test("invoice lines: zero quantities dropped, same item added up, smart lock FOC at the end", () => {
  const items = buildInvoiceItems(parseQuotationPages([Q]).entries);
  assert.deepEqual(items.map(i => [i.description.split("\n")[0], i.qty]), [
    ["Whole Unit Raid LED Track Light Set", 1],
    ["To supply mounted mirror", 2],
    ["Always Looking Good Wardrobe", 2],
    ["A-Z Logistics", 1],
    ["High Security Smart Lock", "FOC"],
  ]);
});

test("soft-wrapped lines are joined, deliberate ones kept", () => {
  assert.deepEqual(joinWrapped(["Shy Away Curtain", "100% custom made with Butter Cream in", "color"]),
                   ["Shy Away Curtain", "100% custom made with Butter Cream in color"]);
  assert.deepEqual(joinWrapped(["Midea Dryer Machine", "(5 year Warranty)"]),
                   ["Midea Dryer Machine", "(5 year Warranty)"]);
  assert.deepEqual(joinWrapped(["Biometric Fingerprint +", "Keypad ID + NFC)"]),
                   ["Biometric Fingerprint + Keypad ID + NFC)"]);
});
