// ---------------------------------------------------------------------------
// validate.js — pure functions: formatting, email keys, and the Sales Agent
// profile validation from brief §6.
//
// Deliberately free of any Firebase import so it can be tested on its own
// (see tests/validate.test.mjs).
// ---------------------------------------------------------------------------

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts instanceof Date) return ts;
  return null;
}

/** "24 Aug 2026 9:15 AM" — the activity-log format from brief §14.1. */
export function fmtLogTime(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  let hr = d.getHours();
  const ampm = hr >= 12 ? "PM" : "AM";
  hr = hr % 12 || 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hr}:${min} ${ampm}`;
}

/** "24 Aug 2026" */
export function fmtDate(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Lowercase + trim. This is the document ID in the users collection, and it
 * must match request.auth.token.email.lower() in firestore.rules exactly.
 * Do not normalise further (e.g. stripping Gmail dots) — the security rules
 * cannot do the same transformation, so the two would diverge.
 */
export function emailKey(email) {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || "").trim());
}

// --- Profile validation (brief §6) ------------------------------------------

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Malaysian NRIC / I/C: YYMMDD-PB-###G, e.g. 000908-14-0426.
 * Accepts input with or without separators and returns the canonical form.
 */
export function validateNric(raw, { allowPassport = false } = {}) {
  const digits = String(raw || "").replace(/\D/g, "");
  const compact = String(raw || "").toUpperCase().replace(/[\s\-\/.]/g, "");
  if (!digits && !(allowPassport && compact)) return { ok: false, error: "I/C number is required." };
  // A non-Malaysian owner has a passport number instead: letters and digits.
  if (allowPassport && !(digits.length === 12 && /^\d+$/.test(compact))) {
    if (!/^[A-Z0-9]{5,20}$/.test(compact)) {
      return { ok: false, error: "Enter a 12-digit I/C number, or a passport number (letters and digits only)." };
    }
    return { ok: true, value: compact, passport: true,
      warning: "Not a Malaysian I/C number, so it is kept as a passport number. Check it if the owner is Malaysian." };
  }
  if (digits.length !== 12) {
    return { ok: false, error: `An I/C number has 12 digits, e.g. 000908-14-0426. You entered ${digits.length}.` };
  }
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12) {
    return { ok: false, error: `The month in the birth-date part must be 01–12 (you entered ${digits.slice(2, 4)}).` };
  }
  if (dd < 1 || dd > DAYS_IN_MONTH[mm - 1]) {
    return { ok: false, error: `The day in the birth-date part is not a valid date (you entered ${digits.slice(4, 6)}).` };
  }

  // Place-of-birth code. Some two-digit codes have never been issued, but the
  // published lists disagree at the edges, so this is a WARNING and not a
  // rejection — wrongly refusing a real person's I/C is the worse failure.
  const pb = Number(digits.slice(6, 8));
  const unusedPb = pb === 0 || (pb >= 17 && pb <= 20) || pb === 69 || pb === 70 ||
                   pb === 73 || pb === 74 || (pb >= 94 && pb <= 98);

  return {
    ok: true,
    value: `${digits.slice(0,6)}-${digits.slice(6,8)}-${digits.slice(8,12)}`,
    warning: unusedPb
      ? `“${digits.slice(6,8)}” is not a place-of-birth code we recognise. Double-check the middle two digits before saving.`
      : null,
  };
}

/**
 * Mobile number. A Malaysian one (019-400 9082, +60 19-400 9082) is tidied to
 * 019-400 9082. A number from another country is accepted when it starts with
 * + (or 00) and its country code, and kept as typed, e.g. +65 9123 4567.
 */
export function validatePhone(raw) {
  let s = String(raw || "").trim();
  if (!s) return { ok: false, error: "Mobile number is required." };
  const typed = s.replace(/\s+/g, " ");
  s = s.replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+60")) s = "0" + s.slice(3);
  else if (s.startsWith("+")) {
    const digits = s.slice(1);
    if (!/^\d{7,15}$/.test(digits)) {
      return { ok: false, error: "An overseas number is + then the country code and number, 7 to 15 digits, e.g. +65 9123 4567." };
    }
    return { ok: true, value: typed.startsWith("00") ? "+" + typed.slice(2) : typed, warning: null, overseas: true };
  }
  else if (/^601\d{8,9}$/.test(s)) s = "0" + s.slice(2);
  if (!/^\d+$/.test(s)) return { ok: false, error: "Use digits only, e.g. 019-400 9082." };
  if (!s.startsWith("01")) {
    return { ok: false, error: "A Malaysian mobile number starts 01… (e.g. 019-400 9082). For an overseas number, start with + and the country code, e.g. +65 9123 4567." };
  }
  if (s.length === 10) return { ok: true, value: `${s.slice(0,3)}-${s.slice(3,6)} ${s.slice(6)}`, warning: null };
  if (s.length === 11) return { ok: true, value: `${s.slice(0,3)}-${s.slice(3,7)} ${s.slice(7)}`, warning: null };
  return { ok: false, error: `A Malaysian mobile number has 10 or 11 digits. You entered ${s.length}.` };
}

export function validateFullName(raw) {
  const v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return { ok: false, error: "Full name is required." };
  if (v.length < 3) return { ok: false, error: "Full name looks too short." };
  if (!/\p{L}/u.test(v)) return { ok: false, error: "Full name must contain letters." };
  return { ok: true, value: v, warning: null };
}

export function validateNickname(raw) {
  const v = String(raw || "").trim().replace(/\s+/g, " ");
  if (!v) return { ok: false, error: "Nickname is required — it appears in the Tenancy Administrator contact line." };
  if (v.length > 40) return { ok: false, error: "Nickname is too long for the contact line (max 40 characters)." };
  return { ok: true, value: v, warning: null };
}

/** brief §6 — a profile is complete only when all four fields are present. */
export const PROFILE_FIELDS = [
  { key: "fullName", label: "Full Name",    validate: validateFullName },
  { key: "nric",     label: "I/C Number",   validate: validateNric },
  { key: "phone",    label: "Phone Number", validate: validatePhone },
  { key: "nickname", label: "Nickname",     validate: validateNickname },
];

export function missingProfileFields(profile) {
  const p = profile || {};
  return PROFILE_FIELDS.filter(f => !String(p[f.key] || "").trim()).map(f => f.label);
}

export function isProfileComplete(profile) {
  return missingProfileFields(profile).length === 0;
}
