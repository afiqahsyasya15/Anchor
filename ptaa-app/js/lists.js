// ---------------------------------------------------------------------------
// lists.js — pure helpers behind the admin's lists: reading a CSV, cleaning and
// matching Sales Agents, and reading a Google Drive folder link. No Firebase,
// so they are tested directly (tests/invoice.test.mjs).
// ---------------------------------------------------------------------------

import { validateNric, validatePhone } from "./validate.js";

// ===========================================================================
// CSV
// ===========================================================================

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ""));
}

/** First row is the header. Header names are matched loosely. */
export function csvObjects(text, aliases) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  const col = {};
  for (const [key, names] of Object.entries(aliases)) {
    col[key] = header.findIndex(h => names.includes(h));
  }
  return rows.slice(1).map(r => {
    const o = {};
    for (const key of Object.keys(aliases)) o[key] = col[key] >= 0 ? String(r[col[key]] ?? "").trim() : "";
    return o;
  });
}

// ===========================================================================
// Sales Agents
// ===========================================================================

export const AGENT_ALIASES = {
  fullName: ["fullname", "name", "agentname"],
  nickname: ["nickname", "nick", "preferredname"],
  nric: ["nricno", "nric", "ic", "icno", "icnumber", "nricnumber"],
  email: ["emailaddress", "email"],
  phone: ["contactno", "contact", "phone", "phoneno", "mobile", "mobileno"],
};

/** Malaysian mobile as the office writes it: 016-303 0477, 011-1199 0124. */
export function tidyPhone(raw) {
  const r = validatePhone(String(raw ?? "").trim());
  return r.ok ? r.value : String(raw ?? "").trim();
}

export function tidyNric(raw) {
  const r = validateNric(String(raw ?? "").trim());
  return r.ok ? r.value : String(raw ?? "").trim();
}

const nricDigits = (s) => String(s || "").replace(/\D/g, "");
const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Clean one agent row. Returns { value, problems[] } — problems are the reasons
 * this agent cannot yet be used as the witness on a PTAA.
 */
export function normaliseAgent(a) {
  const value = {
    fullName: String(a.fullName || "").replace(/\s+/g, " ").trim().replace(/^\?+$/, ""),
    nickname: String(a.nickname || "").replace(/\s+/g, " ").trim(),
    nric: tidyNric(a.nric).replace(/^\?+$/, ""),
    phone: tidyPhone(a.phone),
    email: String(a.email || "").trim().toLowerCase().replace(/^\?+$/, ""),
  };
  const problems = [];
  if (!value.fullName) problems.push("full name missing");
  if (!value.nric) problems.push("I/C missing");
  else if (!validateNric(value.nric).ok) problems.push("I/C looks wrong");
  if (!value.phone) problems.push("phone missing");
  else if (!validatePhone(value.phone).ok) problems.push("phone looks wrong");
  return { value, problems };
}

/**
 * Two agents are the same person when their I/C matches; failing that (one of
 * them has no I/C yet), when their full name matches; failing that, when their
 * mobile number does.
 */
export function sameAgent(a, b) {
  const na = nricDigits(a.nric), nb = nricDigits(b.nric);
  if (na && nb) return na === nb;
  const fa = nameKey(a.fullName), fb = nameKey(b.fullName);
  if (fa && fb) return fa === fb;
  const pa = String(a.phone || "").replace(/\D/g, ""), pb = String(b.phone || "").replace(/\D/g, "");
  if (pa && pb) return pa.slice(-9) === pb.slice(-9);
  return !!a.nickname && nameKey(a.nickname) === nameKey(b.nickname);
}

/** Split an import into new rows, duplicates of each other, and ones already listed. */
export function planAgentImport(rows, existing = []) {
  const toAdd = [], duplicates = [], already = [];
  for (const raw of rows) {
    const { value, problems } = normaliseAgent(raw);
    if (!value.fullName && !value.nickname) continue;
    const dupOf = toAdd.find(x => sameAgent(x.value, value));
    if (dupOf) { duplicates.push({ value, of: dupOf.value }); continue; }
    const have = existing.find(x => sameAgent(x, value));
    if (have) { already.push({ value, of: have }); continue; }
    toAdd.push({ value, problems });
  }
  return { toAdd, duplicates, already };
}


/** Accepts a whole Drive link or a bare id. */
export function driveFolderIdFrom(value) {
  const s = String(value || "").trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : "";
}


const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/** "MMM YY INV" + 24 Sep 2026 → "SEP 26 INV". Also understands MM and YYYY. */
export function monthFolderName(pattern, date) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = Number.isNaN(d.getTime()) ? new Date() : d;
  return String(pattern || "MMM YY INV")
    .replace(/YYYY/g, String(dd.getFullYear()))
    .replace(/MMM/g, MONTHS[dd.getMonth()])
    .replace(/YY/g, String(dd.getFullYear() % 100).padStart(2, "0"))
    .replace(/MM/g, String(dd.getMonth() + 1).padStart(2, "0"));
}

