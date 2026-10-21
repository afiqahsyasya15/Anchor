// ---------------------------------------------------------------------------
// model.js — the PTAA workflow itself: statuses, the transition table, who
// currently has the ball, and the shape of a request.
//
// This file is the single source of truth for the state machine. firestore.rules
// enforces the SAME table server-side; if you change a transition here, change
// it there too or the server will reject what the UI offers.
//
// No Firebase import — pure data and pure functions, so it can be unit-tested.
// ---------------------------------------------------------------------------

import { validateNric, validatePhone, isValidEmail, toDate } from "./validate.js";

// --- Statuses (brief §7.1) --------------------------------------------------

export const STATUS = {
  NEW:                   "NEW",
  UNDER_REVIEW:          "UNDER_REVIEW",
  CHANGES_REQUIRED:      "CHANGES_REQUIRED",
  PTAA_OK:               "PTAA_OK",
  READY_FOR_AGENT:       "READY_FOR_AGENT",
  WAITING_FOR_SIGNATURE: "WAITING_FOR_SIGNATURE",
  FINAL_CHECK:           "FINAL_CHECK",
  ON_HOLD:               "ON_HOLD",
  COMPLETED:             "COMPLETED",
  CANCELLED:             "CANCELLED",
};

export const STATUS_LABEL = {
  NEW:                   "New",
  UNDER_REVIEW:          "Under review",
  CHANGES_REQUIRED:      "Changes required",
  PTAA_OK:               "PTAA OK",
  READY_FOR_AGENT:       "Ready for agent",
  WAITING_FOR_SIGNATURE: "Waiting for signature",
  FINAL_CHECK:           "Final check",
  ON_HOLD:               "On hold",
  COMPLETED:             "Completed",
  CANCELLED:             "Cancelled",
};

/** Colour tone for the status badge. Colour carries state and nothing else. */
export const STATUS_TONE = {
  NEW:                   "info",
  UNDER_REVIEW:          "info",
  CHANGES_REQUIRED:      "warn",
  PTAA_OK:               "ok",
  READY_FOR_AGENT:       "ok",
  WAITING_FOR_SIGNATURE: "warn",
  FINAL_CHECK:           "warn",
  ON_HOLD:               "off",
  COMPLETED:             "ok",
  CANCELLED:             "off",
};

export const OPEN_STATUSES = [
  STATUS.NEW, STATUS.UNDER_REVIEW, STATUS.CHANGES_REQUIRED, STATUS.PTAA_OK,
  STATUS.READY_FOR_AGENT, STATUS.WAITING_FOR_SIGNATURE, STATUS.FINAL_CHECK,
  STATUS.ON_HOLD,
];

export const CLOSED_STATUSES = [STATUS.COMPLETED, STATUS.CANCELLED];

// --- Current Action (brief §7.4) -------------------------------------------
// Separate from status: status says where the request is, Current Action says
// who has to do something. The admin dashboard is built on this, because
// "is this waiting on me?" is the question being asked every time.

export const ACTOR = {
  ADMIN:    "PTAA Admin",
  AGENT:    "Sales Agent",
  OWNER:    "Owner",
  DIRECTOR: "Director",
  WITNESS:  "Witness",
  NONE:     "None",
};

const DEFAULT_ACTION = {
  NEW:                   ACTOR.ADMIN,
  UNDER_REVIEW:          ACTOR.ADMIN,
  CHANGES_REQUIRED:      ACTOR.AGENT,
  PTAA_OK:               ACTOR.ADMIN,
  READY_FOR_AGENT:       ACTOR.AGENT,
  WAITING_FOR_SIGNATURE: ACTOR.DIRECTOR,
  FINAL_CHECK:           ACTOR.ADMIN,
  ON_HOLD:               ACTOR.NONE,
  COMPLETED:             ACTOR.NONE,
  CANCELLED:             ACTOR.NONE,
};

export function defaultCurrentAction(status) {
  return DEFAULT_ACTION[status] || ACTOR.NONE;
}

// --- Hold reasons (brief §7.3) ---------------------------------------------

export const HOLD_REASONS = [
  "Waiting for Sales Agent",
  "Waiting for Owner",
  "Waiting for Director",
  "Waiting for clarification",
  "Owner considering changes",
  "Other",
];

// --- The transition table (brief §7.2) -------------------------------------
// who: "admin" | "agent" | "either"
// Any transition not in this list is rejected — here and in firestore.rules.
//
// One deliberate omission, still:
//   FINAL_CHECK → COMPLETED is NOT in this table, even though phase 11 now
//   exists. Completing is not a status change — it is the transaction in
//   requests.js → completeRequest, where the Drive upload happens FIRST and the
//   status moves only if Drive confirms the file (brief §11.2, rule #6).
//   Listing it here would let allowedTransitions() render it as an ordinary
//   button, and pressing that button would mark a PTAA completed without ever
//   uploading anything. firestore.rules allows the move only when the same write
//   carries a Drive file id, so neither half can be bypassed.

