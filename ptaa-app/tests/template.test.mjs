// ---------------------------------------------------------------------------
// Tests for js/placeholders.js — the template check from brief §5.2/§5.3 and
// the by-name field mapping from §5.1.
//
// Run:  node --test tests/template.test.mjs
//
// The last group round-trips a real .docx through docxtemplater and is skipped
// automatically if the optional dev dependencies are not installed:
//   npm install pizzip docxtemplater
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_TAGS, IMAGE_TAGS, GROUPS, fieldsByGroup, LOOP_TAG, DELIMITERS,
  paragraphTexts, extractTags, validateTemplate, describeFailure,
  buildTemplateData, formatLongDate, formatLongDateUpper, formatAmount,
  formatCount, utilityLines, emptyRequiredValues,
} from "../js/placeholders.js";
import { numberInWords, percentInWords, ordinalDay } from "../js/numberwords.js";

// --- Helpers to build fragments of Word XML --------------------------------

const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...runs) => `<w:p>${runs.map(run).join("")}</w:p>`;

/** A template with everything the brief requires. */
function goodTemplateXml() {
  return "<w:document><w:body>" +
    REQUIRED_TAGS.map(t => para(`Label: {{${t}}}`)).join("") +
    para(`{{#${LOOP_TAG}}}`) + para("- {{.}}") + para(`{{/${LOOP_TAG}}}`) +
    "</w:body></w:document>";
}

// --- Parsing ----------------------------------------------------------------

test("the required set is the one the real D TERRA template uses", () => {
  // Derived from Irfan's own TEMPLATE_D TERRA.docx, not from the brief's
  // illustrative list — the template is the authority on what a PTAA needs.
  assert.deepEqual(REQUIRED_TAGS, [
    "today_date",
    "owner_name", "owner_nric", "owner_address",
    "property_full_address",
    "initial_term_months", "initial_term_months_numberic",
    "commencement_date", "expiry_date",
    "monthly_admin_fee", "monthly_admin_fee_numberic",
    "agent_full_name", "agent_nric", "agent_mobile",
  ]);
  assert.deepEqual(DELIMITERS, { start: "{{", end: "}}" });
});

test("every field belongs to a group the reference screen renders", () => {
  const covered = new Set(GROUPS.flatMap(g => fieldsByGroup(g).map(f => f.tag)));
  for (const t of REQUIRED_TAGS) assert.ok(covered.has(t), `{{${t}}} is in no group`);
  for (const t of IMAGE_TAGS)    assert.ok(covered.has(t), `{{${t}}} is in no group`);
});

test("the misspelled tags in the real template are the primary names", () => {
  // The template says "numberic". Renaming it would mean editing every condo's
  // template, so the misspelling is what the code targets — with the correct
  // spelling filled as well, so either works.
  assert.ok(REQUIRED_TAGS.includes("initial_term_months_numberic"));
  assert.ok(REQUIRED_TAGS.includes("monthly_admin_fee_numberic"));
});

test("runs inside one paragraph are joined before looking for placeholders", () => {
  // Word splits a typed placeholder like this all the time — a spell-check pass
  // is enough. Reading each <w:t> alone would miss it.
  const xml = "<w:document><w:body><w:p>" +
    run("Name: {{ow") + run("ner_") + run("name}}") +
    "</w:p></w:body></w:document>";
  assert.deepEqual(paragraphTexts(xml), ["Name: {{owner_name}}"]);
  const { tags } = extractTags([xml]);
  assert.ok(tags.has("owner_name"), "the split placeholder is still found");
});

test("a placeholder split across runs still validates", () => {
  const xml = "<w:document><w:body>" +
    REQUIRED_TAGS.map(t => `<w:p>${run("{{")}${run(t)}${run("}}")}</w:p>`).join("") +
    para(`{{#${LOOP_TAG}}}`) + para("{{.}}") + para(`{{/${LOOP_TAG}}}`) +
    "</w:body></w:document>";
  assert.equal(validateTemplate([xml]).ok, true);
});

test("placeholders in headers and footers count too", () => {
  const body = "<w:document><w:body>" +
    REQUIRED_TAGS.filter(t => t !== "today_date").map(t => para(`{{${t}}}`)).join("") +
    para(`{{#${LOOP_TAG}}}`) + para("{{.}}") + para(`{{/${LOOP_TAG}}}`) +
    "</w:body></w:document>";
  const header = `<w:hdr>${para("Dated {{today_date}}")}</w:hdr>`;
  assert.equal(validateTemplate([body]).ok, false, "missing from the body alone");
  assert.equal(validateTemplate([body, header]).ok, true, "found in the header");
});

