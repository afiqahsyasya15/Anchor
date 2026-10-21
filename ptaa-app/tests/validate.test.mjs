// ---------------------------------------------------------------------------
// Tests for js/validate.js — the profile validation from brief §6.
//
// Run:  node --test tests/
// (Node 18+. Nothing to install. These test pure functions only, so they need
//  no browser and no Firebase project.)
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import {
  validateNric, validatePhone, validateFullName, validateNickname,
  emailKey, isValidEmail, missingProfileFields, isProfileComplete,
  fmtLogTime, fmtDate,
} from "../js/validate.js";

// --- NRIC -------------------------------------------------------------------

test("NRIC: accepts the brief's example and returns the canonical form", () => {
  const r = validateNric("000908-14-0426");
  assert.equal(r.ok, true);
  assert.equal(r.value, "000908-14-0426");
  assert.equal(r.warning, null);
});

test("NRIC: accepts input with no separators and adds them", () => {
  assert.equal(validateNric("000908140426").value, "000908-14-0426");
});

test("NRIC: accepts messy separators", () => {
  assert.equal(validateNric(" 000908 14 0426 ").value, "000908-14-0426");
  assert.equal(validateNric("000908/14/0426").value, "000908-14-0426");
});

test("NRIC: rejects the wrong number of digits and says how many were given", () => {
  const r = validateNric("00090814042");
  assert.equal(r.ok, false);
  assert.match(r.error, /12 digits/);
  assert.match(r.error, /11/);
});

test("NRIC: rejects an empty value", () => {
  assert.equal(validateNric("").ok, false);
  assert.equal(validateNric(null).ok, false);
});

test("NRIC: rejects an impossible month", () => {
  const r = validateNric("001308-14-0426");
  assert.equal(r.ok, false);
  assert.match(r.error, /month/i);
});

test("NRIC: rejects an impossible day, including 30 February", () => {
  assert.equal(validateNric("000932-14-0426").ok, false);
  assert.equal(validateNric("000230-14-0426").ok, false);
});

test("NRIC: accepts 29 February (leap years are not knowable from YY)", () => {
  assert.equal(validateNric("000229-14-0426").ok, true);
});

test("NRIC: an unissued place-of-birth code warns but does not block", () => {
  const r = validateNric("000908-18-0426");
  assert.equal(r.ok, true, "must not reject — a false refusal is the worse failure");
  assert.match(r.warning, /place-of-birth/);
});

// --- Phone ------------------------------------------------------------------

test("phone: accepts the brief's example and returns the canonical form", () => {
  const r = validatePhone("019-400 9082");
  assert.equal(r.ok, true);
  assert.equal(r.value, "019-400 9082");
});

test("phone: normalises unformatted, +60 and 60 forms to one canonical value", () => {
  for (const input of ["0194009082", "019 400 9082", "+60194009082", "60194009082", "+60 19-400 9082"]) {
    assert.equal(validatePhone(input).value, "019-400 9082", `failed for ${input}`);
  }
});

test("phone: handles 11-digit 011 numbers", () => {
  const r = validatePhone("01112345678");
  assert.equal(r.ok, true);
  assert.equal(r.value, "011-1234 5678");
});

test("phone: rejects a landline", () => {
  const r = validatePhone("03-2345 6789");
  assert.equal(r.ok, false);
  assert.match(r.error, /mobile/i);
});

test("phone: an overseas number with + and its country code is kept as typed", () => {
  assert.deepEqual([validatePhone("+65 9123 4567").ok, validatePhone("+65 9123 4567").value], [true, "+65 9123 4567"]);
  assert.equal(validatePhone("0065 9123 4567").value, "+65 9123 4567");
  assert.equal(validatePhone("+86 138 0013 8000").ok, true);
  assert.equal(validatePhone("+60 19-400 9082").value, "019-400 9082", "+60 is still tidied as Malaysian");
  assert.equal(validatePhone("+65 12").ok, false);
  assert.match(validatePhone("6591234567").error, /start with \+ and the country code/);
});