export const TRANSITIONS = [
  { from: STATUS.NEW,                   to: STATUS.UNDER_REVIEW,          who: "admin",  label: "Start review",            note: "Claim this request and begin checking it." },
  { from: STATUS.UNDER_REVIEW,          to: STATUS.CHANGES_REQUIRED,      who: "admin",  label: "Request changes",         note: "Send it back to the agent with a note.", needsNote: true },
  { from: STATUS.CHANGES_REQUIRED,      to: STATUS.UNDER_REVIEW,          who: "agent",  label: "Send back to admin",      note: "Reply to the admin's change request.", needsNote: true },
  { from: STATUS.UNDER_REVIEW,          to: STATUS.PTAA_OK,               who: "admin",  label: "Mark PTAA OK",            note: "The document is correct. This does NOT release it to the agent yet." },
  { from: STATUS.PTAA_OK,               to: STATUS.READY_FOR_AGENT,       who: "admin",  label: "Release to agent",        note: "Hand it to the Sales Agent." },
  { from: STATUS.READY_FOR_AGENT,       to: STATUS.UNDER_REVIEW,          who: "agent",  label: "Request changes",         note: "The Owner wants something changed. No document needed — just describe it.", needsNote: true, changeRequest: true },
  { from: STATUS.READY_FOR_AGENT,       to: STATUS.WAITING_FOR_SIGNATURE, who: "either", label: "Send for signature",      note: "Signatures are required." },
  { from: STATUS.WAITING_FOR_SIGNATURE, to: STATUS.FINAL_CHECK,           who: "admin",  label: "Signatures complete",     note: "All required signatures are recorded." },
  { from: STATUS.READY_FOR_AGENT,       to: STATUS.FINAL_CHECK,           who: "admin",  label: "Go to final check",       note: "No signatures required." },
];

/** ON_HOLD and CANCELLED are reachable from any open status, admin only. */
export const HOLDABLE = OPEN_STATUSES.filter(s => s !== STATUS.ON_HOLD);

export function allowedTransitions(status, role) {
  const out = TRANSITIONS.filter(t =>
    t.from === status && (t.who === "either" || t.who === role));

  if (role === "admin") {
    if (status === STATUS.ON_HOLD) {
      out.push({ from: STATUS.ON_HOLD, to: "__resume__", who: "admin",
                 label: "Resume", note: "Return to the status it was held from." });
    } else if (!CLOSED_STATUSES.includes(status)) {
      out.push({ from: status, to: STATUS.ON_HOLD, who: "admin",
                 label: "Put on hold", note: "Pause it with a reason.", needsReason: true });
      out.push({ from: status, to: STATUS.CANCELLED, who: "admin",
                 label: "Cancel", note: "Stop this request for good.", needsReason: true,
                 destructive: true });
    }
  }
  return out;
}

/** Mirrors the server rule. Used to fail fast with a clear message. */
export function isTransitionAllowed(from, to, role) {
  if (from === to) return false;
  if (role === "admin") {
    if (to === STATUS.ON_HOLD) return HOLDABLE.includes(from);
    if (to === STATUS.CANCELLED) return !CLOSED_STATUSES.includes(from);
    if (from === STATUS.ON_HOLD) return OPEN_STATUSES.includes(to) && to !== STATUS.ON_HOLD;
  }
  return TRANSITIONS.some(t =>
    t.from === from && t.to === to && !t.notYet &&
    (t.who === "either" || t.who === role));
}

// --- Signatories (brief §9.2, §10) -----------------------------------------
// Tracked separately, because not every PTAA needs the same people. The overall
// state is derived from the individual ones, never stored on its own.

export const SIGNATORY_TYPES = [
  { key: "director", label: "Director",
    note: "The Admin holds a stored Director signature image." },
  { key: "witness", label: "Witness",
    note: "The Admin holds a stored Admin/Witness signature image." },
  { key: "owner", label: "Owner",
    note: "Signed in person; the signed copy comes back as an upload." },
  { key: "agent", label: "Sales Agent",
    note: "The agent's own image, if they uploaded one on their profile." },
];

export const SIGNATORY_STATUS = {
  REQUIRED: "REQUIRED",
  REQUESTED: "REQUESTED",
  SIGNED: "SIGNED",
  NOT_REQUIRED: "NOT_REQUIRED",
};

export const SIGNATORY_STATUS_LABEL = {
  REQUIRED: "Required",
  REQUESTED: "Requested",
  SIGNED: "Signed",
  NOT_REQUIRED: "Not required",
};

export const SIGNATORY_TONE = {
  REQUIRED: "warn", REQUESTED: "info", SIGNED: "ok", NOT_REQUIRED: "off",
};

/**
 * "Director: SIGNED, Witness: PENDING → Waiting for Witness" (brief §9.2).
 * Returns { done, total, outstanding:[label], text }.
 */
export function signatureSummary(signatories) {
  const s = signatories || {};
  const active = SIGNATORY_TYPES.filter(t => {
    const st = (s[t.key] || {}).status;
    return st && st !== SIGNATORY_STATUS.NOT_REQUIRED;
  });
  const signed = active.filter(t => s[t.key].status === SIGNATORY_STATUS.SIGNED);
  const outstanding = active.filter(t => s[t.key].status !== SIGNATORY_STATUS.SIGNED)
                            .map(t => t.label);

  let text;
  if (active.length === 0) text = "No signatures required.";
  else if (outstanding.length === 0) text = "All required signatures recorded.";
  else if (outstanding.length === 1) text = `Waiting for ${outstanding[0]}.`;
  else text = `Waiting for ${outstanding.slice(0, -1).join(", ")} and ${outstanding[outstanding.length - 1]}.`;

  return { done: signed.length, total: active.length, outstanding, text,
           complete: active.length > 0 && outstanding.length === 0,
           anyRequired: active.length > 0 };
}