test("XML entities in the text are decoded", () => {
  const xml = `<w:document><w:body>${para("Fee &amp; charges: {{monthly_admin_fee}}")}</w:body></w:document>`;
  assert.deepEqual(paragraphTexts(xml), ["Fee & charges: {{monthly_admin_fee}}"]);
});

test("spaces inside the braces are tolerated", () => {
  const { tags } = extractTags([`<w:p>${run("{{ owner_name }}")}</w:p>`]);
  assert.ok(tags.has("owner_name"));
});

// --- Validation (brief §5.3) ------------------------------------------------

test("a complete template is accepted", () => {
  const r = validateTemplate([goodTemplateXml()]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.unknown, []);
});

test("a missing placeholder is refused and named", () => {
  const xml = goodTemplateXml().replace("{{owner_nric}}", "880214-10-5566");
  const r = validateTemplate([xml]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["owner_nric"]);
  assert.match(describeFailure(r), /Owner: \{\{owner_nric\}\}/);
});

test("several missing placeholders are grouped the way the reference groups them", () => {
  let xml = goodTemplateXml();
  for (const t of ["agent_nric", "agent_mobile", "property_full_address"]) {
    xml = xml.replace(`{{${t}}}`, "SAMPLE");
  }
  const r = validateTemplate([xml]);
  assert.deepEqual(r.missing.sort(), ["agent_mobile", "agent_nric", "property_full_address"]);
  const text = describeFailure(r);
  assert.match(text, /3 required placeholders are missing/);
  assert.match(text, /People: /);
  assert.match(text, /Property: \{\{property_full_address\}\}/);
});

test("a template with no special-terms block is fine — his real one has none", () => {
  const xml = "<w:document><w:body>" +
    REQUIRED_TAGS.map(t => para(`{{${t}}}`)).join("") + "</w:body></w:document>";
  const r = validateTemplate([xml]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.problems, []);
});

test("an unclosed special-terms block is refused", () => {
  const xml = "<w:document><w:body>" +
    REQUIRED_TAGS.map(t => para(`{{${t}}}`)).join("") +
    para(`{{#${LOOP_TAG}}}`) + para("{{.}}") + "</w:body></w:document>";
  const r = validateTemplate([xml]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /opened but never closed/);
});

test("a special-terms block with nothing inside it is refused", () => {
  const xml = "<w:document><w:body>" +
    REQUIRED_TAGS.map(t => para(`{{${t}}}`)).join("") +
    para(`{{#${LOOP_TAG}}}`) + para(`{{/${LOOP_TAG}}}`) + "</w:body></w:document>";
  const r = validateTemplate([xml]);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /no \{\{\.\}\} inside it/);
});

test("an unrecognised placeholder is a warning, not a rejection", () => {
  const xml = goodTemplateXml().replace("</w:body>", para("{{witness_name}}") + "</w:body>");
  const r = validateTemplate([xml]);
  assert.equal(r.ok, true, "it still uploads");
  assert.deepEqual(r.unknown, ["witness_name"]);
});

test("a template with no placeholders at all is refused, not silently accepted", () => {
  const r = validateTemplate(["<w:document><w:body>" + para("Just prose.") + "</w:body></w:document>"]);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, REQUIRED_TAGS.length);
});

// --- Field mapping (brief §5.1) --------------------------------------------

const REQUEST = {
  ptaaId: "PTAA-00042",
  owner: { name: "LOY HUI TING", nric: "880214-10-5566", address: "12 Jalan Ampang, KL",
           phone: "012-345 6789", email: "loy@example.com",
           bankName: "MALAYAN BANKING BERHAD (MAYBANK)", accountNumber: "512345678901" },
  propertyName: "M ASTRA", unitNo: "A-18-09", propertyAddress: "Jalan Ampang, KL",
  propertySize: 1151, ptaaType: "Partition",
  tenancy: { initialTermMonths: 36, commencementDate: "2026-09-01", expiryDate: "2029-08-31" },
  financial: { monthlyAdminFeePercent: 10, renovationCost: 12000 },
  utilities: {
    electricity: { label: "Electricity", party: "advanced", standard: true },
    water:       { label: "Water",       party: "advanced", standard: true },
    internet:    { label: "Wi-Fi / Internet", party: "advanced", standard: true },
    cleaning:    { label: "Cleaning Services", party: "tenant", standard: true },
    aircond:     { label: "AC Usage via Smart Meter", party: "owner", standard: true },
  },
  specialTerms: ["Owner keeps the built-in wardrobe.", "", "Aircon serviced quarterly."],
  agentSnapshot: { fullName: "CHAN SIEW SIN", nric: "000908-14-0426",
                   phone: "019-400 9082", nickname: "Suzanne", profileVersion: 2 },
  adminSnapshot: { fullName: "NUR AFIQAH", nric: "950101-10-1234",
                   phone: "011-2233 4455", nickname: "Fiqah", profileVersion: 1 },
};

