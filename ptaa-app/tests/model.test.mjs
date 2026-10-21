// ---------------------------------------------------------------------------
// Tests for js/model.js — the state machine (brief §7), the generated filename
// (§11.3), tenancy dates, and request validation (§9.1).
//
// Run:  node --test tests/model.test.mjs
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS, ACTOR, TRANSITIONS, allowedTransitions, isTransitionAllowed,
  defaultCurrentAction, OPEN_STATUSES, CLOSED_STATUSES,
  formatPtaaId, ptaaFilename, computeExpiry, toDateInput, parseDateInput,
  parseMoney, fmtMoney, isOverdue, isDueToday,
  validateRequestDraft, PTAA_TYPES,
  SIGNATORY_TYPES, SIGNATORY_STATUS, signatureSummary, signatureCurrentAction,
  CHECKLIST, checklistProgress, checklistBlockers,
  UTILITY_PARTY, UTILITY_PRESETS, STANDARD_UTILITIES, PRESET_UTILITIES,
  defaultUtilities, applyUtilityPreset, utilitiesByParty, fmtPercent, tenancyMissing,
} from "../js/model.js";

// --- The transition table (brief §7.2) --------------------------------------

test("the moves the brief lists are allowed, for the right role", () => {
  assert.equal(isTransitionAllowed(STATUS.NEW, STATUS.UNDER_REVIEW, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.UNDER_REVIEW, STATUS.CHANGES_REQUIRED, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.CHANGES_REQUIRED, STATUS.UNDER_REVIEW, "agent"), true);
  assert.equal(isTransitionAllowed(STATUS.UNDER_REVIEW, STATUS.PTAA_OK, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.PTAA_OK, STATUS.READY_FOR_AGENT, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.WAITING_FOR_SIGNATURE, "agent"), true);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.WAITING_FOR_SIGNATURE, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.WAITING_FOR_SIGNATURE, STATUS.FINAL_CHECK, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.FINAL_CHECK, "admin"), true);
});

test("an agent cannot make an admin's moves", () => {
  assert.equal(isTransitionAllowed(STATUS.NEW, STATUS.UNDER_REVIEW, "agent"), false);
  assert.equal(isTransitionAllowed(STATUS.UNDER_REVIEW, STATUS.PTAA_OK, "agent"), false);
  assert.equal(isTransitionAllowed(STATUS.PTAA_OK, STATUS.READY_FOR_AGENT, "agent"), false);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.FINAL_CHECK, "agent"), false);
});

test("PTAA OK, Ready for agent and Completed are three separate states (rule #5)", () => {
  assert.equal(isTransitionAllowed(STATUS.UNDER_REVIEW, STATUS.READY_FOR_AGENT, "admin"), false,
    "must not jump review straight to released");
  assert.equal(isTransitionAllowed(STATUS.PTAA_OK, STATUS.COMPLETED, "admin"), false);
});

test("nothing can reach COMPLETED yet — rule #6, no checklist and no Drive upload", () => {
  for (const from of OPEN_STATUSES) {
    for (const role of ["admin", "agent"]) {
      assert.equal(isTransitionAllowed(from, STATUS.COMPLETED, role), false,
        `${from} → COMPLETED must be refused (${role})`);
    }
  }
});

test("skipping steps is refused", () => {
  assert.equal(isTransitionAllowed(STATUS.NEW, STATUS.PTAA_OK, "admin"), false);
  assert.equal(isTransitionAllowed(STATUS.NEW, STATUS.FINAL_CHECK, "admin"), false);
  assert.equal(isTransitionAllowed(STATUS.CHANGES_REQUIRED, STATUS.PTAA_OK, "admin"), false);
  assert.equal(isTransitionAllowed(STATUS.FINAL_CHECK, STATUS.NEW, "admin"), false);
});

test("a status cannot transition to itself", () => {
  for (const s of OPEN_STATUSES) {
    assert.equal(isTransitionAllowed(s, s, "admin"), false);
  }
});