/** Whichever signatory is holding things up decides the Current Action. */
export function signatureCurrentAction(signatories) {
  const s = signatories || {};
  for (const key of ["director", "witness", "owner", "agent"]) {
    const st = (s[key] || {}).status;
    if (st && st !== SIGNATORY_STATUS.SIGNED && st !== SIGNATORY_STATUS.NOT_REQUIRED) {
      return { director: ACTOR.DIRECTOR, witness: ACTOR.WITNESS,
               owner: ACTOR.OWNER, agent: ACTOR.AGENT }[key];
    }
  }
  return ACTOR.ADMIN;
}

// --- Final checklist (brief §11.1) -----------------------------------------
// Eleven confirmations. Every one must be ticked before completion is even
// offered — and completion additionally needs the Drive upload of phase 11.

export const CHECKLIST = [
  { key: "ptaa_info",     label: "PTAA information checked" },
  { key: "owner_info",    label: "Owner information checked" },
  { key: "property_unit", label: "Property / unit checked" },
  { key: "tenancy",       label: "Tenancy period checked" },
  { key: "special_terms", label: "Special terms checked" },
  { key: "quotation",     label: "Quotation / invoice checked" },
  { key: "signatures",    label: "Required signatures completed" },
  { key: "no_changes",    label: "No outstanding changes" },
  { key: "no_requests",   label: "No unresolved information requests" },
  { key: "filename",      label: "Correct document filename" },
  { key: "document",      label: "Final Word document exists" },
];

export function checklistProgress(checklist) {
  const c = checklist || {};
  const done = CHECKLIST.filter(item => c[item.key] && c[item.key].checked).length;
  return { done, total: CHECKLIST.length, complete: done === CHECKLIST.length,
           outstanding: CHECKLIST.filter(item => !(c[item.key] && c[item.key].checked)) };
}

/**
 * Some items can be answered by the system rather than taken on trust. Where
 * they can, a tick that contradicts the record is refused.
 */
export function checklistBlockers(request) {
  const r = request || {};
  const out = {};
  if (!r.workingDoc) {
    out.document = "No document has been produced for this request yet.";
    out.filename = "There is no document yet, so its filename cannot be confirmed.";
  }
  const sig = signatureSummary(r.signatories);
  if (sig.anyRequired && !sig.complete) {
    out.signatures = sig.text;
  }
  if (r.openChangeRequest) {
    out.no_changes = "There is an open change request from the Sales Agent.";
  }
  return out;
}

// --- Global search (brief §8.4) ---------------------------------------------
//
// The two questions it has to answer well are named in the brief:
//   "I remember the Owner's name but not the PTAA number"
//   "I remember the condo and unit but not the Owner"
//
// Both are partial-recall questions, which rules out exact matching. Every word
// typed must appear SOMEWHERE in the record ("astra 18-09" finds M ASTRA
// A-18-09), and results are ranked so that the field you were most likely
// searching by comes first.
//
// Pure and dependency-free so it can be tested directly — see tests/search.test.mjs.

/** Everything about a request that someone might search by, as one haystack. */
export function searchableText(r) {
  const o = r.owner || {};
  const a = r.agentSnapshot || {};
  const d = r.drive || {};
  return [
    r.ptaaId, o.name, o.nric, o.phone, o.email,
    r.propertyName, r.unitNo, r.propertyAddress, r.ptaaType,
    r.agentEmail, a.fullName, a.nickname,
    STATUS_LABEL[r.status] || r.status,
    r.currentAction,
    d.fileName, d.webViewLink, d.fileId,
    REQUEST_TYPE_LABEL[r.type] || r.type,
  ].filter(Boolean).join("  ").toLowerCase();
}

/**
 * Rank a match. Higher is better.
 *
 * A hit on the PTAA number or the owner's name is almost always what the person
 * meant; a hit somewhere in an address usually is not. Without this, typing
 * "ting" puts a request whose *address* contains "Ting" above the owner
 * actually called LOY HUI TING.
 */
function scoreRequest(r, terms) {
  const o = r.owner || {};
  const a = r.agentSnapshot || {};
  const fields = [
    { text: r.ptaaId,        weight: 100 },
    { text: o.name,          weight: 90 },
    { text: r.unitNo,        weight: 70 },
    { text: r.propertyName,  weight: 65 },
    { text: (r.drive || {}).fileName, weight: 55 },
    { text: a.fullName,      weight: 40 },
    { text: a.nickname,      weight: 40 },
    { text: r.agentEmail,    weight: 35 },
    { text: o.nric,          weight: 30 },
    { text: o.phone,         weight: 25 },
    { text: r.ptaaType,      weight: 15 },
    { text: r.propertyAddress, weight: 10 },
  ];

  let score = 0;
  for (const term of terms) {
    for (const f of fields) {
      const text = String(f.text || "").toLowerCase();
      if (!text) continue;
      if (text === term) { score += f.weight * 3; break; }        // exact field
      if (text.startsWith(term)) { score += f.weight * 2; break; } // starts with
      if (text.includes(term)) { score += f.weight; break; }       // contains
    }
  }
  return score;
}

