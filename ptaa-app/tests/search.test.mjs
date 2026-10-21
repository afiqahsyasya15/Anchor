// ---------------------------------------------------------------------------
// Tests for global search and reporting (brief §8.4, phase 13).
//
// Run:  node --test tests/search.test.mjs
//
// The brief names the two questions search has to answer well, so those are the
// first two tests. The rest are the ways a search box usually disappoints:
// returning everything, ranking an address match above a name match, or
// quietly widening as you add words.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import { searchRequests, searchableText, buildReport } from "../js/model.js";

const req = (over = {}) => ({
  ptaaId: "PTAA-00001",
  type: "NEW_PTAA",
  status: "UNDER_REVIEW",
  currentAction: "PTAA Admin",
  owner: { name: "LOY HUI TING", nric: "880214-10-5566", phone: "012-345 6789", email: "loy@example.com" },
  propertyName: "M ASTRA", unitNo: "A-18-09", propertyAddress: "Jalan Ampang, KL",
  ptaaType: "Partition",
  agentEmail: "suzanne@gmail.com",
  agentSnapshot: { fullName: "CHAN SIEW SIN", nickname: "Suzanne" },
  createdAt: new Date("2026-08-01"),
  updatedAt: new Date("2026-08-20"),
  ...over,
});

const ROWS = [
  req(),
  req({ ptaaId: "PTAA-00002", owner: { name: "YEN POH WE" },
        propertyName: "ONE EQUINE", unitNo: "C-01-03",
        status: "COMPLETED", completedAt: new Date("2026-08-15"),
        drive: { fileId: "f1", fileName: "PTAA (ONE EQUINE C-01-03) YEN POH WE.docx",
                 webViewLink: "https://drive.google.com/file/d/f1/view" },
        updatedAt: new Date("2026-08-15") }),
  req({ ptaaId: "PTAA-00003", owner: { name: "TAN AH KOW" },
        propertyName: "THE ERA", unitNo: "B-07-11",
        agentEmail: "ali@gmail.com",
        agentSnapshot: { fullName: "ALI BIN OSMAN", nickname: "Ali" },
        updatedAt: new Date("2026-08-25") }),
  // Deliberately awkward: an ADDRESS containing a word that is another
  // request's OWNER name. Without ranking, this outranks the real LOY.
  req({ ptaaId: "PTAA-00004", owner: { name: "SITI BINTI HASSAN" },
        propertyName: "PALM COURT", unitNo: "D-02-08",
        propertyAddress: "12 Jalan Ting, Kuala Lumpur",
        updatedAt: new Date("2026-08-26") }),
];

const ids = (rows) => rows.map(r => r.ptaaId);

// --- The two questions the brief names ---------------------------------------

test("“I remember the Owner's name but not the PTAA number”", () => {
  assert.deepEqual(ids(searchRequests(ROWS, "yen poh")), ["PTAA-00002"]);
  assert.deepEqual(ids(searchRequests(ROWS, "tan ah kow")), ["PTAA-00003"]);
});

test("“I remember the condo and unit but not the Owner”", () => {
  assert.deepEqual(ids(searchRequests(ROWS, "equine c-01-03")), ["PTAA-00002"]);
  assert.deepEqual(ids(searchRequests(ROWS, "astra 18-09")), ["PTAA-00001"]);
});

// --- Ranking -----------------------------------------------------------------

test("an owner-name match outranks an address that happens to contain the word", () => {
  const hits = searchRequests(ROWS, "ting");
  assert.equal(hits.length, 2, "both genuinely contain it");
  assert.equal(hits[0].ptaaId, "PTAA-00001", "the owner actually called TING comes first");
  assert.equal(hits[1].ptaaId, "PTAA-00004", "the one with TING in its address comes second");
});

test("an exact PTAA number goes straight to the top", () => {
  assert.equal(searchRequests(ROWS, "PTAA-00003")[0].ptaaId, "PTAA-00003");
  assert.equal(searchRequests(ROWS, "00002")[0].ptaaId, "PTAA-00002");
});

test("equally relevant results come back newest first", () => {
  // Every row matches "jalan"? No — use a term common to two, then check order.
  const hits = searchRequests(ROWS, "partition");
  assert.ok(hits.length >= 2);
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1].updatedAt.getTime(), b = hits[i].updatedAt.getTime();
    assert.ok(a >= b, "results are not in descending updated order");
  }
});

// --- Narrowing, not widening -------------------------------------------------

test("more words narrow the result, they never widen it", () => {
  const one = searchRequests(ROWS, "astra");
  const two = searchRequests(ROWS, "astra loy");
  const three = searchRequests(ROWS, "astra loy nowhere");
  assert.ok(two.length <= one.length);
  assert.equal(three.length, 0, "a word that matches nothing eliminates everything");
});