test("every required placeholder gets a value from the request", () => {
  const d = buildTemplateData(REQUEST, { generatedDate: new Date(2026, 7, 28) });
  for (const t of REQUIRED_TAGS) {
    assert.ok(t in d, `no value produced for {{${t}}}`);
  }
  assert.equal(d.owner_name, "LOY HUI TING");
  assert.equal(d.property_name, "M ASTRA");
  assert.equal(d.property_unit_number, "A-18-09");
  assert.equal(d.ptaa_type, "Partition");
  assert.equal(d.ptaa_id, "PTAA-00042");
  assert.equal(d.owner_bank_name, "MALAYAN BANKING BERHAD (MAYBANK)");
  assert.equal(d.owner_account_number, "512345678901");
  assert.equal(d.property_size, "1151", "plain digits — the agreement writes it that way");
});

test("the admin who generated it fills the second witness block", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.admin_full_name, "NUR AFIQAH");
  assert.equal(d.admin_nric, "950101-10-1234");
  assert.equal(d.admin_mobile, "011-2233 4455");

  // No admin recorded yet: blank, never the agent's details by accident.
  const nobody = buildTemplateData({ ...REQUEST, adminSnapshot: null });
  assert.equal(nobody.admin_full_name, "");
});

test("the Owner Group Admin comes from the property, not the request", () => {
  const property = { picNickname: "Keith", picMobile: "012-999 8888" };
  const d = buildTemplateData(REQUEST, { property });
  assert.equal(d.pic_nickname, "Keith");
  assert.equal(d.pic_mobile, "012-999 8888");
  assert.equal(buildTemplateData(REQUEST).pic_nickname, "", "blank when no property is passed");
});

test("agent fields come from the snapshot, not from the profile as it stands now", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.agent_full_name, "CHAN SIEW SIN");
  assert.equal(d.agent_nric, "000908-14-0426");
  assert.equal(d.agent_mobile, "019-400 9082");
  assert.equal(d.agent_nickname, "Suzanne");

  // The same request, if the agent later renames themselves, is unchanged:
  // buildTemplateData reads agentSnapshot and nothing else.
  const renamed = { ...REQUEST, agentSnapshot: { ...REQUEST.agentSnapshot, fullName: "SOMEONE ELSE" } };
  assert.equal(buildTemplateData(REQUEST).agent_full_name, "CHAN SIEW SIN");
  assert.equal(buildTemplateData(renamed).agent_full_name, "SOMEONE ELSE");
});

test("dates carry the ordinal day the agreements use", () => {
  const d = buildTemplateData(REQUEST, { generatedDate: new Date(2026, 7, 21) });
  assert.equal(d.commencement_date, "01st September 2026");
  assert.equal(d.expiry_date, "31st August 2029");
  assert.equal(d.today_date, "21st August 2026");
  assert.equal(d.today_date_upper, "21ST DAY OF AUGUST 2026");
  assert.equal(formatLongDate(""), "");
  assert.equal(formatLongDate("not a date"), "not a date");
  assert.equal(formatLongDateUpper(""), "");
  assert.equal(ordinalDay(1), "01st");
  assert.equal(ordinalDay(22), "22nd");
  assert.equal(ordinalDay(30), "30th");
});

test("the term appears as words and as digits, in that order", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.initial_term_months, "Thirty-six");
  assert.equal(d.initial_term_months_numberic, "36");
  assert.equal(d.initial_term_months_numeric, "36", "the correctly-spelled alias is filled too");
  assert.equal(numberInWords(1), "One");
  assert.equal(numberInWords(120), "One hundred and twenty");
});