/**
 * @param {object[]} rows     requests to search
 * @param {string} queryText  what was typed
 * @param {object} [opts]     { limit }
 * @returns {object[]} matches, best first
 */
export function searchRequests(rows, queryText, { limit = 50 } = {}) {
  const terms = String(queryText || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const out = [];
  for (const r of rows || []) {
    const hay = searchableText(r);
    // AND, not OR: every word must appear somewhere, or "loy astra" would
    // return every request for either — which is the opposite of narrowing.
    if (!terms.every(t => hay.includes(t))) continue;
    out.push({ request: r, score: scoreRequest(r, terms) });
  }

  out.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    // Same relevance: newest first, so the one being worked on surfaces.
    const xt = toDate(x.request.updatedAt), yt = toDate(y.request.updatedAt);
    return (yt ? yt.getTime() : 0) - (xt ? xt.getTime() : 0);
  });
  return out.slice(0, limit).map(x => x.request);
}

// --- Reporting (brief §13) --------------------------------------------------

/** Whole days between two dates, or null if either is missing. */
function daysBetween(a, b) {
  const from = toDate(a), to = toDate(b);
  if (!from || !to) return null;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * A few numbers that are actually actionable, rather than a wall of charts:
 * where the open work is sitting, who it is with, and how long completed PTAAs
 * took end to end.
 */
export function buildReport(rows, { now = new Date() } = {}) {
  const all = rows || [];
  const open = all.filter(r => OPEN_STATUSES.includes(r.status));
  const completed = all.filter(r => r.status === STATUS.COMPLETED);

  const count = (list, key) => {
    const m = new Map();
    for (const r of list) {
      const k = key(r) || "—";
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const turnarounds = completed
    .map(r => daysBetween(r.createdAt, r.completedAt))
    .filter(n => n !== null)
    .sort((a, b) => a - b);

  const median = turnarounds.length
    ? turnarounds[Math.floor(turnarounds.length / 2)]
    : null;

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const completedThisMonth = completed.filter(r => {
    const d = toDate(r.completedAt);
    return d && d >= monthStart;
  }).length;

  return {
    total: all.length,
    open: open.length,
    completed: completed.length,
    cancelled: all.filter(r => r.status === STATUS.CANCELLED).length,
    completedThisMonth,
    byStatus: count(open, r => STATUS_LABEL[r.status] || r.status),
    byProperty: count(all, r => r.propertyName),
    byAgent: count(open, r => r.agentEmail),
    withAdmin: open.filter(r => r.currentAction === ACTOR.ADMIN).length,
    withAgent: open.filter(r => r.currentAction === ACTOR.AGENT).length,
    medianDaysToComplete: median,
    fastest: turnarounds.length ? turnarounds[0] : null,
    slowest: turnarounds.length ? turnarounds[turnarounds.length - 1] : null,
    // Completed but with no Drive link is the one state that should be
    // impossible; if it is ever non-zero something bypassed completeRequest.
    completedWithoutDriveLink: completed.filter(r => !(r.drive && r.drive.fileId)).length,
  };
}

// --- PTAA identifier --------------------------------------------------------

export function formatPtaaId(n) {
  return "PTAA-" + String(n).padStart(5, "0");
}

// --- Filename ---------------------------------------------------------------
//
//   PTAA ([CONDO NAME] [CONDO UNIT]) [OWNER'S NAME].docx
//   e.g. PTAA (ONE EQUINE C-01-03) YEN POH WE.docx
//
// Generated, never typed. Shown from phase 2 onward so a wrong owner name or
// unit is visible long before the document is produced.
//
// DELIBERATE DEVIATION FROM BRIEF \u00a711.3, which specifies
// "PTAA (M ASTRA A-18-09 Partition) - LOY HUI TING.docx" \u2014 with the PTAA type
// inside the brackets and a hyphen before the owner. Irfan gave the convention
// actually in use, which has neither. The office wins over the brief; the brief
// is the older document.
//
// One consequence worth knowing: without the type, a Partition and a WUR for the
// same unit and owner produce the SAME filename. That is why the Drive upload
// refuses to overwrite a file belonging to a different PTAA rather than trusting
// the name to be unique \u2014 see drive.js.

// Characters Windows and Google Drive refuse in a filename, plus control
// characters. Hyphens and spaces are KEPT \u2014 both appear in the real pattern.
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001F]/g;

export function ptaaFilename({ propertyName, unitNo, ownerName }) {
  const clean = (s) => String(s || "").replace(INVALID_FILENAME_CHARS, " ")
                                     .replace(/\s+/g, " ").trim();
  const p = clean(propertyName) || "[property]";
  const u = clean(unitNo)       || "[unit]";
  const o = clean(ownerName)    || "[owner]";
  return `PTAA (${p} ${u}) ${o}.docx`;
}

// --- Request shape ----------------------------------------------------------

// Partition is the only type with partition works, so the only one whose
// agreement carries Appendix B (Special Terms for Partition Works).
export const PTAA_TYPES = ["Partition", "No Partition", "WUR"];
export const hasAppendixB = (ptaaType) => ptaaType === "Partition";

// --- Utilities (schedule items 11, 12 and 13) -------------------------------
// Who pays for what changes from PTAA to PTAA: some owners pay, some pass it to
// the tenant, and some take a package where the company advances it and recovers
// it from the rental proceeds. So each utility is assigned a party rather than
// being fixed in the template.

export const UTILITY_PARTY = {
  OWNER:    "owner",       // schedule item 11
  ADVANCED: "advanced",    // item 12 — advanced by us, recovered from rent
  TENANT:   "tenant",      // item 13
  NONE:     "none",        // not applicable to this PTAA
};

export const UTILITY_PARTY_LABEL = {
  owner:    "Owner pays",
  advanced: "We advance, recover from rent",
  tenant:   "Tenant pays",
  none:     "Not applicable",
};

export const UTILITY_PARTY_TONE = {
  owner: "info", advanced: "warn", tenant: "ok", none: "off",
};

/** The five that appear on the D TERRA schedule. More can be added per request. */
export const STANDARD_UTILITIES = [
  { key: "electricity", label: "Electricity" },
  { key: "water",       label: "Water" },
  { key: "internet",    label: "Wi-Fi / Internet" },
  { key: "cleaning",    label: "Cleaning Services" },
  { key: "aircond",     label: "AC Usage via Smart Meter" },
];

/** The three that a preset switches together. Cleaning and aircond are separate. */
export const PRESET_UTILITIES = ["electricity", "water", "internet"];

// Each quick set fixes all five standard utilities, exactly as the office
// uses them. A utility added by hand is left alone.
const O = UTILITY_PARTY.OWNER, A = UTILITY_PARTY.ADVANCED, T = UTILITY_PARTY.TENANT, N = UTILITY_PARTY.NONE;
export const UTILITY_PRESETS = [
  { key: "owner",    label: "Owner pays",      party: O,
    parties: { electricity: O, water: O, internet: O, cleaning: A, aircond: T },
    note: "Electricity, water and internet: Owner. Cleaning: we advance and recover. A/C: Tenant." },
  { key: "tenant",   label: "Tenant pays",     party: T,
    parties: { electricity: T, water: T, internet: T, cleaning: N, aircond: N },
    note: "Electricity, water and internet: Tenant. Cleaning and A/C not applicable. Rows 11 and 12 read NIL." },
  { key: "package",  label: "Company package", party: A,
    parties: { electricity: A, water: A, internet: A, cleaning: A, aircond: T },
    note: "Electricity, water, internet and cleaning: we advance and recover from rent. A/C: Tenant. Row 11 reads NIL." },
];

/**
 * Starting assignment for a new request.
 * WUR is Whole Unit Rental — the tenant has the entire unit, so cleaning is
 * theirs rather than something we advance.
 */
export function defaultUtilities(ptaaType) {
  const cleaning = ptaaType === "WUR" ? UTILITY_PARTY.TENANT : UTILITY_PARTY.ADVANCED;
  const out = {};
  for (const u of STANDARD_UTILITIES) {
    out[u.key] = {
      label: u.label,
      party: u.key === "cleaning" ? cleaning
           : u.key === "aircond"  ? UTILITY_PARTY.TENANT
           : UTILITY_PARTY.OWNER,
      standard: true,
    };
  }
  return out;
}

/** Apply a quick set: all five standard utilities, as the preset lists them. */
export function applyUtilityPreset(utilities, presetKey) {
  const preset = UTILITY_PRESETS.find(p => p.key === presetKey);
  if (!preset) return utilities;
  const out = { ...(utilities || {}) };
  for (const [key, party] of Object.entries(preset.parties)) {
    const existing = out[key] || (STANDARD_UTILITIES.find(u => u.key === key) || {});
    out[key] = { label: existing.label, party, standard: true };
  }
  return out;
}

/** What the three schedule rows will say, for the on-screen preview. */
export function utilitiesByParty(utilities) {
  const out = { owner: [], advanced: [], tenant: [], none: [] };
  for (const entry of Object.values(utilities || {})) {
    const party = (entry && entry.party) || UTILITY_PARTY.NONE;
    if (out[party]) out[party].push(entry.label);
  }
  return out;
}

export const REQUEST_TYPE = {
  NEW_PTAA: "NEW_PTAA",
};

export const REQUEST_TYPE_LABEL = {
  NEW_PTAA: "New PTAA Request",
};

/** Attachment kinds. Brief §12: none of these are retained after completion. */
/**
 * The three things a Sales Agent attaches, and where each one lands in the
 * agreement. This is no longer a free-for-all gallery: they are named slots,
 * one file each, because each one has a specific place in the document and an
 * unlabelled pile of photographs cannot be put anywhere automatically.
 *
 * `tag` is the placeholder the image fills — see js/placeholders.js.
 */
export const ATTACHMENT_SLOTS = [
  { key: "ic_front", tag: "ic_front", label: "Owner I/C — front",
    where: "Goes on the I/C page, just before Appendix A.",
    accept: "image/*", camera: true, required: true },
  { key: "ic_back", tag: "ic_back", label: "Owner I/C — back",
    where: "Below the front, on the same page.",
    accept: "image/*", camera: true, required: true },
  { key: "quotation", tag: "quotation", label: "Renovation quotation",
    where: "Used to fill in the invoice — attach the PDF so its items can be read automatically.",
    accept: "image/*,application/pdf", camera: false, required: false,
    note: "Only needed when there is a renovation cost." },
];

export const ATTACHMENT_KINDS = ATTACHMENT_SLOTS.map(s => ({ value: s.key, label: s.label }));

/** Which slots are still empty, for the on-screen prompt. */
export function missingAttachments(attachments, { renovationCost = null } = {}) {
  const have = new Set((attachments || []).map(a => a.kind));
  // One picture with both sides of the card, that could not be cut in two.
  const bothInFront = (attachments || []).some(a => a.kind === "ic_front" && a.bothSides);
  return ATTACHMENT_SLOTS.filter(s => {
    if (have.has(s.key)) return false;
    if (s.key === "ic_back" && bothInFront) return false;
    // The quotation is only expected when there is something to quote for.
    if (s.key === "quotation") return renovationCost != null && Number(renovationCost) > 0;
    return s.required;
  });
}

/** One file per slot; a quotation PDF becomes several rows sharing a slot. */
export const MAX_ATTACHMENTS = 14;

// --- Dates ------------------------------------------------------------------

/** "2026-08-28" → Date at local midnight. Avoids the UTC shift of new Date(str). */
export function parseDateInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toDateInput(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Tenancy expiry: commencement + term months, minus one day.
 * A 12-month term starting 1 Jan 2026 ends 31 Dec 2026, not 1 Jan 2027.
 * Month-end is clamped: 31 Jan + 1 month → 28/29 Feb, so the expiry is the
 * last day of February rather than spilling into March.
 */
export function computeExpiry(commencement, months) {
  const start = commencement instanceof Date ? commencement : parseDateInput(commencement);
  const n = Number(months);
  if (!start || !Number.isFinite(n) || n <= 0) return null;

  const y = start.getFullYear();
  const m = start.getMonth();
  const day = start.getDate();
  const targetMonth = m + n;
  const lastDayOfTarget = new Date(y, targetMonth + 1, 0).getDate();
  const end = new Date(y, targetMonth, Math.min(day, lastDayOfTarget));
  end.setDate(end.getDate() - 1);
  return end;
}

export function isOverdue(dueDate, status, now = new Date()) {
  if (!dueDate || CLOSED_STATUSES.includes(status)) return false;
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return now > endOfDay;
}

export function isDueToday(dueDate, status, now = new Date()) {
  if (!dueDate || CLOSED_STATUSES.includes(status)) return false;
  const d = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
}

// --- Money ------------------------------------------------------------------

export function parseMoney(value) {
  const s = String(value ?? "").replace(/[,\s]/g, "").replace(/^RM/i, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    return { ok: false, error: "Enter an amount like 1200 or 1200.50 (no currency symbol needed)." };
  }
  return { ok: true, value: Number(s) };
}

export function fmtMoney(n) {
  if (n === null || n === undefined || n === "") return "—";
  return "RM " + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- Request validation -----------------------------------------------------
// Returns { ok, errors:{fieldPath: message}, value } — `value` is the cleaned,
// canonical form that gets written, so what is stored is never what was typed
// if the two differ (phone and I/C are normalised).

export function validateRequestDraft(draft, { requireTenancy = false } = {}) {
  const d = draft || {};
  const o = d.owner || {};
  const t = d.tenancy || {};
  const f = d.financial || {};
  const errors = {};
  const value = { owner: {}, tenancy: {}, financial: {} };

  // --- Owner ---
  const name = String(o.name || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!name) errors["owner.name"] = "Owner's name is required — it goes in the agreement and the filename.";
  else if (name.length < 3) errors["owner.name"] = "Owner's name looks too short.";
  value.owner.name = name;

  const nric = validateNric(o.nric, { allowPassport: true });   // a foreign owner has a passport
  if (!nric.ok) errors["owner.nric"] = nric.error;
  value.owner.nric = nric.ok ? nric.value : "";
  const nricWarning = nric.ok ? nric.warning : null;

  const addr = String(o.address || "").trim();
  if (!addr) errors["owner.address"] = "Owner's address is required.";
  value.owner.address = addr;

  const phone = validatePhone(o.phone);
  if (!phone.ok) errors["owner.phone"] = phone.error;
  value.owner.phone = phone.ok ? phone.value : "";

  const email = String(o.email || "").trim().toLowerCase();
  if (email && !isValidEmail(email)) errors["owner.email"] = "That does not look like an email address.";
  value.owner.email = email;

  // Item 3b of the schedule — where the rental proceeds are remitted.
  value.owner.bankName = String(o.bankName || "").trim();
  const acct = String(o.accountNumber || "").replace(/[\s-]/g, "");
  if (acct && !/^\d{6,20}$/.test(acct)) {
    errors["owner.accountNumber"] = "A bank account number is 6 to 20 digits.";
  }
  value.owner.accountNumber = acct;

  // --- Property ---
  if (!d.propertyId) errors["propertyId"] = "Choose the property. If it is missing, ask an admin to add it.";
  value.propertyId = d.propertyId || "";
  value.propertyName = String(d.propertyName || "").trim();
  value.propertyAddress = String(d.propertyAddress || "").trim();

  const unit = String(d.unitNo || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!unit) errors["unitNo"] = "Unit number is required.";
  value.unitNo = unit;

  if (!PTAA_TYPES.includes(d.ptaaType)) errors["ptaaType"] = "Choose Partition, No Partition or WUR.";
  value.ptaaType = d.ptaaType || "";

  // Item 2 of the schedule — "Size: 1151 square feet".
  const sizeRaw = String(d.propertySize ?? "").replace(/[,\s]/g, "");
  if (sizeRaw === "") {
    value.propertySize = null;
  } else if (!/^\d{1,6}$/.test(sizeRaw)) {
    errors["propertySize"] = "Enter the built-up size in square feet, digits only.";
    value.propertySize = null;
  } else {
    value.propertySize = Number(sizeRaw);
  }

  // --- Tenancy ---
  // Only the admin sets the tenancy period — the Sales Agent does not know the
  // commencement date when submitting — so it may be left blank here and is
  // filled in before the PTAA is drafted. What IS given must be valid.
  const termRaw = t.initialTermMonths;
  const termGiven = !(termRaw === "" || termRaw === null || termRaw === undefined);
  const months = Number(termRaw);
  if (!termGiven) {
    if (requireTenancy) errors["tenancy.initialTermMonths"] = "Initial term is required.";
  } else if (!Number.isInteger(months) || months < 1 || months > 240) {
    errors["tenancy.initialTermMonths"] = "Enter the term in whole months, between 1 and 240.";
  }
  value.tenancy.initialTermMonths = termGiven && Number.isInteger(months) ? months : null;

  const start = parseDateInput(t.commencementDate);
  if (!t.commencementDate) {
    if (requireTenancy) errors["tenancy.commencementDate"] = "Commencement date is required.";
  } else if (!start) errors["tenancy.commencementDate"] = "That is not a valid date.";
  value.tenancy.commencementDate = start ? t.commencementDate : "";

  // Expiry is derived from the commencement and the term, but an admin may
  // override it.
  let expiry = parseDateInput(t.expiryDate);
  if (t.expiryDate && !expiry) errors["tenancy.expiryDate"] = "That is not a valid date.";
  if (!expiry && start && value.tenancy.initialTermMonths) {
    expiry = computeExpiry(start, value.tenancy.initialTermMonths);
  }
  if (expiry && start && expiry <= start) {
    errors["tenancy.expiryDate"] = "Expiry must be after the commencement date.";
  }
  value.tenancy.expiryDate = toDateInput(expiry);

  // --- Financial ---
  // The agreement reads "Ten Per centum (10 %) of the total gross monthly rental",
  // so this is a percentage of rent, not a Ringgit amount.
  const pctRaw = String(f.monthlyAdminFeePercent ?? "").replace(/[%\s]/g, "");
  if (pctRaw === "") {
    errors["financial.monthlyAdminFeePercent"] = "The monthly administration fee percentage is required.";
    value.financial.monthlyAdminFeePercent = null;
  } else if (!/^\d{1,3}(\.\d{1,2})?$/.test(pctRaw) || Number(pctRaw) <= 0 || Number(pctRaw) > 100) {
    errors["financial.monthlyAdminFeePercent"] =
      "Enter a percentage between 0 and 100, e.g. 10 for \u201cTen Per centum (10 %)\u201d.";
    value.financial.monthlyAdminFeePercent = null;
  } else {
    value.financial.monthlyAdminFeePercent = Number(pctRaw);
  }

  const reno = parseMoney(f.renovationCost);
  if (!reno.ok) errors["financial.renovationCost"] = reno.error;
  value.financial.renovationCost = reno.ok ? reno.value : null;

  // --- Special terms (variable length, never a fixed number of slots) ---
  value.specialTerms = (Array.isArray(d.specialTerms) ? d.specialTerms : [])
    .map(s => String(s || "").trim())
    .filter(Boolean);

  value.notes = String(d.notes || "").trim();

  // Utilities: keep only entries with a label, and force an unknown party to
  // "none" rather than letting it silently vanish from all three schedule rows.
  const utilities = {};
  for (const [key, entry] of Object.entries(d.utilities || {})) {
    const label = String((entry && entry.label) || "").trim();
    if (!label) continue;
    const party = Object.values(UTILITY_PARTY).includes(entry.party)
      ? entry.party : UTILITY_PARTY.NONE;
    utilities[key] = { label, party, standard: !!entry.standard };
  }
  value.utilities = utilities;

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    warnings: nricWarning ? { "owner.nric": nricWarning } : {},
    value,
  };
}

/** Field order for the form and for "what is still missing" messages. */
export const REQUEST_FIELD_LABELS = {
  "owner.name": "Owner's name",
  "owner.nric": "Owner's I/C",
  "owner.address": "Owner's address",
  "owner.phone": "Owner's phone",
  "owner.email": "Owner's email",
  "propertyId": "Property",
  "unitNo": "Unit number",
  "ptaaType": "PTAA type",
  "tenancy.initialTermMonths": "Initial term",
  "tenancy.commencementDate": "Commencement date",
  "tenancy.expiryDate": "Expiry date",
  "financial.monthlyAdminFeePercent": "Monthly administration fee (%)",
  "financial.renovationCost": "Renovation cost",
  "propertySize": "Property size",
  "owner.bankName": "Owner\u2019s bank",
  "owner.accountNumber": "Owner\u2019s account number",
};

/** Is the tenancy period (term, commencement, expiry) filled in? */
export function tenancyMissing(r) {
  const t = (r && r.tenancy) || {};
  const out = [];
  if (!t.initialTermMonths) out.push("initial term");
  if (!t.commencementDate) out.push("commencement date");
  if (!t.expiryDate) out.push("expiry date");
  return out;
}

/** For on-screen previews. */
export function fmtPercent(n) {
  if (n === null || n === undefined || n === "") return "\u2014";
  return `${n} %`;
}

// --- Solo workflow stages ---------------------------------------------------
// In solo mode the status is only Draft → Filed (or Cancelled). Where a PTAA
// actually is in between is read off what exists, so it can never disagree
// with the files.

export const SOLO_STAGES = {
  DETAILS:   { key: "details",   label: "Details",          tone: "info", step: 1 },
  DRAFTING:  { key: "drafting",  label: "Drafting",         tone: "info", step: 2 },
  EDITING:   { key: "editing",   label: "Edit and confirm", tone: "warn", step: 3 },
  READY:     { key: "ready",     label: "Ready to file",    tone: "brand", step: 4 },
  FILED:     { key: "filed",     label: "Filed",            tone: "ok",   step: 5 },
  CANCELLED: { key: "cancelled", label: "Cancelled",        tone: "off",  step: 0 },
};

export function soloStage(r) {
  const x = r || {};
  if (x.status === STATUS.CANCELLED) return SOLO_STAGES.CANCELLED;
  if (x.status === STATUS.COMPLETED) return SOLO_STAGES.FILED;
  const doc = x.workingDoc;
  const inv = x.invoice && x.invoice.file;
  const none = !!(x.invoice && x.invoice.none);          // no invoice for this PTAA
  if (doc && doc.confirmed && (none || (inv && inv.confirmed))) return SOLO_STAGES.READY;
  if (doc && (none || inv)) return SOLO_STAGES.EDITING;
  if (doc || inv) return SOLO_STAGES.DRAFTING;
  return SOLO_STAGES.DETAILS;
}

// --- What a Sales Agent sees -----------------------------------------------
// An agent follows their PTAA in four plain states and gets one file at the
// end: the finished PDF the admin sends them.

export const AGENT_STAGES = {
  SUBMITTED: { key: "submitted", label: "Submitted",         tone: "neutral", note: "With the admin — not started yet." },
  PREPARING: { key: "preparing", label: "Being prepared",    tone: "info",    note: "The admin is preparing the agreement." },
  READY:     { key: "ready",     label: "Ready to download", tone: "ok",      note: "The finished PDF is ready." },
  CANCELLED: { key: "cancelled", label: "Cancelled",         tone: "off",     note: "This PTAA was cancelled." },
};

export function agentStage(r) {
  const x = r || {};
  if (x.status === STATUS.CANCELLED) return AGENT_STAGES.CANCELLED;
  if (x.finalPdf) return AGENT_STAGES.READY;
  if (x.status === STATUS.COMPLETED || x.workingDoc || (x.invoice && (x.invoice.file || x.invoice.invoiceNo))) {
    return AGENT_STAGES.PREPARING;
  }
  return AGENT_STAGES.SUBMITTED;
}

// --- Renovation cost vs the invoice -----------------------------------------
// The agreement prints the renovation cost from the PTAA's details; the
// invoice has its own total. They must agree — when they do not, say so.

/** null when they agree (or there is nothing to compare), else the two amounts. */
export function costClash(r) {
  const x = r || {};
  const inv = x.invoice;
  if (!inv || inv.none || x.status === STATUS.CANCELLED) return null;
  const total = Number(inv.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const raw = (x.financial || {}).renovationCost;
  const reno = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (reno !== null && Math.abs(reno - total) < 0.005) return null;
  // The admin has seen this exact difference and said it is right.
  if (sameAck(inv.costAck, reno, total)) return null;
  return { renovationCost: reno, invoiceTotal: total,
           difference: reno === null ? null : Math.round((total - reno) * 100) / 100 };
}

function sameAck(ack, reno, total) {
  return !!ack && Number(ack.invoiceTotal) === total &&
    (ack.renovationCost === null || ack.renovationCost === undefined ? reno === null : Number(ack.renovationCost) === reno);
}

/** The admin's note that the two amounts differ on purpose, while it still applies. */
export function costAcknowledged(r) {
  const x = r || {};
  const inv = x.invoice;
  if (!inv || !inv.costAck) return null;
  const raw = (x.financial || {}).renovationCost;
  const reno = raw === null || raw === undefined || raw === "" ? null : Number(raw);
  return sameAck(inv.costAck, reno, Number(inv.total)) ? inv.costAck : null;
}

/** Compare a renovation cost with an invoice total that may not be saved yet. */
export function amountsDiffer(renovationCost, invoiceTotal) {
  const reno = renovationCost === null || renovationCost === undefined || renovationCost === "" ? null : Number(renovationCost);
  const total = Number(invoiceTotal);
  if (!Number.isFinite(total) || total <= 0) return false;
  return reno === null || Math.abs(reno - total) >= 0.005;
}

export function costClashText(c) {
  if (!c) return "";
  return c.renovationCost === null
    ? `The PTAA's renovation cost is NIL, but the invoice total is ${fmtMoney(c.invoiceTotal)}.`
    : `The PTAA says renovation cost ${fmtMoney(c.renovationCost)}, but the invoice total is ${fmtMoney(c.invoiceTotal)}.`;
}

