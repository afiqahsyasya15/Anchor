import test from "node:test";
import assert from "node:assert/strict";
import { detectSignatureSpots, placementForSpot } from "../js/pdfsign.js";

const it = (str, x, y, w = 100) => ({ str, x, y, w, h: 10 });
test("finds signature lines, their role and the name under them", () => {
  const spots = detectSignatureSpots([{ items: [
    it("Signed by the Owner", 57, 700), it("……………………………………", 57, 631, 230), it("Full Name:", 57, 619, 48), it("CHESTER TIE", 108, 619),
    it("Signed", 309, 700, 31), it("for", 352, 700, 12), it("Tenancy", 509, 700, 37), it("Administrator", 310, 688, 59),
    it("……………………………………", 309, 619, 230), it("Full Name: BENJAMIN KUAN", 309, 608, 188),
    it("see Appendix B …", 40, 300, 300),
  ] }]);
  assert.equal(spots.length, 2);
  assert.equal(spots[0].role, "Owner"); assert.equal(spots[0].name, "CHESTER TIE");
  assert.equal(spots[1].role, "Tenancy Administrator"); assert.equal(spots[1].isCompany, true);
  assert.equal(spots[1].name, "BENJAMIN KUAN");
  const p = placementForSpot(spots[1]);
  assert.ok(p.y > spots[1].y && p.x > spots[1].x);
});