test("I/C: a passport number is accepted only where asked for (the owner)", () => {
  assert.equal(validateNric("E12345678").ok, false);
  const r = validateNric("e1234 5678", { allowPassport: true });
  assert.deepEqual([r.ok, r.value, r.passport], [true, "E12345678", true]);
  assert.match(r.warning, /passport/);
  assert.equal(validateNric("761107-08-6307", { allowPassport: true }).value, "761107-08-6307");
  assert.equal(validateNric("12", { allowPassport: true }).ok, false);
});

test("phone: rejects the wrong length and says what was given", () => {
  const r = validatePhone("019-400 908");
  assert.equal(r.ok, false);
  assert.match(r.error, /10 or 11 digits/);
});

test("phone: rejects an empty value", () => {
  assert.equal(validatePhone("").ok, false);
});

// --- Names ------------------------------------------------------------------

test("full name: collapses whitespace, keeps the case the agent typed", () => {
  const r = validateFullName("  CHAN   SIEW  SIN ");
  assert.equal(r.ok, true);
  assert.equal(r.value, "CHAN SIEW SIN");
});

test("full name: rejects empty, too short, and digits-only", () => {
  assert.equal(validateFullName("").ok, false);
  assert.equal(validateFullName("AB").ok, false);
  assert.equal(validateFullName("12345").ok, false);
});

test("full name: accepts non-ASCII letters", () => {
  assert.equal(validateFullName("Nurul Ain binti Abdullah").ok, true);
  assert.equal(validateFullName("陈秀珍").ok, true);
});

test("nickname: accepts the brief's example, rejects empty and over-long", () => {
  assert.equal(validateNickname("Suzanne").value, "Suzanne");
  assert.equal(validateNickname("  ").ok, false);
  assert.equal(validateNickname("x".repeat(41)).ok, false);
});

// --- Email key --------------------------------------------------------------

test("emailKey: lowercases and trims, and does nothing else", () => {
  assert.equal(emailKey("  Irfan.Kimie@Gmail.COM "), "irfan.kimie@gmail.com");
});

test("emailKey: leaves Gmail dots alone — firestore.rules cannot strip them", () => {
  assert.notEqual(emailKey("a.b@gmail.com"), emailKey("ab@gmail.com"));
});

test("isValidEmail", () => {
  assert.equal(isValidEmail("someone@gmail.com"), true);
  assert.equal(isValidEmail("someone@gmail"), false);
  assert.equal(isValidEmail("not an email"), false);
  assert.equal(isValidEmail(""), false);
});

// --- Profile completeness (brief §6) ----------------------------------------

const FULL = { fullName: "CHAN SIEW SIN", nric: "000908-14-0426", phone: "019-400 9082", nickname: "Suzanne" };

test("a complete profile reports complete", () => {
  assert.equal(isProfileComplete(FULL), true);
  assert.deepEqual(missingProfileFields(FULL), []);
});

test("an incomplete profile names every missing field, as the brief requires", () => {
  assert.deepEqual(missingProfileFields({ fullName: "CHAN SIEW SIN" }),
    ["I/C Number", "Phone Number", "Nickname"]);
  assert.deepEqual(missingProfileFields(undefined),
    ["Full Name", "I/C Number", "Phone Number", "Nickname"]);
  assert.equal(isProfileComplete({ ...FULL, nickname: "   " }), false);
});

// --- Formatting -------------------------------------------------------------

test("fmtLogTime matches the format in brief §14.1", () => {
  const d = new Date(2026, 7, 24, 9, 15);          // 24 Aug 2026, 09:15 local
  assert.equal(fmtLogTime(d), "24 Aug 2026 9:15 AM");
});

test("fmtLogTime handles noon, midnight and PM", () => {
  assert.equal(fmtLogTime(new Date(2026, 7, 24, 0, 5)),  "24 Aug 2026 12:05 AM");
  assert.equal(fmtLogTime(new Date(2026, 7, 24, 12, 0)), "24 Aug 2026 12:00 PM");
  assert.equal(fmtLogTime(new Date(2026, 7, 24, 22, 30)),"24 Aug 2026 10:30 PM");
});

test("timestamps that have not been written yet render as a dash, not a crash", () => {
  assert.equal(fmtLogTime(null), "—");
  assert.equal(fmtDate(undefined), "—");
});

test("fmtDate accepts a Firestore Timestamp-shaped object", () => {
  const ts = { toDate: () => new Date(2026, 7, 24) };
  assert.equal(fmtDate(ts), "24 Aug 2026");
});