test("words from different requests return nothing, not both", () => {
  // The classic OR bug: "loy equine" should find a request that is BOTH, and
  // there isn't one.
  assert.deepEqual(searchRequests(ROWS, "loy equine"), []);
});

test("an empty query returns nothing rather than everything", () => {
  assert.deepEqual(searchRequests(ROWS, ""), []);
  assert.deepEqual(searchRequests(ROWS, "   "), []);
  assert.deepEqual(searchRequests(ROWS, null), []);
});

// --- What is searchable ------------------------------------------------------

test("everything §8.4 lists is searchable", () => {
  const hay = searchableText(ROWS[1]);
  for (const needle of [
    "ptaa-00002",                       // PTAA id
    "yen poh we",                       // owner
    "one equine", "c-01-03",            // property and unit
    "suzanne@gmail.com",                // agent
    "completed",                        // status
    "ptaa (one equine c-01-03)",        // filename
    "drive.google.com",                 // Drive link
    "new ptaa request",                 // request type
  ]) {
    assert.ok(hay.includes(needle), `not searchable: ${needle}`);
  }
});

test("search is case-insensitive in both directions", () => {
  assert.deepEqual(ids(searchRequests(ROWS, "LOY HUI")), ["PTAA-00001"]);
  assert.deepEqual(ids(searchRequests(ROWS, "loy hui")), ["PTAA-00001"]);
});

test("an agent's own list is all a search over it can return", () => {
  // The screen passes listRequests({ mine: true }) for an agent, and the rules
  // refuse an unscoped query — so isolation is not this function's job, but it
  // must not invent rows either.
  const mine = ROWS.filter(r => r.agentEmail === "ali@gmail.com");
  assert.deepEqual(ids(searchRequests(mine, "astra")), []);
  assert.deepEqual(ids(searchRequests(mine, "era")), ["PTAA-00003"]);
});

test("the result list is capped", () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    req({ ptaaId: "PTAA-" + String(i).padStart(5, "0") }));
  assert.equal(searchRequests(many, "astra").length, 50);
  assert.equal(searchRequests(many, "astra", { limit: 10 }).length, 10);
});

// --- Reporting ---------------------------------------------------------------

test("the report counts open, completed and cancelled separately", () => {
  const rep = buildReport(ROWS, { now: new Date("2026-08-29") });
  assert.equal(rep.total, 4);
  assert.equal(rep.completed, 1);
  assert.equal(rep.open, 3);
  assert.equal(rep.cancelled, 0);
});

test("turnaround is measured from submission to completion", () => {
  const rep = buildReport(ROWS, { now: new Date("2026-08-29") });
  // PTAA-00002: created 1 Aug, completed 15 Aug.
  assert.equal(rep.medianDaysToComplete, 14);
  assert.equal(rep.fastest, 14);
  assert.equal(rep.slowest, 14);
});

test("nothing completed yet reports as nothing, not as zero days", () => {
  const rep = buildReport(ROWS.filter(r => r.status !== "COMPLETED"));
  assert.equal(rep.medianDaysToComplete, null,
    "a median of 0 would read as “instant”, which is a lie");
  assert.equal(rep.completed, 0);
});

test("a completed PTAA with no Drive link is flagged as impossible", () => {
  const clean = buildReport(ROWS);
  assert.equal(clean.completedWithoutDriveLink, 0);

  const broken = buildReport([...ROWS, req({
    ptaaId: "PTAA-09999", status: "COMPLETED",
    completedAt: new Date("2026-08-20"), drive: null,
  })]);
  assert.equal(broken.completedWithoutDriveLink, 1,
    "completing uploads first, so this state means something bypassed the app");
});

test("open work is split by who has the ball", () => {
  const rep = buildReport([
    req({ status: "UNDER_REVIEW", currentAction: "PTAA Admin" }),
    req({ status: "READY_FOR_AGENT", currentAction: "Sales Agent" }),
    req({ status: "READY_FOR_AGENT", currentAction: "Sales Agent" }),
    req({ status: "COMPLETED", completedAt: new Date(), drive: { fileId: "x" } }),
  ]);
  assert.equal(rep.withAdmin, 1);
  assert.equal(rep.withAgent, 2);
});

test("“completed this month” means this calendar month, not the last 30 days", () => {
  const rows = [
    req({ status: "COMPLETED", completedAt: new Date("2026-08-02"), drive: { fileId: "a" } }),
    req({ status: "COMPLETED", completedAt: new Date("2026-07-31"), drive: { fileId: "b" } }),
  ];
  const rep = buildReport(rows, { now: new Date("2026-08-29") });
  assert.equal(rep.completedThisMonth, 1, "31 July is last month, however recent it is");
});
