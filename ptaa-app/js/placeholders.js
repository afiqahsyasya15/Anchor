// ---------------------------------------------------------------------------
// placeholders.js — the placeholder set, the template check, and the by-name
// field mapping.
//
// This set is taken from the real D TERRA template rather than invented. Two
// things learned from comparing that template against its finished document:
//
//   * The agreement writes each figure twice — in words and in digits. So
//     {{initial_term_months}} is "Thirty-six" and {{initial_term_months_numberic}}
//     is "36". Same for the fee.
//   * The Monthly Tenancy Administration Fee is a PERCENTAGE of gross monthly
//     rental — "Ten Per centum (10 %)" — not a Ringgit amount.
//
// Rules that still hold (§5.1, rule #3): fields are found by name only. Never by
// page number, paragraph index, or by searching for sample text.
//
// No Firebase and no zip library here — pure string work, so it can be tested.
// ---------------------------------------------------------------------------

import { numberInWords, percentInWords, ordinalDay } from "./numberwords.js";

export const DELIMITERS = { start: "{{", end: "}}" };

/**
 * required: the upload is refused without it — the document would not be a PTAA.
 * Everything else is filled when present and merely reported when absent, because
 * condos differ: some templates have no bank row, some bake the condo name in.
 */
export const FIELDS = [
  // --- Document ---
  { tag: "today_date",   group: "Document", required: true,  note: "Date of the agreement, e.g. 21st August 2026" },
  { tag: "today_date_upper", group: "Document",              note: "Same date as 21ST DAY OF AUGUST 2026, for the “DATED THIS” line" },
  { tag: "ptaa_id",      group: "Document",                  note: "e.g. PTAA-00001 — only if the document shows a reference" },

  // --- Owner ---
  { tag: "owner_name",           group: "Owner", required: true, note: "Full name in CAPITALS, also the Beneficiary Name", alias: "OWNER_NAME" },
  { tag: "owner_nric",           group: "Owner", required: true, note: "NRIC / Registration No." },
  { tag: "owner_address",        group: "Owner", required: true, note: "Registered and mailing address" },
  { tag: "owner_phone",          group: "Owner",                 note: "Contact number" },
  { tag: "owner_email",          group: "Owner",                 note: "Email address" },
  { tag: "owner_bank_name",      group: "Owner",                 note: "Bank name in full, e.g. MALAYAN BANKING BERHAD (MAYBANK)" },
  { tag: "owner_account_number", group: "Owner",                 note: "Bank account number for rental proceeds" },

  // --- Property ---
  { tag: "property_full_address", group: "Property", required: true, note: "Unit, condo name, then the condo's address — e.g. B-38-12, SUNWAY JERNIH, Jalan …" },
  { tag: "property_unit_number", group: "Property",                 note: "e.g. B-42-13A" },
  { tag: "property_address",     group: "Property",                 note: "The condo's postal address only (no unit, no condo name)" },
  { tag: "property_size",        group: "Property",                 note: "Square feet, digits only — the template supplies the words" },
  { tag: "property_name",        group: "Property",                 note: "Condo name" },
  { tag: "ptaa_type",            group: "Property",                 note: "Partition, No Partition or WUR" },

  // --- Tenancy ---
  { tag: "initial_term_months",          group: "Tenancy", required: true, note: "In WORDS, e.g. Thirty-six" },
  { tag: "initial_term_months_numberic", group: "Tenancy", required: true, note: "In digits, e.g. 36", alias: "initial_term_months_numeric" },
  { tag: "commencement_date",            group: "Tenancy", required: true, note: "e.g. 01st October 2026" },
  { tag: "expiry_date",                  group: "Tenancy", required: true, note: "e.g. 30th September 2029" },

  // --- Fees ---
  { tag: "monthly_admin_fee",          group: "Fees", required: true, note: "The percentage in WORDS, e.g. Ten Per centum" },
  { tag: "monthly_admin_fee_numberic", group: "Fees", required: true, note: "The percentage in digits, e.g. 10", alias: "monthly_admin_fee_numeric" },
  { tag: "renovation_cost",            group: "Fees",                 note: "Amount only — put RM in the template, e.g. 43,519.00" },
  { tag: "renovation_cost_text",       group: "Fees",                 note: "With RM, or NIL when there is none — e.g. RM 43,519.00 / NIL" },

  // --- Utilities (schedule items 11, 12, 13) ---
  { tag: "utilities_owner",    group: "Utilities", note: "Item 11 — one per line, or “NIL”" },
  { tag: "utilities_advanced", group: "Utilities", note: "Item 12 — advanced by the Tenancy Administrator" },
  { tag: "utilities_tenant",   group: "Utilities", note: "Item 13 — paid by the Tenant" },

  // --- People ---
  { tag: "pic_nickname",     group: "People", note: "Owner Group Admin, e.g. Keith — set on the property" },
  { tag: "pic_mobile",       group: "People", note: "Owner Group Admin's mobile" },
  { tag: "agent_full_name",  group: "People", required: true, note: "Witnessed by — the Sales Agent" },
  { tag: "agent_nric",       group: "People", required: true, note: "Sales Agent's NRIC" },
  { tag: "agent_mobile",     group: "People", required: true, note: "Sales Agent's mobile" },
  { tag: "agent_nickname",   group: "People", note: "Short name in the persons-in-charge list" },
  { tag: "admin_full_name",  group: "People", note: "Witnessed by — the PTAA Admin who prepared it" },
  { tag: "admin_nric",       group: "People", note: "That admin's NRIC" },
  { tag: "admin_mobile",     group: "People", note: "That admin's mobile" },

  // --- Signature images ---
  { tag: "sig_director", group: "Signatures", image: true, note: "The Director's signature image" },
  { tag: "sig_agent",    group: "Signatures", image: true, note: "The Sales Agent's signature image" },
  { tag: "sig_admin",    group: "Signatures", image: true, note: "The PTAA Admin's signature image" },

  // --- Supporting images the Sales Agent uploads ---
  // These are the three things an agent attaches to a request. They go into the
  // agreement itself, which is why they are placeholders rather than working
  // material: the I/C copy onto the blank page before Appendix A, the quotation
  // into Appendix A under "Renovation Cost Details / Invoice".
  { tag: "ic_front",  group: "Attachments", image: true, note: "Owner's I/C, front — from the agent's upload" },
  { tag: "ic_back",   group: "Attachments", image: true, note: "Owner's I/C, back" },
  { tag: "quotation", group: "Attachments", image: true, note: "Renovation quotation. A multi-page PDF becomes one page each" },
];