test("the admin fee is a percentage of the rent, not a Ringgit amount", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.monthly_admin_fee, "Ten Per centum");
  assert.equal(d.monthly_admin_fee_numberic, "10");
  assert.equal(d.monthly_admin_fee_numeric, "10");
  assert.equal(percentInWords(12.5), "Twelve point five Per centum");
});

test("amounts carry two decimals and no currency symbol", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.renovation_cost, "12,000.00");
  assert.equal(formatAmount(null), "", "an empty amount stays empty, not 0.00");
  assert.equal(formatCount(1151), "1151");
  assert.equal(formatCount(""), "");
});

// --- Utilities (his third question) -----------------------------------------

test("utilities are split across the three schedule rows, one item per line", () => {
  const d = buildTemplateData(REQUEST);
  assert.equal(d.utilities_advanced, "Electricity\nWater\nWi-Fi / Internet");
  assert.equal(d.utilities_tenant, "Cleaning Services");
  assert.equal(d.utilities_owner, "AC Usage via Smart Meter");
});

test("a row with nothing in it reads “None”, never blank", () => {
  const d = buildTemplateData({ ...REQUEST, utilities: {} });
  assert.equal(d.utilities_owner, "NIL");
  assert.equal(d.utilities_advanced, "NIL");
  assert.equal(d.utilities_tenant, "NIL");
  assert.equal(utilityLines(null, "owner"), "NIL");
});

test("a utility marked not applicable appears on no row at all", () => {
  const d = buildTemplateData({ ...REQUEST, utilities: {
    electricity: { label: "Electricity", party: "owner" },
    aircond:     { label: "AC Usage via Smart Meter", party: "none" },
  }});
  assert.equal(d.utilities_owner, "Electricity");
  assert.ok(!d.utilities_tenant.includes("AC Usage"));
  assert.ok(!d.utilities_advanced.includes("AC Usage"));
});

// --- Signature images -------------------------------------------------------

test("signature tags carry a marker, not a value, so images can replace them", () => {
  const marker = (tag) => `[[ANCHORSIG:${tag}]]`;
  const d = buildTemplateData(REQUEST, { signatureMarker: marker });
  for (const t of IMAGE_TAGS) assert.equal(d[t], `[[ANCHORSIG:${t}]]`);

  // With no marker function they fill as empty, so a template that has them and
  // a caller that supplies no image still produces a clean document.
  const plain = buildTemplateData(REQUEST);
  for (const t of IMAGE_TAGS) assert.equal(plain[t], "");
});

test("blank special terms are dropped before they reach the document", () => {
  const d = buildTemplateData(REQUEST);
  assert.deepEqual(d.special_terms, ["Owner keeps the built-in wardrobe.", "Aircon serviced quarterly."]);
});

test("a request with no special terms produces an empty block, not an error", () => {
  const d = buildTemplateData({ ...REQUEST, specialTerms: [] });
  assert.deepEqual(d.special_terms, []);
});

test("empty values that matter are reported, optional ones are not", () => {
  const full = buildTemplateData(REQUEST);
  assert.deepEqual(emptyRequiredValues(full), []);

  const noEmail = buildTemplateData({ ...REQUEST, owner: { ...REQUEST.owner, email: "" } });
  assert.deepEqual(emptyRequiredValues(noEmail), [], "owner email is optional");

  const noBank = buildTemplateData({ ...REQUEST, owner: { ...REQUEST.owner, bankName: "" } });
  assert.deepEqual(emptyRequiredValues(noBank), [], "not every condo's template has a bank row");

  const noAddress = buildTemplateData({ ...REQUEST, owner: { ...REQUEST.owner, address: "" } });
  assert.deepEqual(emptyRequiredValues(noAddress), ["owner_address"]);
});

// --- Round trip through a real .docx ---------------------------------------

let PizZip = null, Docxtemplater = null;
try {
  ({ default: PizZip } = await import("pizzip"));
  ({ default: Docxtemplater } = await import("docxtemplater"));
} catch { /* optional dev dependency */ }