test("hold and cancel are admin-only and reach every open status", () => {
  for (const from of OPEN_STATUSES.filter(s => s !== STATUS.ON_HOLD)) {
    assert.equal(isTransitionAllowed(from, STATUS.ON_HOLD, "admin"), true, from);
    assert.equal(isTransitionAllowed(from, STATUS.ON_HOLD, "agent"), false, from);
    assert.equal(isTransitionAllowed(from, STATUS.CANCELLED, "admin"), true, from);
    assert.equal(isTransitionAllowed(from, STATUS.CANCELLED, "agent"), false, from);
  }
});

test("a closed request cannot be reopened, cancelled again or held", () => {
  for (const from of CLOSED_STATUSES) {
    assert.equal(isTransitionAllowed(from, STATUS.ON_HOLD, "admin"), false);
    assert.equal(isTransitionAllowed(from, STATUS.CANCELLED, "admin"), false);
    assert.equal(isTransitionAllowed(from, STATUS.UNDER_REVIEW, "admin"), false);
  }
});

test("a held request resumes to any open status but not to hold again", () => {
  assert.equal(isTransitionAllowed(STATUS.ON_HOLD, STATUS.UNDER_REVIEW, "admin"), true);
  assert.equal(isTransitionAllowed(STATUS.ON_HOLD, STATUS.ON_HOLD, "admin"), false);
  assert.equal(isTransitionAllowed(STATUS.ON_HOLD, STATUS.COMPLETED, "admin"), false);
});

test("the Owner change request is the agent's own move (brief §9.3)", () => {
  const t = TRANSITIONS.find(x => x.from === STATUS.READY_FOR_AGENT
                               && x.to === STATUS.UNDER_REVIEW && x.who === "agent");
  assert.ok(t, "the transition exists");
  assert.ok(!t.notYet, "and is no longer deferred");
  assert.equal(t.needsNote, true, "a description of what the Owner wants is required");
  assert.equal(t.changeRequest, true);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.UNDER_REVIEW, "agent"), true);
  assert.equal(isTransitionAllowed(STATUS.READY_FOR_AGENT, STATUS.UNDER_REVIEW, "admin"), false,
    "an admin edits directly rather than raising a change request");
});

test("allowedTransitions offers Resume only from hold, and hold/cancel only when open", () => {
  const held = allowedTransitions(STATUS.ON_HOLD, "admin").map(t => t.to);
  assert.ok(held.includes("__resume__"));
  assert.ok(!held.includes(STATUS.ON_HOLD));

  const done = allowedTransitions(STATUS.COMPLETED, "admin").map(t => t.to);
  assert.deepEqual(done, [], "a completed request offers no actions");

  const review = allowedTransitions(STATUS.UNDER_REVIEW, "admin").map(t => t.to);
  assert.ok(review.includes(STATUS.ON_HOLD) && review.includes(STATUS.CANCELLED));
});

test("an agent is offered nothing on a request that is with the admin", () => {
  assert.deepEqual(allowedTransitions(STATUS.NEW, "agent"), []);
  assert.deepEqual(allowedTransitions(STATUS.UNDER_REVIEW, "agent"), []);
  assert.deepEqual(allowedTransitions(STATUS.PTAA_OK, "agent"), []);
});

test("an agent holding a released PTAA can request changes or send for signature", () => {
  const offered = allowedTransitions(STATUS.READY_FOR_AGENT, "agent").map(t => t.to);
  assert.deepEqual(offered.sort(), [STATUS.UNDER_REVIEW, STATUS.WAITING_FOR_SIGNATURE].sort());
});

// --- Current Action (brief §7.4) --------------------------------------------