export const REQUIRED_TAGS = FIELDS.filter(f => f.required).map(f => f.tag);
export const OPTIONAL_TAGS = FIELDS.filter(f => !f.required).map(f => f.tag);
export const IMAGE_TAGS = FIELDS.filter(f => f.image).map(f => f.tag);

/** Optional repeating block, for templates that have a special-terms section. */
export const LOOP_TAG = "special_terms";

export const KNOWN_TAGS = new Set([
  ...FIELDS.map(f => f.tag),
  ...FIELDS.filter(f => f.alias).map(f => f.alias),
  LOOP_TAG, ".",
]);

/** Grouped for the on-screen reference, in the order the schedule uses. */
export const GROUPS = ["Document", "Owner", "Property", "Tenancy", "Fees",
                       "Utilities", "People", "Signatures", "Attachments"];

export function fieldsByGroup(group) {
  return FIELDS.filter(f => f.group === group);
}

// ===========================================================================
// Parsing
// ===========================================================================

/**
 * Word routinely splits a typed placeholder across several <w:t> runs — a
 * spell-check pass or a stray formatting change is enough. Reading each <w:t>
 * alone would miss those, so the text of every run inside one paragraph is
 * joined first. A placeholder never spans a paragraph, so this is sufficient.
 */
export function paragraphTexts(xml) {
  const out = [];
  const paras = String(xml || "").split(/<w:p[ >]/);
  for (const chunk of paras) {
    let text = "";
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(chunk)) !== null) text += m[1];
    if (text) out.push(decodeXml(text));
  }
  return out;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const TAG_RE = /\{\{\s*([#/^@]?)\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function extractTags(xmlParts) {
  const tags = new Set(), loops = new Set(), closes = new Set(), raw = [];
  for (const xml of xmlParts) {
    for (const line of paragraphTexts(xml)) {
      let m;
      TAG_RE.lastIndex = 0;
      while ((m = TAG_RE.exec(line)) !== null) {
        const [full, marker, name] = m;
        raw.push(full);
        if (marker === "#" || marker === "^") loops.add(name);
        else if (marker === "/") closes.add(name);
        else tags.add(name);
      }
    }
  }
  return { tags, loops, closes, raw };
}

/** Check a parsed template. Returns everything needed to fix it, named exactly. */
export function validateTemplate(xmlParts) {
  const { tags, loops, closes } = extractTags(xmlParts);

  const has = (tag) => {
    const f = FIELDS.find(x => x.tag === tag);
    return tags.has(tag) || (f && f.alias && tags.has(f.alias));
  };

  const missing = REQUIRED_TAGS.filter(t => !has(t));
  const notUsed = OPTIONAL_TAGS.filter(t => !has(t));

  const problems = [];
  // The special-terms block is optional, but a half-written one is a mistake.
  if (loops.has(LOOP_TAG) && !closes.has(LOOP_TAG)) {
    problems.push(`{{#${LOOP_TAG}}} is opened but never closed. Add a paragraph containing {{/${LOOP_TAG}}}.`);
  } else if (loops.has(LOOP_TAG) && !tags.has(".")) {
    problems.push(`The special terms block has no {{.}} inside it, so nothing would print for each term.`);
  }
  for (const name of closes) {
    if (!loops.has(name)) problems.push(`{{/${name}}} closes a block that was never opened.`);
  }
  for (const name of loops) {
    if (name !== LOOP_TAG && !closes.has(name)) problems.push(`{{#${name}}} is opened but never closed. Add a paragraph containing {{/${name}}}.`);
  }

  const unknown = [...tags].filter(t => !KNOWN_TAGS.has(t));

  return {
    ok: missing.length === 0 && problems.length === 0,
    missing, problems, unknown, notUsed,
    found: [...tags].sort(),
    loops: [...loops].sort(),
    images: IMAGE_TAGS.filter(t => tags.has(t)),
  };
}

export function describeFailure(result) {
  const lines = [];
  if (result.missing.length) {
    lines.push(`${result.missing.length} required placeholder${result.missing.length === 1 ? " is" : "s are"} missing:`);
    for (const g of GROUPS) {
      const gone = fieldsByGroup(g).filter(f => result.missing.includes(f.tag));
      if (gone.length) lines.push(`  ${g}: ${gone.map(f => `{{${f.tag}}}`).join(", ")}`);
    }
  }
  for (const p of result.problems) lines.push(p);
  return lines.join("\n");
}

// ===========================================================================
// Filling
// ===========================================================================

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];

/** "2026-10-01" → "01st October 2026", the form the agreements use. */
export function formatLongDate(value) {
  const d = toDate(value);
  if (!d) return typeof value === "string" ? value : "";
  return `${ordinalDay(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2026-08-21" → "21ST DAY OF AUGUST 2026", for the “DATED THIS” line. */
export function formatLongDateUpper(value) {
  const d = toDate(value);
  if (!d) return "";
  return `${ordinalDay(d.getDate()).toUpperCase()} DAY OF ${MONTHS[d.getMonth()].toUpperCase()} ${d.getFullYear()}`;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function formatAmount(n) {
  if (n === null || n === undefined || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return num.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Digits with thousands separators and no decimals — for square feet. */
export function formatCount(n) {
  if (n === null || n === undefined || n === "") return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return String(Math.round(num));   // "1151", not "1,151" — the agreement writes it plain
}

/**
 * Build the value for every placeholder from a request record.
 * Mapping is by name only.
 *
 * @param {object} request
 * @param {object} opts
 *   - generatedDate   the date on the document (defaults to today)
 *   - property        the property record, for pic_nickname / pic_mobile
 *   - signatureMarker (tag) => string, so images can be substituted later
 */
export function buildTemplateData(request, opts = {}) {
  const { generatedDate = new Date(), property = null, signatureMarker = null } = opts;
  const o = request.owner || {};
  const t = request.tenancy || {};
  const f = request.financial || {};
  const a = request.agentSnapshot || {};
  const ad = request.adminSnapshot || {};
  const u = request.utilities || {};

  const data = {
    // --- Document ---
    today_date:       formatLongDate(generatedDate),
    today_date_upper: formatLongDateUpper(generatedDate),
    ptaa_id:          request.ptaaId || "",

    // --- Owner ---
    // Always in capitals, however it was typed.
    owner_name:           String(o.name || "").toUpperCase(),
    owner_nric:           o.nric || "",
    owner_address:        o.address || "",
    owner_phone:          o.phone || "",
    owner_email:          o.email || "",
    owner_bank_name:      o.bankName || "",
    owner_account_number: o.accountNumber || "",

    // --- Property ---
    property_full_address: fullAddress(request),
    property_unit_number: request.unitNo || "",
    property_address:     request.propertyAddress || "",
    property_size:        formatCount(request.propertySize),
    property_name:        request.propertyName || "",
    ptaa_type:            request.ptaaType || "",
    // {{#is_partition}} … {{/is_partition}} around Appendix B: printed for a
    // Partition only. Blank for No Partition and WUR.
    is_partition:         request.ptaaType === "Partition",

    // --- Tenancy: words first, digits second, as the agreement writes them ---
    initial_term_months:          t.initialTermMonths != null ? numberInWords(t.initialTermMonths) : "",
    initial_term_months_numberic: t.initialTermMonths != null ? String(t.initialTermMonths) : "",
    commencement_date:            formatLongDate(t.commencementDate),
    expiry_date:                  formatLongDate(t.expiryDate),

    // --- Fees: a PERCENTAGE of gross monthly rental, not a Ringgit amount ---
    monthly_admin_fee:          f.monthlyAdminFeePercent != null ? percentInWords(f.monthlyAdminFeePercent) : "",
    monthly_admin_fee_numberic: f.monthlyAdminFeePercent != null ? String(f.monthlyAdminFeePercent) : "",
    renovation_cost:            formatAmount(f.renovationCost),
    // "RM 43,519.00", or NIL when no renovation cost was given.
    renovation_cost_text:       formatAmount(f.renovationCost) ? `RM ${formatAmount(f.renovationCost)}` : "NIL",

    // --- Utilities (schedule items 11, 12, 13) ---
    utilities_owner:    utilityLines(u, "owner"),
    utilities_advanced: utilityLines(u, "advanced"),
    utilities_tenant:   utilityLines(u, "tenant"),

    // --- People ---
    pic_nickname:    (property && property.picNickname) || request.picNickname || "",
    pic_mobile:      (property && property.picMobile) || request.picMobile || "",
    agent_full_name: a.fullName || "",
    agent_nric:      a.nric || "",
    agent_mobile:    a.phone || "",
    agent_nickname:  a.nickname || "",
    admin_full_name: ad.fullName || "",
    admin_nric:      ad.nric || "",
    admin_mobile:    ad.phone || "",

    special_terms: Array.isArray(request.specialTerms) ? request.specialTerms.filter(Boolean) : [],
  };

  // The misspelling is in the real template, so it is the primary name. The
  // correct spelling is filled too, so either works.
  for (const field of FIELDS) {
    if (field.alias) data[field.alias] = data[field.tag];
  }

  // Signature images are substituted after rendering — the value here is just a
  // unique marker the post-processing step finds. See docximage.js.
  for (const tag of IMAGE_TAGS) {
    data[tag] = signatureMarker ? signatureMarker(tag) : "";
  }

  return data;
}

/**
 * "B-38-12, SUNWAY JERNIH, Jalan …, 58200 Kuala Lumpur" — the unit, the condo,
 * then the condo's address. A part already present (an address that starts
 * with the condo's name, say) is not repeated.
 */
export function fullAddress(request) {
  const r = request || {};
  const tidy = (v) => String(v || "").replace(/\s*\n\s*/g, ", ").replace(/(,\s*)+/g, ", ")
    .replace(/\s+/g, " ").replace(/^[\s,]+|[\s,]+$/g, "");
  const unit = tidy(r.unitNo), name = tidy(r.propertyName);
  let addr = tidy(r.propertyAddress);
  // Drop a copy of the unit or the condo name typed at the start of the address.
  for (const lead of [unit, name]) {
    if (lead && addr.toUpperCase().startsWith(lead.toUpperCase())) addr = addr.slice(lead.length).replace(/^[\s,]+/, "");
  }
  return [unit, name, addr].filter(Boolean).join(", ");
}

// --- Utilities --------------------------------------------------------------

/**
 * Utilities move between three parties per PTAA — some owners pay, some pass it
 * to the tenant, some take a package where the company advances it. Whatever is
 * assigned to one party is listed on its own line in that schedule row.
 */
export function utilityLines(utilities, party) {
  const items = Object.entries(utilities || {})
    .filter(([, v]) => (v && v.party) === party)
    .map(([, v]) => v.label)
    .filter(Boolean);
  // The office's agreements print NIL on a row nobody pays under.
  return items.length ? items.join("\n") : "NIL";
}

/** Fields that are empty but shouldn't be — surfaced before generating. */
export function emptyRequiredValues(data) {
  return REQUIRED_TAGS.filter(t => !String(data[t] ?? "").trim());
}