/** The smallest zip docxtemplater will accept as a Word document. */
function minimalDocx(documentXml) {
  const zip = new PizZip();
  zip.file("[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder("_rels").file(".rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder("word").file("document.xml", documentXml);
  return zip.generate({ type: "nodebuffer" });
}

test("a real .docx is filled by name, keeps its formatting, and repeats the terms",
  { skip: PizZip ? false : "run `npm install pizzip docxtemplater` to enable" }, () => {

  const DOC = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">WITNESSED BY</w:t></w:r></w:p>
  ${para("Full Name: {{agent_full_name}}")}
  ${para("NRIC: {{agent_nric}}")}
  ${para("Mobile: {{agent_mobile}}")}
  ${para("(2) {{agent_nickname}} (Sales Agent) - {{agent_mobile}}")}
  <w:tbl><w:tr><w:tc>${para("Unit")}</w:tc><w:tc>${para("{{property_unit_number}}")}</w:tc></w:tr></w:tbl>
  ${para("Owner: {{owner_name}} ({{owner_nric}})")}
  ${para("Term: {{initial_term_months}} ({{initial_term_months_numberic}}) months from {{commencement_date}} to {{expiry_date}}")}
  ${para("Fee: {{monthly_admin_fee}} ({{monthly_admin_fee_numberic}} %)")}
  ${para("11. {{utilities_owner}}")}
  ${para(`{{#${LOOP_TAG}}}`)}${para("- {{.}}")}${para(`{{/${LOOP_TAG}}}`)}
</w:body></w:document>`;

  const doc = new Docxtemplater(new PizZip(minimalDocx(DOC)), {
    paragraphLoop: true, linebreaks: true, delimiters: DELIMITERS, nullGetter: () => "",
  });
  doc.render(buildTemplateData(REQUEST, { generatedDate: new Date(2026, 7, 28) }));

  const out = doc.getZip().generate({ type: "nodebuffer" });
  const xml = new PizZip(out).file("word/document.xml").asText();

  assert.ok(xml.includes("CHAN SIEW SIN"), "agent name filled");
  assert.ok(xml.includes("000908-14-0426"), "agent NRIC filled");
  assert.ok(/\(2\) Suzanne \(Sales Agent\) - 019-400 9082/.test(xml),
    "the Tenancy Administrator contact line reads exactly as brief §5.2 specifies");
  assert.ok(xml.includes("LOY HUI TING"), "owner filled");
  assert.ok(xml.includes("A-18-09"), "unit filled inside the table");
  assert.ok(xml.includes("Thirty-six (36) months from 01st September 2026 to 31st August 2029"),
    "tenancy sentence reads as words then digits, the way the agreement writes it");
  assert.ok(xml.includes("Ten Per centum (10 %)"), "the fee is a percentage, in words then digits");

  assert.equal((xml.match(/wardrobe|quarterly/g) || []).length, 2,
    "the repeating block ran once per special term");
  assert.ok(!xml.includes("{{"), "no placeholder was left behind");
  assert.ok(xml.includes("<w:tbl>"), "the table survived");
  assert.ok(xml.includes("<w:b/>"), "bold formatting survived");
});

test("a template that repeats a placeholder fills every occurrence",
  { skip: PizZip ? false : "optional dependency" }, () => {
  const DOC = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    para("{{agent_mobile}}") + para("{{agent_mobile}}") + para("{{agent_mobile}}") +
    `</w:body></w:document>`;
  const doc = new Docxtemplater(new PizZip(minimalDocx(DOC)), {
    paragraphLoop: true, delimiters: DELIMITERS, nullGetter: () => "",
  });
  doc.render(buildTemplateData(REQUEST));
  const xml = new PizZip(doc.getZip().generate({ type: "nodebuffer" })).file("word/document.xml").asText();
  assert.equal((xml.match(/019-400 9082/g) || []).length, 3);
});

test("the full address is unit, condo, then the condo's address", async () => {
  const { fullAddress } = await import("../js/placeholders.js");
  const r = { unitNo: "B-38-12", propertyName: "SUNWAY JERNIH",
              propertyAddress: "Jalan Jernih 1, Taman Jernih,\n58200 Kuala Lumpur" };
  assert.equal(fullAddress(r), "B-38-12, SUNWAY JERNIH, Jalan Jernih 1, Taman Jernih, 58200 Kuala Lumpur");
  assert.equal(fullAddress({ ...r, propertyAddress: "Sunway Jernih, Jalan Jernih 1" }), "B-38-12, SUNWAY JERNIH, Jalan Jernih 1");
  assert.equal(fullAddress({ ...r, propertyAddress: "" }), "B-38-12, SUNWAY JERNIH");
  assert.equal(buildTemplateData(r).property_full_address, fullAddress(r));
});