test("who has the ball follows the status", () => {
  assert.equal(defaultCurrentAction(STATUS.NEW), ACTOR.ADMIN);
  assert.equal(defaultCurrentAction(STATUS.CHANGES_REQUIRED), ACTOR.AGENT);
  assert.equal(defaultCurrentAction(STATUS.READY_FOR_AGENT), ACTOR.AGENT);
  assert.equal(defaultCurrentAction(STATUS.WAITING_FOR_SIGNATURE), ACTOR.DIRECTOR);
  assert.equal(defaultCurrentAction(STATUS.ON_HOLD), ACTOR.NONE);
  assert.equal(defaultCurrentAction(STATUS.COMPLETED), ACTOR.NONE);
});

// --- Identifier and filename (brief §11.3) ----------------------------------

test("PTAA identifiers are zero-padded and sort correctly as text", () => {
  assert.equal(formatPtaaId(1), "PTAA-00001");
  assert.equal(formatPtaaId(145), "PTAA-00145");
  assert.ok("PTAA-00002" > "PTAA-00001");
  assert.ok("PTAA-00010" > "PTAA-00009");
});

test("the filename reproduces Irfan's real example character for character", () => {
  // His words: PTAA (ONE EQUINE C-01-03) YEN POH WE
  assert.equal(
    ptaaFilename({ propertyName: "ONE EQUINE", unitNo: "C-01-03", ownerName: "YEN POH WE" }),
    "PTAA (ONE EQUINE C-01-03) YEN POH WE.docx");
});

test("the PTAA type is NOT in the filename, and there is no hyphen", () => {
  // Brief §11.3 asks for "PTAA (M ASTRA A-18-09 Partition) - LOY HUI TING.docx".
  // The convention actually in use has neither, and the office wins over the
  // brief — it is the older document.
  const out = ptaaFilename({ propertyName: "M ASTRA", unitNo: "A-18-09", ownerName: "LOY HUI TING" });
  assert.equal(out, "PTAA (M ASTRA A-18-09) LOY HUI TING.docx");
  assert.ok(!/Partition|WUR/.test(out), "the type does not appear");
  assert.ok(!/\) - /.test(out), "no hyphen between the bracket and the owner");
});

test("a Partition and a WUR for one unit now produce the SAME name", () => {
  // Not a bug — a consequence of dropping the type, and the reason the Drive
  // upload checks which PTAA owns an existing file rather than trusting the
  // name to be unique.
  const base = { propertyName: "M ASTRA", unitNo: "A-18-09", ownerName: "LOY HUI TING" };
  assert.equal(ptaaFilename({ ...base, ptaaType: "Partition" }),
               ptaaFilename({ ...base, ptaaType: "WUR" }));
});

test("hyphens and spaces survive — they are part of the pattern, not illegal", () => {
  const out = ptaaFilename({ propertyName: "THE ERA", unitNo: "B-07-11", ownerName: "NUR AIN BINTI ABDULLAH" });
  assert.equal(out, "PTAA (THE ERA B-07-11) NUR AIN BINTI ABDULLAH.docx");
});

test("characters that are illegal in a filename are removed", () => {
  const out = ptaaFilename({ propertyName: 'M/ASTRA', unitNo: 'A:18?09', ownerName: 'LOY "HUI" TING' });
  assert.ok(!/[\\/:*?"<>|]/.test(out), "no illegal characters survive: " + out);
  assert.ok(out.endsWith(".docx"));
});

test("missing pieces show as placeholders rather than producing a broken name", () => {
  const out = ptaaFilename({});
  assert.equal(out, "PTAA ([property] [unit]) [owner].docx");
});

// --- Tenancy dates ----------------------------------------------------------

test("a 12-month term starting 1 Jan ends 31 Dec, not 1 Jan the next year", () => {
  assert.equal(toDateInput(computeExpiry(parseDateInput("2026-01-01"), 12)), "2026-12-31");
});

test("a 36-month term runs three years less a day", () => {
  assert.equal(toDateInput(computeExpiry(parseDateInput("2026-09-15"), 36)), "2029-09-14");
});

test("month-end is clamped rather than spilling into the next month", () => {
  assert.equal(toDateInput(computeExpiry(parseDateInput("2026-01-31"), 1)), "2026-02-27");
  assert.equal(toDateInput(computeExpiry(parseDateInput("2026-08-31"), 6)), "2027-02-27");
});

test("computeExpiry refuses nonsense instead of guessing", () => {
  assert.equal(computeExpiry(null, 12), null);
  assert.equal(computeExpiry(parseDateInput("2026-01-01"), 0), null);
  assert.equal(computeExpiry(parseDateInput("2026-01-01"), "abc"), null);
});

test("date inputs are read as local dates, not shifted by UTC", () => {
  const d = parseDateInput("2026-03-01");
  assert.equal(d.getDate(), 1);
  assert.equal(d.getMonth(), 2);
  assert.equal(toDateInput(d), "2026-03-01");
});

test("overdue and due-today ignore closed requests", () => {
  const now = new Date(2026, 7, 28, 15, 0);
  assert.equal(isOverdue(new Date(2026, 7, 27), STATUS.UNDER_REVIEW, now), true);
  assert.equal(isOverdue(new Date(2026, 7, 28), STATUS.UNDER_REVIEW, now), false, "due today is not yet overdue");
  assert.equal(isOverdue(new Date(2026, 7, 27), STATUS.COMPLETED, now), false);
  assert.equal(isDueToday(new Date(2026, 7, 28), STATUS.UNDER_REVIEW, now), true);
  assert.equal(isDueToday(new Date(2026, 7, 28), STATUS.CANCELLED, now), false);
  assert.equal(isOverdue(null, STATUS.NEW, now), false);
});

// --- Money ------------------------------------------------------------------

test("money accepts the ways people actually type it", () => {
  assert.equal(parseMoney("350").value, 350);
  assert.equal(parseMoney("1,200.50").value, 1200.5);
  assert.equal(parseMoney("RM 1200").value, 1200);
  assert.equal(parseMoney("").value, null);
  assert.equal(parseMoney("abc").ok, false);
  assert.equal(parseMoney("12.345").ok, false, "more than two decimals is a typo");
});

test("money renders as Ringgit with two decimals", () => {
  assert.match(fmtMoney(1200.5), /1,200\.50/);
  assert.equal(fmtMoney(null), "—");
});

// --- Request validation (brief §9.1) ----------------------------------------

const GOOD = {
  owner: { name: "LOY HUI TING", nric: "880214105566", address: "12 Jalan Ampang, KL", phone: "0123456789", email: "" },
  propertyId: "p1", propertyName: "M ASTRA", propertyAddress: "Jalan Ampang",
  unitNo: "a-18-09", ptaaType: "Partition",
  tenancy: { initialTermMonths: "36", commencementDate: "2026-09-01", expiryDate: "" },
  financial: { monthlyAdminFeePercent: "10", renovationCost: "12,000" },
  specialTerms: ["Owner keeps the built-in wardrobe.", "  ", ""],
  notes: "From WhatsApp 26 Aug.",
};

test("a complete draft validates and is stored in canonical form", () => {
  const r = validateRequestDraft(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.owner.nric, "880214-10-5566");
  assert.equal(r.value.owner.phone, "012-345 6789");
  assert.equal(r.value.unitNo, "A-18-09", "unit numbers are upper-cased for the filename");
  assert.equal(r.value.financial.renovationCost, 12000);
});

test("expiry is derived when it is left blank", () => {
  const r = validateRequestDraft(GOOD);
  assert.equal(r.value.tenancy.expiryDate, "2029-08-31");
});

test("an expiry typed by hand is kept", () => {
  const r = validateRequestDraft({ ...GOOD, tenancy: { ...GOOD.tenancy, expiryDate: "2029-12-31" } });
  assert.equal(r.value.tenancy.expiryDate, "2029-12-31");
});

test("an expiry before the start is rejected", () => {
  const r = validateRequestDraft({ ...GOOD, tenancy: { ...GOOD.tenancy, expiryDate: "2026-01-01" } });
  assert.equal(r.ok, false);
  assert.match(r.errors["tenancy.expiryDate"], /after the commencement/);
});

test("blank special terms are dropped, and the list has no fixed length", () => {
  const r = validateRequestDraft(GOOD);
  assert.deepEqual(r.value.specialTerms, ["Owner keeps the built-in wardrobe."]);
  const many = validateRequestDraft({ ...GOOD, specialTerms: Array(11).fill("term") });
  assert.equal(many.value.specialTerms.length, 11);
});

test("every required field is reported by name when missing", () => {
  const r = validateRequestDraft({ owner: {}, tenancy: {}, financial: {}, specialTerms: [] }, { requireTenancy: true });
  assert.equal(r.ok, false);
  for (const key of ["owner.name", "owner.nric", "owner.address", "owner.phone",
                     "propertyId", "unitNo", "ptaaType",
                     "tenancy.initialTermMonths", "tenancy.commencementDate",
                     "financial.monthlyAdminFeePercent"]) {
    assert.ok(r.errors[key], `expected an error for ${key}`);
  }
});

test("the tenancy period may be left for the admin", () => {
  const r = validateRequestDraft({ ...GOOD, tenancy: { initialTermMonths: "", commencementDate: "", expiryDate: "" } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.tenancy, { initialTermMonths: null, commencementDate: "", expiryDate: "" });
  assert.deepEqual(tenancyMissing(r.value), ["initial term", "commencement date", "expiry date"]);
  assert.deepEqual(tenancyMissing({ tenancy: { initialTermMonths: 36, commencementDate: "2026-10-01", expiryDate: "2029-09-30" } }), []);
});

test("a commencement date and term give the expiry automatically", () => {
  const r = validateRequestDraft({ ...GOOD, tenancy: { initialTermMonths: "36", commencementDate: "2026-10-01", expiryDate: "" } });
  assert.equal(r.value.tenancy.expiryDate, "2029-09-30");
  const bad = validateRequestDraft({ ...GOOD, tenancy: { initialTermMonths: "", commencementDate: "next month", expiryDate: "" } });
  assert.ok(bad.errors["tenancy.commencementDate"]);
});

test("renovation cost and owner email are optional", () => {
  const r = validateRequestDraft({ ...GOOD, financial: { monthlyAdminFeePercent: "10", renovationCost: "" } });
  assert.equal(r.ok, true);
  assert.equal(r.value.financial.renovationCost, null);
});

test("a bad owner email is caught, a good one is lower-cased", () => {
  assert.equal(validateRequestDraft({ ...GOOD, owner: { ...GOOD.owner, email: "nope" } }).ok, false);
  const r = validateRequestDraft({ ...GOOD, owner: { ...GOOD.owner, email: "Loy@Example.COM" } });
  assert.equal(r.value.owner.email, "loy@example.com");
});

test("the term must be whole months within a sane range", () => {
  for (const bad of ["0", "-3", "12.5", "999"]) {
    const r = validateRequestDraft({ ...GOOD, tenancy: { ...GOOD.tenancy, initialTermMonths: bad } });
    assert.equal(r.ok, false, `${bad} should be rejected`);
  }
});

test("PTAA type is Partition, No Partition or WUR", () => {
  assert.deepEqual(PTAA_TYPES, ["Partition", "No Partition", "WUR"]);
  assert.equal(validateRequestDraft({ ...GOOD, ptaaType: "No Partition" }).ok, true);
  assert.equal(validateRequestDraft({ ...GOOD, ptaaType: "Other" }).ok, false);
});

test("an unrecognised I/C place-of-birth code warns without blocking submission", () => {
  const r = validateRequestDraft({ ...GOOD, owner: { ...GOOD.owner, nric: "880214185566" } });
  assert.equal(r.ok, true);
  assert.match(r.warnings["owner.nric"], /place-of-birth/);
});


// --- Signatories (brief §9.2, §10) -----------------------------------------

const SIG = (over = {}) => ({
  director: { status: SIGNATORY_STATUS.REQUIRED },
  witness:  { status: SIGNATORY_STATUS.REQUIRED },
  ...over,
});

test("a PTAA with no signatories required says so", () => {
  const s = signatureSummary({});
  assert.equal(s.anyRequired, false);
  assert.equal(s.complete, false);
  assert.equal(s.text, "No signatures required.");
});

test("signatories marked not required are left out of the count", () => {
  const s = signatureSummary(SIG({ witness: { status: SIGNATORY_STATUS.NOT_REQUIRED } }));
  assert.equal(s.total, 1, "only the Director counts");
  assert.deepEqual(s.outstanding, ["Director"]);
});

test("the summary reads the way brief §9.2 describes it", () => {
  const s = signatureSummary(SIG({ director: { status: SIGNATORY_STATUS.SIGNED } }));
  assert.equal(s.done, 1);
  assert.equal(s.total, 2);
  assert.equal(s.text, "Waiting for Witness.");
});

test("several outstanding signatories read as a list", () => {
  const s = signatureSummary(SIG({ owner: { status: SIGNATORY_STATUS.REQUESTED } }));
  assert.equal(s.text, "Waiting for Director, Witness and Owner.");
});

test("all signed reports complete", () => {
  const s = signatureSummary(SIG({
    director: { status: SIGNATORY_STATUS.SIGNED },
    witness: { status: SIGNATORY_STATUS.SIGNED },
  }));
  assert.equal(s.complete, true);
  assert.equal(s.text, "All required signatures recorded.");
});

test("who has the ball is the first signatory still outstanding, not always the Director", () => {
  assert.equal(signatureCurrentAction(SIG()), ACTOR.DIRECTOR);
  assert.equal(signatureCurrentAction(SIG({ director: { status: SIGNATORY_STATUS.SIGNED } })),
               ACTOR.WITNESS);
  assert.equal(signatureCurrentAction(SIG({
    director: { status: SIGNATORY_STATUS.NOT_REQUIRED },
    witness: { status: SIGNATORY_STATUS.NOT_REQUIRED },
    owner: { status: SIGNATORY_STATUS.REQUIRED },
  })), ACTOR.OWNER);
  assert.equal(signatureCurrentAction(SIG({
    director: { status: SIGNATORY_STATUS.SIGNED },
    witness: { status: SIGNATORY_STATUS.SIGNED },
  })), ACTOR.ADMIN, "once everyone has signed it comes back to the admin");
});

test("the Sales Agent is a tracked signatory, and may have a signature of their own", () => {
  const agent = SIGNATORY_TYPES.find(t => t.key === "agent");
  assert.ok(agent, "agents can be a required signatory");
  assert.match(agent.note, /uploaded one on their profile/i,
    "the note says where an agent's image comes from — their own upload, not a company one");
  // Tracking a signatory and placing an image are still separate things: the
  // note describes where the image would come from, never that it is automatic.
  assert.ok(!/automatic/i.test(agent.note));
});

// --- Final checklist (brief §11.1) -----------------------------------------

test("the checklist is the eleven items the brief lists", () => {
  assert.equal(CHECKLIST.length, 11);
  assert.deepEqual(CHECKLIST.map(i => i.label), [
    "PTAA information checked",
    "Owner information checked",
    "Property / unit checked",
    "Tenancy period checked",
    "Special terms checked",
    "Quotation / invoice checked",
    "Required signatures completed",
    "No outstanding changes",
    "No unresolved information requests",
    "Correct document filename",
    "Final Word document exists",
  ]);
});

test("progress counts only ticked items", () => {
  assert.deepEqual(checklistProgress({}), {
    done: 0, total: 11, complete: false, outstanding: CHECKLIST,
  });
  const some = { ptaa_info: { checked: true }, owner_info: { checked: false } };
  assert.equal(checklistProgress(some).done, 1);
  assert.equal(checklistProgress(some).complete, false);

  const all = Object.fromEntries(CHECKLIST.map(i => [i.key, { checked: true }]));
  assert.equal(checklistProgress(all).complete, true);
});

test("items the system can answer for itself are blocked until they are true", () => {
  const bare = checklistBlockers({});
  assert.match(bare.document, /No document has been produced/);
  assert.match(bare.filename, /no document yet/);

  const withDoc = checklistBlockers({ workingDoc: { fileName: "x.docx" } });
  assert.equal(withDoc.document, undefined);
  assert.equal(withDoc.filename, undefined);
});

test("an outstanding signature blocks the signatures line", () => {
  const b = checklistBlockers({ workingDoc: {}, signatories: SIG() });
  assert.match(b.signatures, /Waiting for Director/);

  const done = checklistBlockers({ workingDoc: {}, signatories: SIG({
    director: { status: SIGNATORY_STATUS.SIGNED }, witness: { status: SIGNATORY_STATUS.SIGNED },
  }) });
  assert.equal(done.signatures, undefined);
});

test("an open Owner change request blocks 'No outstanding changes'", () => {
  const b = checklistBlockers({ workingDoc: {}, openChangeRequest: { text: "shorten the term" } });
  assert.match(b.no_changes, /open change request/i);
  assert.equal(checklistBlockers({ workingDoc: {} }).no_changes, undefined);
});

// --- Utilities (his third question) -----------------------------------------
//
// "Some owner want utilities to paid by tenant or they pick a packages that the
// company will bear it... If the property is WUR, then the Cleaning Services
// fall under tenant."

test("a Partition starts with the owner paying and cleaning advanced by us", () => {
  const u = defaultUtilities("Partition");
  assert.equal(u.electricity.party, UTILITY_PARTY.OWNER);
  assert.equal(u.water.party, UTILITY_PARTY.OWNER);
  assert.equal(u.internet.party, UTILITY_PARTY.OWNER);
  assert.equal(u.cleaning.party, UTILITY_PARTY.ADVANCED);
});

test("a Whole Unit Rental puts Cleaning Services on the tenant", () => {
  const u = defaultUtilities("WUR");
  assert.equal(u.cleaning.party, UTILITY_PARTY.TENANT,
    "WUR means the tenant has the whole unit, so the cleaning is theirs");
  // Nothing else moves just because it is a WUR.
  assert.equal(u.electricity.party, defaultUtilities("Partition").electricity.party);
});

test("every standard utility is present in the defaults, labelled", () => {
  const u = defaultUtilities("Partition");
  for (const s of STANDARD_UTILITIES) {
    assert.ok(u[s.key], `${s.key} missing from the defaults`);
    assert.equal(u[s.key].label, s.label);
    assert.equal(u[s.key].standard, true);
  }
});

test("the three quick sets fill the schedule the way the office does", () => {
  const rows = (key) => {
    const r = utilitiesByParty(applyUtilityPreset(defaultUtilities("Partition"), key));
    return { owner: r.owner, advanced: r.advanced, tenant: r.tenant };
  };
  assert.deepEqual(rows("owner"), {
    owner: ["Electricity", "Water", "Wi-Fi / Internet"],
    advanced: ["Cleaning Services"],
    tenant: ["AC Usage via Smart Meter"],
  });
  assert.deepEqual(rows("tenant"), {
    owner: [], advanced: [],
    tenant: ["Electricity", "Water", "Wi-Fi / Internet"],
  });
  assert.deepEqual(rows("package"), {
    owner: [],
    advanced: ["Electricity", "Water", "Wi-Fi / Internet", "Cleaning Services"],
    tenant: ["AC Usage via Smart Meter"],
  });
});

test("a quick set leaves a utility added by hand alone", () => {
  const before = { ...defaultUtilities("Partition"), gas: { label: "Piped gas", party: UTILITY_PARTY.OWNER, standard: false } };
  for (const p of UTILITY_PRESETS) assert.equal(applyUtilityPreset(before, p.key).gas.party, UTILITY_PARTY.OWNER);
});

test("the company package is the one that advances and recovers from the rent", () => {
  const pkg = UTILITY_PRESETS.find(p => p.key === "package");
  assert.equal(pkg.party, UTILITY_PARTY.ADVANCED);
  const u = applyUtilityPreset(defaultUtilities("Partition"), "package");
  const advanced = utilitiesByParty(u).advanced;
  for (const label of ["Electricity", "Water", "Wi-Fi / Internet"]) {
    assert.ok(advanced.includes(label), `${label} should be advanced under the package`);
  }
  // Cleaning is already advanced on a Partition and stays there; the preset
  // neither adds nor removes it.
  assert.ok(advanced.includes("Cleaning Services"));
});

test("an unknown preset key leaves the utilities untouched", () => {
  const before = defaultUtilities("Partition");
  assert.equal(applyUtilityPreset(before, "nonsense"), before);
});

test("a custom utility added by hand lands on the row it was assigned", () => {
  const u = defaultUtilities("Partition");
  u.gas = { label: "Piped gas", party: UTILITY_PARTY.TENANT, standard: false };
  assert.ok(utilitiesByParty(u).tenant.includes("Piped gas"));
});

// --- The administration fee is a percentage, not an amount ------------------

test("the admin fee is validated as a percentage of gross monthly rental", () => {
  const withFee = (v) => validateRequestDraft({ ...GOOD, financial: { monthlyAdminFeePercent: v, renovationCost: "" } });

  assert.equal(withFee("10").ok, true);
  assert.equal(withFee("10").value.financial.monthlyAdminFeePercent, 10);
  assert.equal(withFee("12.5").value.financial.monthlyAdminFeePercent, 12.5);
  assert.equal(withFee("10 %").value.financial.monthlyAdminFeePercent, 10,
    "a typed % sign is tolerated rather than rejected");

  for (const bad of ["", "0", "-5", "101", "abc", "10.555"]) {
    assert.equal(withFee(bad).ok, false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("percentages render with the sign, and nothing renders as an em dash", () => {
  assert.equal(fmtPercent(10), "10 %");
  assert.equal(fmtPercent(null), "\u2014");
});

// --- Property size ----------------------------------------------------------

test("the property size is optional but must be digits when given", () => {
  assert.equal(validateRequestDraft({ ...GOOD, propertySize: "" }).ok, true);
  assert.equal(validateRequestDraft({ ...GOOD, propertySize: "1151" }).value.propertySize, 1151);
  assert.equal(validateRequestDraft({ ...GOOD, propertySize: "big" }).ok, false);
});

test("renovation cost vs invoice total: a clash is reported, agreement is not", async () => {
  const { costClash, costClashText } = await import("../js/model.js");
  const r = (reno, total, extra = {}) => ({ status: "NEW", financial: { renovationCost: reno }, invoice: { total, ...extra } });
  assert.equal(costClash(r(41433, 41433)), null);
  assert.deepEqual(costClash(r(40000, 41433)), { renovationCost: 40000, invoiceTotal: 41433, difference: 1433 });
  assert.match(costClashText(costClash(r(null, 5000))), /renovation cost is NIL/);
  assert.equal(costClash(r(40000, 0)), null, "no invoice total yet");
  assert.equal(costClash(r(40000, 41433, { none: true })), null, "no invoice for this PTAA");
  assert.equal(costClash({ status: "NEW", financial: { renovationCost: 1 } }), null);
  assert.equal(costClash({ ...r(1, 2), status: "CANCELLED" }), null);
});
