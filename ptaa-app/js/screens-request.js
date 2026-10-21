// ---------------------------------------------------------------------------
// screens-request.js — the New PTAA Request form and the request detail screen.
//
// Forms here build their inputs once and only update message lines, so typing
// never loses the caret. See ui.js → liveField.
// ---------------------------------------------------------------------------

import { h, mount, fmtLogTime, fmtDate, friendlyError, toDate, soloMode } from "./core.js";
import { session, isAdmin, profileComplete } from "./auth.js";
import {
  card, button, badge, liveField, textInput, textarea, dateInput, select, table,
  loading, errorBox, noticeBox, toast, confirmAction,
} from "./ui.js";
import {
  STATUS, STATUS_LABEL, STATUS_TONE, ACTOR, PTAA_TYPES, HOLD_REASONS,
  MAX_ATTACHMENTS, ATTACHMENT_SLOTS, missingAttachments, REQUEST_TYPE_LABEL,
  validateRequestDraft, ptaaFilename, computeExpiry, toDateInput, parseDateInput,
  fmtMoney, allowedTransitions, isOverdue, CLOSED_STATUSES,
  SIGNATORY_TYPES, SIGNATORY_STATUS, SIGNATORY_STATUS_LABEL, SIGNATORY_TONE,
  signatureSummary, CHECKLIST, checklistProgress, checklistBlockers,
  UTILITY_PARTY, UTILITY_PARTY_LABEL, UTILITY_PARTY_TONE, UTILITY_PRESETS,
  STANDARD_UTILITIES, defaultUtilities, applyUtilityPreset, utilitiesByParty,
  fmtPercent, tenancyMissing, costClash, costClashText, costAcknowledged,
} from "./model.js";
import {
  listProperties, createRequest, getRequest, saveRequestData, transitionRequest,
  setDueDate, listAttachments, addAttachment, deleteAttachment, deleteAllAttachments,
  listRequestActivity, saveWorkingDocument, loadWorkingDocument, clearManualEditFlag,
  setSignatory, setChecklistItem, setAdminSnapshot, logSignaturesApplied,
  completeRequest, completionBlockers,
  saveQuotationParse, confirmDraft, soloFilingBlockers, fileSoloRequest, saveInvoiceFile,
  shareFinalPdf, unshareFinalPdf, loadFinalPdf, noInvoice, setNoInvoice,
} from "./requests.js";
import { listAgents, agentSnapshotOf, normaliseAgent, getSettings, destinationOf, monthFolderName } from "./directory.js";
import { parseQuotationPages, readPdfText } from "./quotation.js";
import { looksLikeXlsx, invoiceFilename } from "./invoice.js";
import { invoiceCard, downloadInvoice, resolveCostDifference } from "./screens-invoice.js";
import { fileToDrive, driveToken, exportPdf, exportSheetPdf, wordToPdf } from "./drive.js";
import { joinPtaaAndInvoice, looksLikePdf } from "./finalpdf.js";
import { uploadCompletedPtaa, driveStatus, driveAdvice } from "./drive.js";
import { soloStage, SOLO_STAGES, agentStage, AGENT_STAGES } from "./model.js";
import {
  listSignatures, loadSignatureBytes, defaultSignatureChoice,
} from "./signatures.js";
import { createPropertyRequest } from "./property-requests.js";
import { saveDraft, getDraft, deleteDraft } from "./drafts.js";
import { prepareImage, preparePdf, isPdfFile, dataUrlToBytes, fmtBytes, loadPdfLib, prepareIcBothSides } from "./images.js";
import { getEffectiveTemplateMeta, loadEffectiveTemplateBytes } from "./templates.js";
import {
  generateDocx, downloadBlob, looksLikeDocx, readFileAsArrayBuffer,
} from "./docx.js";
import { buildTemplateData, emptyRequiredValues } from "./placeholders.js";

// ===========================================================================
// Shared: the request field set, used by both the new form and the edit form
// ===========================================================================

function emptyDraft() {
  return {
    owner: { name: "", nric: "", address: "", phone: "", email: "",
             bankName: "", accountNumber: "" },
    propertyId: "", propertyName: "", propertyAddress: "",
    unitNo: "", propertySize: "", ptaaType: "",
    tenancy: { initialTermMonths: "", commencementDate: "", expiryDate: "" },
    financial: { monthlyAdminFeePercent: "", renovationCost: "" },
    utilities: defaultUtilities(""),
    specialTerms: [],
    notes: "",
  };
}

function draftFromRequest(r) {
  return {
    owner: { ...(r.owner || {}) },
    propertyId: r.propertyId || "",
    propertyName: r.propertyName || "",
    propertyAddress: r.propertyAddress || "",
    unitNo: r.unitNo || "",
    ptaaType: r.ptaaType || "",
    tenancy: {
      initialTermMonths: r.tenancy && r.tenancy.initialTermMonths != null ? String(r.tenancy.initialTermMonths) : "",
      commencementDate: (r.tenancy && r.tenancy.commencementDate) || "",
      expiryDate: (r.tenancy && r.tenancy.expiryDate) || "",
    },
    propertySize: r.propertySize != null ? String(r.propertySize) : "",
    financial: {
      monthlyAdminFeePercent: r.financial && r.financial.monthlyAdminFeePercent != null
        ? String(r.financial.monthlyAdminFeePercent) : "",
      renovationCost: r.financial && r.financial.renovationCost != null ? String(r.financial.renovationCost) : "",
    },
    utilities: Object.keys(r.utilities || {}).length
      ? JSON.parse(JSON.stringify(r.utilities))
      : defaultUtilities(r.ptaaType),
    specialTerms: Array.isArray(r.specialTerms) ? [...r.specialTerms] : [],
    notes: r.notes || "",
  };
}

/**
 * Builds the whole request form once and returns handles to it.
 * `onChange` fires after every keystroke so the caller can refresh previews.
 */
function buildRequestForm({ draft, properties, prefix, onChange, onAskForProperty = null, solo = false,
                            showTenancy = true, showSpecialTerms = true }) {
  const f = {};
  const id = (k) => `${prefix}-${k.replace(/\./g, "-")}`;
  const touch = () => onChange();

  const get = (path) => path.split(".").reduce((o, k) => (o || {})[k], draft);
  const put = (path, v) => {
    const parts = path.split(".");
    const last = parts.pop();
    parts.reduce((o, k) => o[k], draft)[last] = v;
  };

  const text = (path, label, hint, opts = {}) => {
    const input = opts.multiline
      ? textarea({ id: id(path), value: get(path) || "", rows: opts.rows || 3,
                   onInput: (e) => { put(path, e.target.value); touch(); } })
      : textInput({ id: id(path), value: get(path) || "", placeholder: opts.placeholder || "",
                    onInput: (e) => { put(path, e.target.value); syncExpiry(path); touch(); } });
    f[path] = liveField({ id: id(path), label, hint, input, wide: !!opts.wide });
    return f[path].node;
  };

  const date = (path, label, hint) => {
    const input = dateInput({ id: id(path), value: get(path) || "",
                              onInput: (e) => { put(path, e.target.value); syncExpiry(path); touch(); } });
    f[path] = liveField({ id: id(path), label, hint, input });
    return f[path].node;
  };

  // --- Expiry follows the commencement date and the term ------------------
  // Filled in automatically whenever either changes, unless the admin has
  // typed a different expiry date over it.
  const expiryNote = h("p", { class: "muted small" });
  const derivedExpiry = () => {
    const start = parseDateInput(draft.tenancy.commencementDate);
    const months = Number(draft.tenancy.initialTermMonths);
    return start && Number.isInteger(months) && months > 0 ? toDateInput(computeExpiry(start, months)) : "";
  };
  let expiryAuto = !draft.tenancy.expiryDate || draft.tenancy.expiryDate === derivedExpiry();
  function syncExpiry(path) {
    if (!String(path).startsWith("tenancy.")) return;
    const derived = derivedExpiry();
    if (path === "tenancy.expiryDate") {
      expiryAuto = !draft.tenancy.expiryDate || draft.tenancy.expiryDate === derived;
    } else if (expiryAuto) {
      draft.tenancy.expiryDate = derived;
      if (f["tenancy.expiryDate"]) f["tenancy.expiryDate"].input.value = derived;
    }
    paintExpiryNote();
  }
  function paintExpiryNote() {
    const derived = derivedExpiry();
    const months = Number(draft.tenancy.initialTermMonths);
    expiryNote.textContent = !derived
      ? "Enter the term and the commencement date — the expiry date fills itself in."
      : derived === draft.tenancy.expiryDate
        ? `A ${months}-month term from that date ends ${fmtDate(parseDateInput(derived))}.`
        : `Note: a ${months}-month term would normally end ${fmtDate(parseDateInput(derived))}. ` +
          "Clear the expiry date to use that.";
  }

  // --- Property picker; choosing one fills the address ---
  const propertySelect = select({
    id: id("propertyId"),
    value: draft.propertyId,
    options: [
      { value: "", label: properties.length ? "— choose a property —" : "— no properties yet —" },
      ...properties.map(p => ({ value: p.id, label: p.name })),
    ],
    onChange: (e) => {
      draft.propertyId = e.target.value;
      const p = properties.find(x => x.id === e.target.value);
      draft.propertyName = p ? p.name : "";
      if (p && p.address && !String(draft.propertyAddress || "").trim()) {
        draft.propertyAddress = p.address;
        if (f["propertyAddress"]) f["propertyAddress"].input.value = p.address;
      }
      touch();
    },
  });
  f["propertyId"] = liveField({
    id: id("propertyId"), label: "Property / condo",
    hint: properties.length
      ? "The name here becomes the folder and the filename, so it must be exactly right."
      : "An admin needs to add properties before a request can be submitted.",
    input: propertySelect,
  });

  const typeSelect = select({
    id: id("ptaaType"), value: draft.ptaaType,
    options: [{ value: "", label: "— choose —" }, ...PTAA_TYPES.map(t => ({ value: t, label: t }))],
    onChange: (e) => {
      const previous = draft.ptaaType;
      draft.ptaaType = e.target.value;
      // WUR is Whole Unit Rental, so cleaning becomes the tenant's. Only nudge
      // the default while the utilities are still untouched defaults.
      if (previous !== draft.ptaaType && !utilitiesTouched) {
        draft.utilities = defaultUtilities(draft.ptaaType);
        renderUtilities();
      }
      touch();
    },
  });
  f["ptaaType"] = liveField({ id: id("ptaaType"), label: "PTAA type", hint: "Partition (with Appendix B), No Partition or WUR.", input: typeSelect });

  // --- Utilities: schedule items 11, 12 and 13 -----------------------------
  // Who pays for what changes per PTAA, so each utility is assigned a party
  // rather than being fixed in the template.
  let utilitiesTouched = false;
  const utilitiesHost = h("div", {});
  const utilitiesPreview = h("div", { class: "util-preview" });

  function renderUtilityPreview() {
    const byParty = utilitiesByParty(draft.utilities);
    const row = (label, items) => h("div", { class: "preview-block" },
      h("div", { class: "preview-label" }, label),
      items.length
        ? h("ul", { class: "util-list" }, items.map(i => h("li", {}, i)))
        : h("p", { class: "empty" }, "NIL"));
    mount(utilitiesPreview,
      h("h3", {}, "How the schedule will read"),
      row("11 — Utilities to be paid by Owner", byParty.owner),
      row("12 — Advanced by the Tenancy Administrator, recovered from rent", byParty.advanced),
      row("13 — Utilities to be paid by Tenant", byParty.tenant),
    );
  }

  function renderUtilities() {
    const entries = Object.entries(draft.utilities || {});
    mount(utilitiesHost,
      h("div", { class: "actions" },
        h("span", { class: "inline-label" }, "Quick set:"),
        ...UTILITY_PRESETS.map(preset => button(preset.label, {
          variant: "quiet", title: preset.note,
          onClick: () => {
            draft.utilities = applyUtilityPreset(draft.utilities, preset.key);
            utilitiesTouched = true;
            renderUtilities(); touch();
          },
        })),
      ),
      h("p", { class: "muted small" },
        "Quick set fills in all five lines the usual way for that arrangement — change any line afterwards if this one differs."),
      entries.length === 0
        ? h("p", { class: "empty" }, "No utilities listed.")
        : h("div", { class: "util-rows" }, entries.map(([key, entry]) => h("div", { class: "util-row" },
            entry.standard
              ? h("span", { class: "util-name" }, entry.label)
              : textInput({ id: id("util-" + key), value: entry.label,
                  onInput: (e) => { entry.label = e.target.value; utilitiesTouched = true; renderUtilityPreview(); touch(); } }),
            select({
              id: id("utilparty-" + key), value: entry.party,
              options: Object.values(UTILITY_PARTY).map(v => ({ value: v, label: UTILITY_PARTY_LABEL[v] })),
              onChange: (e) => {
                entry.party = e.target.value;
                utilitiesTouched = true;
                renderUtilityPreview(); touch();
              },
            }),
            entry.standard
              ? null
              : button("Remove", { variant: "quiet-danger",
                  onClick: () => { delete draft.utilities[key]; utilitiesTouched = true; renderUtilities(); touch(); } }),
          ))),
      h("div", { class: "actions" },
        button("+ Add another utility", { variant: "quiet",
          onClick: () => {
            const key = "custom" + Date.now().toString(36);
            draft.utilities[key] = { label: "", party: UTILITY_PARTY.OWNER, standard: false };
            utilitiesTouched = true;
            renderUtilities(); touch();
            const inputs = utilitiesHost.querySelectorAll("input");
            if (inputs.length) inputs[inputs.length - 1].focus();
          } }),
      ),
    );
    renderUtilityPreview();
  }
  renderUtilities();

  // --- Special terms: a variable-length list, never a fixed number of slots ---
  const termsHost = h("div", { class: "terms" });
  function renderTerms() {
    mount(termsHost,
      draft.specialTerms.length === 0
        ? h("p", { class: "empty" }, "No special terms.")
        : draft.specialTerms.map((t, i) => h("div", { class: "term-row" },
            h("span", { class: "term-n" }, String(i + 1) + "."),
            textInput({
              id: id("term" + i), value: t,
              onInput: (e) => { draft.specialTerms[i] = e.target.value; touch(); },
            }),
            button("Remove", {
              variant: "quiet-danger",
              onClick: () => { draft.specialTerms.splice(i, 1); renderTerms(); touch(); },
            }),
          )),
      h("div", { class: "actions" },
        button("+ Add special term", {
          variant: "quiet",
          onClick: () => {
            draft.specialTerms.push("");
            renderTerms();
            const inputs = termsHost.querySelectorAll("input");
            if (inputs.length) inputs[inputs.length - 1].focus();
            touch();
          },
        }),
      ),
    );
  }
  renderTerms();

  const node = h("div", {},
    card("Owner",
      h("div", { class: "form-grid" },
        text("owner.name", "Full name", "As it should appear in the agreement, e.g. PEEH KEAN GUAN"),
        text("owner.nric", "I/C number", "12 digits, e.g. 761107-08-6307"),
        text("owner.phone", "Phone number", "Malaysian mobile, e.g. 016-521 0163"),
        text("owner.email", "Email (optional)", "Used only for contact, never for sign-in."),
      ),
      text("owner.address", "Address", "Registered and mailing address, as it goes into the agreement.", { multiline: true, wide: true }),
      h("div", { class: "form-grid" },
        text("owner.bankName", "Bank name", "In full, e.g. MALAYAN BANKING BERHAD (MAYBANK) — schedule item 3b"),
        text("owner.accountNumber", "Bank account number", "Where the rental proceeds are remitted."),
      ),
    ),
    card("Property",
      h("div", { class: "form-grid" },
        f["propertyId"].node,
        text("unitNo", "Unit number", "e.g. B-42-13A"),
        f["ptaaType"].node,
        text("propertySize", "Size (square feet)", "Digits only, e.g. 1151 — the agreement adds the words."),
      ),
      text("propertyAddress", "Property address", "Filled in from the property list; edit if this unit differs.", { multiline: true, rows: 2, wide: true }),
      onAskForProperty
        ? h("p", { class: "muted small" },
            "Condo not on the list? ",
            button("Ask an admin to add it", { variant: "link", onClick: onAskForProperty }),
            " — the spelling has to match the folder, so an admin sets it.")
        : null,
    ),
    showTenancy ? card("Tenancy period",
      h("div", { class: "form-grid" },
        text("tenancy.initialTermMonths", "Initial term (months)", "Whole months, e.g. 36", { placeholder: "36" }),
        date("tenancy.commencementDate", "Commencement date", "When the tenancy starts."),
        date("tenancy.expiryDate", "Expiry date", "Filled in from the term and the commencement date."),
      ),
      expiryNote,
      h("p", { class: "muted small" }, "Set by the admin — Sales Agents do not see this section."),
    ) : null,
    card("Fees",
      h("div", { class: "form-grid" },
        text("financial.monthlyAdminFeePercent", "Monthly administration fee (%)",
             "A percentage of gross monthly rental — 10 prints as “Ten Per centum (10 %)”.",
             { placeholder: "10" }),
        text("financial.renovationCost", "Renovation cost (RM)",
             "Amount only. Leave blank if not applicable.", { placeholder: "0" }),
      ),
    ),
    card("Utilities",
      h("p", { class: "muted small" },
        "Schedule items 11, 12 and 13. Some owners pay, some pass it to the tenant, ",
        "and some take a package where we advance it and recover it from the rent."),
      h("div", { class: "util-grid" }, utilitiesHost, utilitiesPreview),
    ),
    showSpecialTerms ? card("Special terms",
      h("p", { class: "muted small" },
        "Anything agreed beyond the standard clauses. Added to the agreement as a numbered list."),
      termsHost,
    ) : null,
    card(solo ? "Notes" : "Notes for the admin",
      text("notes", "Context", solo
        ? "Anything worth remembering about this PTAA. Not part of the agreement."
        : "Anything from WhatsApp or a call that the admin needs in order to prepare this. Not part of the agreement.",
           { multiline: true, rows: 4, wide: true }),
    ),
  );

  paintExpiryNote();
  return { node, fields: f, renderTerms };
}

/** Paint validation results onto a built form. */
function applyValidation(fields, result, { showAll }) {
  for (const [path, fld] of Object.entries(fields)) {
    const err = result.errors[path];
    const warn = result.warnings[path];
    const filled = String(fld.input.value || "").trim().length > 0;
    if (err && (showAll || filled)) fld.set("err", err);
    else if (warn) fld.set("warn", warn);
    else fld.reset();
  }
}

/** What to tell the user after a both-sides I/C file was read. */
function bothSidesMessage(how) {
  return how === "pages" ? "Front and back taken from pages 1 and 2 of the PDF."
       : how === "whole" ? "Could not find two separate cards in that picture, so the whole picture is used as the I/C."
       : "Front and back found and cut apart — check both pictures, and use “Swap” if they are the wrong way round.";
}

/** The ic_back slot, when the front picture already shows both sides. */
function backCoveredNote() {
  return h("p", { class: "muted small" }, "Included in the front picture (both sides in one).");
}

/**
 * Read the line items out of a quotation PDF so the invoice can be pre-filled.
 * Never fatal: a quotation that cannot be read still goes into Appendix A, and
 * the invoice items can be typed instead.
 */
async function readQuotation(file) {
  try {
    const pdfjs = await loadPdfLib();
    const pages = await readPdfText(await file.arrayBuffer(), pdfjs);
    const parsed = parseQuotationPages(pages);
    return { ...parsed, fileName: file.name || "quotation.pdf" };
  } catch (err) {
    console.warn("[quotation] could not read items:", err);
    return null;
  }
}

// ===========================================================================
// New PTAA Request
// ===========================================================================

export function newRequestScreen(navigate, { draftId: startDraftId = null } = {}) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  const admin = isAdmin();
  let draftId = startDraftId;        // set once the form has been saved as a draft
  let savingDraft = false;
  let draftBtn = null;
  const draftStatus = h("span", { class: "muted small" });

  // Solo mode: the admin starts the PTAA and picks the Sales Agent from the list.
  const solo = soloMode && isAdmin();
  let agents = [];
  let agentId = "";
  let pendingQuote = null;         // items read from a PDF quotation
  const agentHost = h("div", {});
  const agentInfo = h("div", {});

  const draft = emptyDraft();
  const pending = [];              // images held in memory until the request exists
  let properties = [];
  let form = null;
  let submitting = false;
  let showAll = false;
  let submitBtn, filenamePreview, attachHost, errorHost;

  function refresh() {
    const result = validateRequestDraft(draft);
    applyValidation(form.fields, result, { showAll });

    filenamePreview.textContent = ptaaFilename({
      propertyName: result.value.propertyName,
      unitNo: result.value.unitNo,
      ownerName: result.value.owner.name,
    });

    if (solo && !agentId) {
      result.ok = false;
      result.errors["agent"] = "Choose the Sales Agent.";
    }
    submitBtn.disabled = submitting || !result.ok;
    submitBtn.textContent = submitting ? (solo ? "Starting…" : "Submitting…") : (solo ? "Start PTAA" : "Submit request");
    return result;
  }

  function chosenAgent() { return agents.find(a => a.id === agentId) || null; }

  function renderAgentInfo() {
    const a = chosenAgent();
    if (!a) { mount(agentInfo, h("p", { class: "muted small" }, "Their full name, I/C and mobile go into the “Witnessed by” block.")); return; }
    const { problems } = normaliseAgent(a);
    mount(agentInfo,
      h("dl", { class: "preview-dl" },
        h("dt", {}, "Full Name:"), h("dd", {}, a.fullName || "—"),
        h("dt", {}, "NRIC:"),      h("dd", {}, a.nric || "—"),
        h("dt", {}, "Mobile:"),    h("dd", {}, a.phone || "—"),
        h("dt", {}, "Nickname:"),  h("dd", {}, a.nickname || "—"),
      ),
      problems.length
        ? noticeBox("warn", h("p", { class: "small" },
            `${a.nickname || a.fullName}: ${problems.join(", ")}. `,
            "The PTAA can still be started, but these will print blank — fix them under Agents."))
        : null,
    );
  }

  function agentCard() {
    const sel = select({
      id: "nr-agent", value: agentId,
      options: [
        { value: "", label: agents.length ? "— choose the Sales Agent —" : "— no agents on the list yet —" },
        ...agents.map(a => ({ value: a.id, label: `${a.nickname || "—"} · ${a.fullName || "(no full name)"}` })),
      ],
      onChange: (e) => { agentId = e.target.value; renderAgentInfo(); refresh(); },
    });
    mount(agentHost, h("div", { class: "field" },
      h("label", { class: "field-label", for: "nr-agent" }, "Sales Agent"), sel));
    renderAgentInfo();
    return card("Sales Agent",
      agentHost, agentInfo,
      agents.length ? null : h("p", { class: "small" }, "Add agents under ",
        button("Agents", { variant: "link", onClick: () => navigate("agents") }), " first."),
    );
  }

  /**
   * An agent picks a property rather than typing one, because the name becomes
   * the folder and part of the filename. When their condo is not on the list,
   * this is how they ask — the admin still decides the spelling.
   */
  async function askForProperty() {
    const name = window.prompt(
      "Which condo should be added?\n\n" +
      "Type it as it should appear on the agreement — an admin will check the " +
      "spelling before adding it.", "");
    if (name === null) return;
    if (!String(name).trim()) { toast("A name is needed.", "warn"); return; }

    const address = window.prompt(
      `Address for “${name.trim()}” (optional — leave blank if you are not sure):`, "");
    if (address === null) return;

    const note = window.prompt(
      "Anything the admin should know? (optional)\n\n" +
      "e.g. which owner or unit this is for.", "");
    if (note === null) return;

    try {
      await createPropertyRequest({ name, address, note });
      toast("Sent. An admin will add it — you will be notified when it is on the list.");
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  /** The same three slots as the request screen, held in memory until submit. */
  async function takeBothSides(file, busy) {
    try {
      busy.textContent = "Finding the front and the back…";
      const res = await prepareIcBothSides(file);
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].kind === "ic_front" || pending[i].kind === "ic_back") pending.splice(i, 1);
      }
      pending.push({ ...res.front, name: res.front.originalName, kind: "ic_front", page: null, bothSides: res.how === "whole" });
      if (res.back) pending.push({ ...res.back, name: res.back.originalName, kind: "ic_back", page: null });
      toast(bothSidesMessage(res.how), res.how === "whole" ? "warn" : "ok");
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally {
      busy.textContent = "";
      renderAttachments();
    }
  }

  function swapIcSides() {
    for (const a of pending) {
      if (a.kind === "ic_front") a.kind = "ic_back";
      else if (a.kind === "ic_back") a.kind = "ic_front";
      // Moved to the other slot, so a saved draft must store it again.
      if (a.kind === "ic_front" || a.kind === "ic_back") delete a.draftFileId;
    }
    renderAttachments();
  }

  function renderAttachments() {
    const bothInFront = pending.some(a => a.kind === "ic_front" && a.bothSides);
    const haveFront = pending.some(a => a.kind === "ic_front");
    const haveBack = pending.some(a => a.kind === "ic_back");
    const rows = ATTACHMENT_SLOTS.map(slot => {
      const files = pending.filter(a => a.kind === slot.key)
                           .sort((x, y) => (x.page || 1) - (y.page || 1));
      const busy = h("span", { class: "muted small" });
      const both = slot.key !== "ic_front" ? null : h("input", {
        type: "file", accept: "image/*,application/pdf", class: "visually-hidden", "data-both": "1",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) takeBothSides(f, busy); },
      });
      const pick = h("input", {
        type: "file", accept: slot.accept, class: "visually-hidden",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) takeFile(slot, f, busy); },
      });
      const camera = h("input", {
        type: "file", accept: "image/*", capture: "environment", class: "visually-hidden",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) takeFile(slot, f, busy); },
      });

      return h("div", { class: "slot" },
        h("div", { class: "slot-head" },
          h("strong", {}, slot.label),
          files.length ? badge(files.length > 1 ? `${files.length} pages` : "Attached", "ok")
                       : slot.key === "ic_back" && bothInFront ? badge("In the front picture", "ok")
                       : badge("Not attached", "off")),
        h("p", { class: "muted small" }, slot.where),
        slot.note ? h("p", { class: "muted small" }, slot.note) : null,
        !files.length && slot.key === "ic_back" && bothInFront ? backCoveredNote() : null,
        files.length
          ? h("div", { class: "thumbs" }, files.map(a =>
              h("figure", { class: "thumb" },
                h("img", { src: a.dataUrl, alt: a.name }),
                h("figcaption", {},
                  h("span", { class: "small" }, a.page ? `Page ${a.page}` : a.name),
                  h("span", { class: "muted small" }, fmtBytes(a.bytes)),
                  button("Remove", { variant: "quiet-danger", onClick: () => {
                    for (let i = pending.length - 1; i >= 0; i--) {
                      if (pending[i] === a) pending.splice(i, 1);
                    }
                    renderAttachments();
                  } })))))
          : slot.key === "ic_back" && bothInFront ? null : h("p", { class: "empty" }, "Nothing attached."),
        h("div", { class: "actions" },
          pick, camera, both,
          button(files.length ? "Replace" : "Choose file", { onClick: () => pick.click() }),
          slot.camera ? button("Take photo", { variant: "quiet", onClick: () => camera.click() }) : null,
          slot.key === "ic_front"
            ? button("Both sides in one file", { variant: "quiet", title: "One photo, scan or PDF with the front and the back",
                onClick: () => both.click() })
            : null,
          slot.key === "ic_back" && haveFront && haveBack
            ? button("Swap front and back", { variant: "quiet", onClick: swapIcSides })
            : null,
          busy),
      );
    });

    mount(attachHost,
      h("div", { class: "slots" }, rows),
      h("p", { class: "muted small" },
        "The I/C goes onto its own page in the agreement; the quotation's items fill in the ",
        "invoice. The copies stored against the request are working material and are cleared ",
        "once the PTAA is done."),
    );
  }

  async function takeFile(slot, file, busy) {
    try {
      busy.textContent = "Reading…";
      let prepared;
      if (isPdfFile(file)) {
        if (slot.key !== "quotation") throw new Error(`${slot.label} must be a photo, not a PDF.`);
        prepared = await preparePdf(file, (done, total) => {
          busy.textContent = done < total ? `Reading page ${done + 1} of ${total}…` : "";
        });
        if (prepared.truncatedFrom) {
          toast(`That PDF has ${prepared.truncatedFrom} pages; only the first ` +
                `${prepared.length} were attached.`, "warn");
        }
        {
          busy.textContent = "Reading the items…";
          pendingQuote = await readQuotation(file);
          if (pendingQuote) {
            toast(`${pendingQuote.entries.filter(e => e.qty > 0).length} priced items read from the quotation.`);
            const gt = pendingQuote.grandTotal;
            const renoField = form && form.fields["financial.renovationCost"];
            if (gt && renoField && !String(draft.financial.renovationCost || "").trim()) {
              draft.financial.renovationCost = String(gt);
              renoField.input.value = String(gt);
              refresh();
            }
          }
        }
      } else {
        prepared = [await prepareImage(file)];
        if (slot.key === "quotation") pendingQuote = null;
      }

      // One file per slot: replacing clears whatever was there.
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].kind === slot.key) pending.splice(i, 1);
      }
      for (const img of prepared) {
        pending.push({ ...img, name: img.originalName || file.name,
                       kind: slot.key, page: img.page || null });
      }
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally {
      busy.textContent = "";
      renderAttachments();
    }
  }

  async function submit() {
    showAll = true;
    const result = refresh();
    if (!result.ok || submitting) {
      if (!result.ok) toast("Some fields still need attention.", "warn");
      return;
    }
    submitting = true; mount(errorHost); refresh();
    try {
      const id = solo
        ? await createRequest(result.value, { agentSnapshot: agentSnapshotOf(chosenAgent()) })
        : await createRequest(result.value);
      for (const a of pending) {
        try {
          await addAttachment(id, { kind: a.kind, name: a.name, dataUrl: a.dataUrl,
                                    bytes: a.bytes, width: a.width, height: a.height,
                                    page: a.page || null, bothSides: !!a.bothSides });
        } catch (err) {
          toast(`Request saved, but the image “${a.name}” could not be attached: ${friendlyError(err)}`, "warn");
        }
      }
      if (pendingQuote) {
        try { await saveQuotationParse(id, pendingQuote); }
        catch (err) { toast(`The quotation items could not be saved: ${friendlyError(err)}`, "warn"); }
      }
      if (draftId) {
        try { await deleteDraft(draftId); } catch (err) { console.warn("[drafts] could not remove", err); }
      }
      toast(solo ? `${id} started.` : `${id} submitted.`);
      navigate("request:" + id);
    } catch (err) {
      const msg = friendlyError(err);
      mount(errorHost, errorBox(msg));
      toast(msg, "error");
    } finally {
      submitting = false; refresh();
    }
  }

  /** Keep what has been typed so far, to finish and submit later. */
  async function saveAsDraft() {
    if (savingDraft || submitting) return;
    savingDraft = true;
    draftBtn.disabled = true; draftBtn.textContent = "Saving…";
    try {
      draftId = await saveDraft(draftId, { form: draft, agentId, quotation: pendingQuote, files: pending });
      draftStatus.textContent = `Draft saved at ${new Date().toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" })}.`;
      toast("Draft saved. Find it under My PTAAs → Drafts.");
      if (!startDraftId && location.hash !== "#/new-request:" + draftId) {
        history.replaceState(null, "", "#/new-request:" + draftId);
      }
    } catch (err) {
      const denied = err && (err.code === "permission-denied" || /insufficient permissions/i.test(err.message || ""));
      toast(denied
        ? "The draft could not be saved: the database rules in Firebase are out of date. Publish the latest " +
          "firestore.rules (Firebase → Firestore Database → Rules → paste → Publish), then try again."
        : "The draft could not be saved: " + (err.message || friendlyError(err)), "error");
    } finally {
      savingDraft = false;
      draftBtn.disabled = false; draftBtn.textContent = "Save draft";
    }
  }

  /** Put a saved draft back into the form before it is built. */
  async function restoreDraft() {
    const d = await getDraft(draftId);
    if (!d) { draftId = null; toast("That draft no longer exists — starting a new one.", "warn"); return; }
    const saved = d.form || {};
    Object.assign(draft, saved, {
      owner: { ...draft.owner, ...(saved.owner || {}) },
      tenancy: { ...draft.tenancy, ...(saved.tenancy || {}) },
      financial: { ...draft.financial, ...(saved.financial || {}) },
      utilities: saved.utilities && Object.keys(saved.utilities).length ? saved.utilities : draft.utilities,
      specialTerms: Array.isArray(saved.specialTerms) ? saved.specialTerms : [],
    });
    agentId = d.agentId || "";
    pendingQuote = d.quotation || null;
    pending.splice(0, pending.length, ...d.files);
    draftStatus.textContent = `Continuing a draft saved ${fmtLogTime(d.updatedAt)}.`;
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, solo ? "New PTAA" : "New PTAA Request"),
      h("p", { class: "screen-sub" }, solo
        ? "Fill in the owner, condo and tenancy, pick the Sales Agent, and attach the owner's I/C and the " +
          "quotation. The Word agreement and the Excel invoice are drafted from this on the next screen."
        : "Fill in the owner and the unit and attach the owner's I/C and the quotation. " +
          "“Save draft” keeps it to finish later; “Submit request” sends it to the admin, who sets the " +
          "tenancy period and prepares the agreement. Your own details come from your profile."),
      host);
    mount(host, loading());
    try {
      [properties, agents] = await Promise.all([
        listProperties(),
        solo ? listAgents() : Promise.resolve([]),
      ]);
      if (draftId) await restoreDraft();
      form = buildRequestForm({
        draft, properties, prefix: "nr", onChange: refresh,
        onAskForProperty: solo ? null : askForProperty,
        solo,
        // The tenancy period and special terms are the admin's to set.
        showTenancy: admin || !soloMode, showSpecialTerms: admin || !soloMode,
      });

      filenamePreview = h("code", { class: "filename" }, "");
      attachHost = h("div", {});
      errorHost = h("div", {});
      submitBtn = button(solo ? "Start PTAA" : "Submit request", { variant: "primary", onClick: submit });
      draftBtn = button("Save draft", { onClick: saveAsDraft,
        title: "Keep what is filled in so far and finish it later. Nothing is sent to the admin." });

      mount(host,
        solo ? agentCard() : null,
        properties.length === 0
          ? noticeBox("warn",
              h("p", {}, "There are no properties on the list yet, so a request cannot be submitted."),
              h("p", { class: "small" }, "Ask an admin to add the condo under ", h("strong", {}, "Properties"), "."))
          : null,
        form.node,
        card("Supporting files",
          h("p", { class: "muted small" },
            "On a phone, “Take photo” opens the camera directly."),
          attachHost,
        ),
        admin || !soloMode ? card("What will be generated",
          h("p", { class: "muted small" }, "Filename, built automatically and never typed:"),
          filenamePreview,
        ) : null,
        errorHost,
        h("div", { class: "form-actions" },
          submitBtn,
          draftBtn,
          button("Cancel", { variant: "quiet", onClick: () => navigate("dashboard") }),
          draftStatus,
        ),
      );

      renderAttachments();
      refresh();
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Request detail
// ===========================================================================

export function requestDetailScreen(requestId, navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  const solo = soloMode && isAdmin();
  let settings = null;
  let req = null, attachments = [], activity = [], properties = [];
  let templateMeta = undefined;          // undefined = not looked up yet
  let editing = false;
  let lastCompletePdf = null;            // the complete PDF built in step 6, this visit

  // Signature library, the three slot choices, and a byte cache so a preview is
  // only fetched once per signature per visit.
  let signatures = [];
  let drive = undefined;                 // undefined = not checked yet
  const completionErrors = h("div", {});
  let sigChoice = null;                  // null = not seeded yet
  const sigBytes = new Map();
  const sigPreview = new Map();

  // A Sales Agent in the solo workflow: sees what they submitted and, at the
  // end, the finished PDF — nothing the admin works with.
  const agentMode = soloMode && !isAdmin();

  const canEdit = () => isAdmin() ||
    (req && req.agentEmail === session.email &&
     (agentMode
       // Theirs to change only until the admin starts drafting.
       ? req.status === STATUS.NEW && agentStage(req) === AGENT_STAGES.SUBMITTED
       : [STATUS.NEW, STATUS.CHANGES_REQUIRED].includes(req.status)));

  /** Is this request waiting on whoever is looking at it right now? */
  const isMine = () => !!req && (
    isAdmin() ? req.currentAction === ACTOR.ADMIN
              : req.currentAction === ACTOR.AGENT && req.agentEmail === session.email);

  async function act(fn) {
    try { await fn(); await load(); }
    catch (err) { toast(friendlyError(err), "error"); }
  }

  function transitionButtons() {
    const opts = allowedTransitions(req.status, session.role);
    if (!opts.length) return h("p", { class: "empty" }, "No actions available to you at this status.");

    return h("div", { class: "actions" }, opts.map(t => {
      if (t.notYet) {
        return button(t.label, { variant: "quiet", disabled: true,
          title: `Arrives in ${t.notYet}.` });
      }
      return button(t.label, {
        variant: t.destructive ? "quiet-danger" : (t.to === "__resume__" ? "primary" : "default"),
        title: t.note,
        onClick: () => act(async () => {
          let note = "", reason = "";
          if (t.needsReason) {
            reason = window.prompt(
              t.to === STATUS.ON_HOLD
                ? `Why is ${req.ptaaId} going on hold?\n\n${HOLD_REASONS.join("\n")}`
                : `Why is ${req.ptaaId} being cancelled?`,
              t.to === STATUS.ON_HOLD ? HOLD_REASONS[0] : "");
            if (reason === null) return;
            if (!String(reason).trim()) { toast("A reason is required.", "warn"); return; }
          }
          if (t.needsNote) {
            note = window.prompt(
              t.changeRequest
                ? `What does the Owner want changed on ${req.ptaaId}?\n\n` +
                  `Describe it in plain words — no document needed.\n` +
                  `e.g. "Change the tenancy period from 36 months to 12 months"`
                : `Add a note for ${t.label.toLowerCase()} on ${req.ptaaId}:`,
              "");
            if (note === null) return;
            if (!String(note).trim()) { toast("A note is required so the other side knows what to do.", "warn"); return; }
          }
          if (t.destructive && !confirmAction(`Cancel ${req.ptaaId}? This cannot be undone.`)) return;
          await transitionRequest(requestId, t.to, { note, reason });
          toast("Status updated.");
        }),
      });
    }));
  }

  // --- Completion (brief §11.2) -------------------------------------------

  /**
   * Complete is not a status button, and is deliberately not in the transition
   * table. It uploads to Drive first and moves the status only if Drive confirms
   * the file — so a failure here leaves the request exactly where it was.
   */
  function completionCard() {
    if (!isAdmin()) return null;
    if (req.status === STATUS.COMPLETED) return null;
    if (![STATUS.FINAL_CHECK].includes(req.status)) return null;

    const blockers = completionBlockers(req);
    const stage = h("p", { class: "muted small" });
    const btn = button("Complete and file to Drive", { variant: "primary" });
    let running = false;

    btn.disabled = blockers.length > 0 || drive === undefined || (drive && !drive.ok);

    btn.addEventListener("click", async () => {
      if (running) return;
      const name = generatedFilename();
      if (!confirmAction(
        `Complete ${req.ptaaId}?\n\n` +
        `It will be uploaded to Google Drive as:\n  ${name}\n` +
        `into the folder: ${req.propertyName}\n\n` +
        `Once completed the request is closed and can no longer be edited.`)) return;

      running = true;
      btn.disabled = true;
      btn.textContent = "Completing…";
      try {
        // Asked for first, straight from the click, so the pop-up is allowed.
        const token = await driveToken();
        const result = await completeRequest(requestId, (a) => uploadCompletedPtaa(a, { token }), (s) => {
          stage.textContent = s;
        });
        toast(`${req.ptaaId} completed and filed to Drive as ${result.fileName}.`);
        await load();
      } catch (err) {
        stage.textContent = "";
        const code = err && err.code;
        mount(completionErrors,
          noticeBox("error",
            h("p", {}, h("strong", {}, "Not completed.")),
            h("p", { class: "pre-wrap" }, err.message || friendlyError(err)),
            code ? h("p", { class: "small" }, driveAdvice(code)) : null,
            h("p", { class: "small" },
              "The request is untouched — still at Final check, with no Drive link. ",
              "Nothing is half-done."),
          ));
        toast(err.message || friendlyError(err), "error");
      } finally {
        running = false;
        btn.disabled = blockers.length > 0;
        btn.textContent = "Complete and file to Drive";
      }
    });

    return card("Complete and file",
      h("p", { class: "muted small" },
        "The last step. The document is uploaded to Google Drive first; the PTAA is marked ",
        "completed only if that upload succeeds, so a failure never leaves a PTAA that says ",
        "completed with nothing filed."),

      h("code", { class: "filename" }, generatedFilename()),
      h("p", { class: "muted small" },
        "Goes into ", h("strong", {}, req.propertyName || "the property folder"),
        " under the PTAA root folder in Drive. If that folder does not exist yet it is created; ",
        "an existing folder of the same name is reused, never duplicated."),

      driveNotice(),

      blockers.length
        ? noticeBox("warn",
            h("p", {}, h("strong", {}, "Not ready to complete:")),
            h("ul", { class: "bullets" }, blockers.map(b => h("li", {}, b))))
        : null,

      completionErrors,
      h("div", { class: "actions" }, btn, stage),
    );
  }

  /** What the Drive connection looks like right now, in plain words. */
  function driveNotice() {
    if (drive === undefined) return h("p", { class: "muted small" }, "Checking the Drive connection…");
    if (drive.ok) {
      return h("p", { class: "muted small" },
        "Drive is connected", drive.rootName ? ` (root folder: ${drive.rootName})` : "", ".");
    }
    return noticeBox("warn",
      h("p", {}, h("strong", {},
        drive.code === "drive_disconnected"
          ? "The Google Drive connection has expired."
          : "Google Drive is not connected.")),
      h("p", { class: "small" }, driveAdvice(drive.code)),
      drive.error ? h("p", { class: "small muted" }, drive.error) : null,
    );
  }

  function completedCard() {
    if (req.status !== STATUS.COMPLETED) return null;
    const d = req.drive || {};
    return card("Filed in Google Drive",
      h("dl", { class: "detail-dl" },
        h("dt", {}, "File"), h("dd", {},
          d.webViewLink
            ? h("a", { href: d.webViewLink, target: "_blank", rel: "noopener" }, d.fileName || "Open in Drive")
            : (d.fileName || "—")),
        h("dt", {}, "Folder"), h("dd", {}, d.folderName || "—"),
        h("dt", {}, "Completed"), h("dd", {},
          `${fmtLogTime(req.completedAt)} by ${req.completedBy || "—"}`),
      ),
      h("p", { class: "muted small" },
        "Only the final document is kept in Drive — there are no V1/V2/V3 copies (§11.5). ",
        "The internal revision number is ", String(req.revision || 1), "."),
    );
  }

  function detailView() {
    const o = req.owner || {};
    const t = req.tenancy || {};
    const fin = req.financial || {};
    const a = req.agentSnapshot || {};

    return h("div", {},
      changeRequestCard(),
      card("Status",
        h("div", { class: "status-row" },
          badge(STATUS_LABEL[req.status] || req.status, STATUS_TONE[req.status] || "neutral"),
          h("span", { class: "muted" }, "Current action:"),
          // Brand yellow, and only here: "this one is yours" is the question the
          // whole app exists to answer, so it gets the one colour nothing else uses.
          badge(req.currentAction || ACTOR.NONE,
                isMine() ? "brand" : req.currentAction === ACTOR.NONE ? "neutral" : "info"),
          isOverdue(parseDateInput(req.dueDate), req.status) ? badge("Overdue", "warn") : null,
        ),
        req.status === STATUS.ON_HOLD
          ? h("p", {}, "On hold: ", h("strong", {}, req.holdReason || "—"),
              req.holdNote ? ` — “${req.holdNote}”` : "",
              req.previousStatus ? h("span", { class: "muted small" }, ` (resumes to ${STATUS_LABEL[req.previousStatus]})`) : null)
          : null,
        req.status === STATUS.CANCELLED && req.cancelReason
          ? h("p", {}, "Cancelled: ", h("strong", {}, req.cancelReason))
          : null,
        transitionButtons(),
        isAdmin()
          ? h("div", { class: "actions" },
              h("label", { class: "inline-label", for: "due" }, "Due date"),
              dateInput({ id: "due", value: req.dueDate || "",
                onInput: (e) => act(() => setDueDate(requestId, e.target.value || null)) }),
            )
          : null,
      ),

      completionCard(),
      completedCard(),
      documentCard(),

      card("Owner",
        h("dl", { class: "detail-dl" },
          h("dt", {}, "Name"),    h("dd", {}, o.name || "—"),
          h("dt", {}, "I/C"),     h("dd", {}, o.nric || "—"),
          h("dt", {}, "Phone"),   h("dd", {}, o.phone || "—"),
          h("dt", {}, "Email"),   h("dd", {}, o.email || "—"),
          h("dt", {}, "Address"), h("dd", {}, o.address || "—"),
          h("dt", {}, "Bank"),    h("dd", {}, o.bankName || "—"),
          h("dt", {}, "Account"), h("dd", {}, o.accountNumber || "—"),
        ),
        h("p", { class: "muted small" },
          "The bank details go into the rent-payment clause, so they are part of the agreement."),
      ),

      card("Property and tenancy",
        h("dl", { class: "detail-dl" },
          h("dt", {}, "Property"),     h("dd", {}, req.propertyName || "—"),
          h("dt", {}, "Unit"),         h("dd", {}, req.unitNo || "—"),
          h("dt", {}, "Type"),         h("dd", {}, req.ptaaType || "—"),
          h("dt", {}, "Size"),         h("dd", {}, req.propertySize ? `${req.propertySize} sq ft` : "—"),
          h("dt", {}, "Address"),      h("dd", {}, req.propertyAddress || "—"),
          h("dt", {}, "Initial term"), h("dd", {}, t.initialTermMonths ? `${t.initialTermMonths} months` : "—"),
          h("dt", {}, "Commences"),    h("dd", {}, t.commencementDate ? fmtDate(parseDateInput(t.commencementDate)) : "—"),
          h("dt", {}, "Expires"),      h("dd", {}, t.expiryDate ? fmtDate(parseDateInput(t.expiryDate)) : "—"),
          h("dt", {}, "Admin fee"),    h("dd", {}, fmtPercent(fin.monthlyAdminFeePercent)),
          h("dt", {}, "Renovation"),   h("dd", {}, (fin.renovationCost == null || fin.renovationCost === "" ? "NIL" : fmtMoney(fin.renovationCost))),
        ),
      ),

      utilitiesDetailCard(),

      card("Special terms",
        (req.specialTerms || []).length
          ? h("ol", { class: "bullets" }, req.specialTerms.map(s => h("li", {}, s)))
          : h("p", { class: "empty" }, "None."),
      ),

      req.notes ? card("Notes from the agent", h("p", { class: "pre-wrap" }, req.notes)) : null,

      card("Sales Agent",
        h("dl", { class: "detail-dl" },
          h("dt", {}, "Account"),   h("dd", {}, req.agentEmail || "—"),
          h("dt", {}, "Full name"), h("dd", {}, a.fullName || "—"),
          h("dt", {}, "NRIC"),      h("dd", {}, a.nric || "—"),
          h("dt", {}, "Mobile"),    h("dd", {}, a.phone || "—"),
          h("dt", {}, "Nickname"),  h("dd", {}, a.nickname || "—"),
        ),
        h("p", { class: "muted small" },
          `Recorded from profile version ${a.profileVersion || 0} when the request was submitted. `,
          "A later profile edit does not change these."),
      ),

      req.adminSnapshot
        ? card("PTAA Admin (witness)",
            h("dl", { class: "detail-dl" },
              h("dt", {}, "Account"),   h("dd", {}, req.adminSnapshot.email || "—"),
              h("dt", {}, "Full name"), h("dd", {}, req.adminSnapshot.fullName || "—"),
              h("dt", {}, "NRIC"),      h("dd", {}, req.adminSnapshot.nric || "—"),
              h("dt", {}, "Mobile"),    h("dd", {}, req.adminSnapshot.phone || "—"),
            ),
            h("p", { class: "muted small" },
              "Recorded when the document was generated — these details appear in the second ",
              "witness block. Regenerating replaces them with whoever generates it next."),
          )
        : null,

      signatureCard(),
      signaturesCard(),
      checklistCard(),
      attachmentsCard(),
      historyCard(),
    );
  }

  // --- Signatures (brief §9.2, §10) ---------------------------------------

  function signaturesCard() {
    const s = req.signatories || {};
    const summary = signatureSummary(s);

    const rows = SIGNATORY_TYPES.map(t => {
      const entry = s[t.key] || {};
      const status = entry.status || SIGNATORY_STATUS.NOT_REQUIRED;
      const setTo = (next) => () => act(async () => {
        await setSignatory(requestId, t.key, next);
        toast(`${t.label}: ${SIGNATORY_STATUS_LABEL[next].toLowerCase()}.`);
      });

      return [
        h("div", {}, h("strong", {}, t.label),
          h("p", { class: "muted small" }, t.note)),
        badge(SIGNATORY_STATUS_LABEL[status], SIGNATORY_TONE[status]),
        entry.requestedAt ? fmtDate(entry.requestedAt) : h("span", { class: "muted" }, "—"),
        entry.signedAt ? fmtDate(entry.signedAt) : h("span", { class: "muted" }, "—"),
        isAdmin()
          ? h("div", { class: "row-actions" },
              status === SIGNATORY_STATUS.NOT_REQUIRED
                ? button("Mark required", { variant: "quiet", onClick: setTo(SIGNATORY_STATUS.REQUIRED) })
                : null,
              status === SIGNATORY_STATUS.REQUIRED
                ? button("Mark requested", { variant: "quiet", onClick: setTo(SIGNATORY_STATUS.REQUESTED) })
                : null,
              status !== SIGNATORY_STATUS.SIGNED && status !== SIGNATORY_STATUS.NOT_REQUIRED
                ? button("Record signature", { variant: "quiet", onClick: setTo(SIGNATORY_STATUS.SIGNED) })
                : null,
              status !== SIGNATORY_STATUS.NOT_REQUIRED
                ? button("Not required", { variant: "quiet-danger", onClick: setTo(SIGNATORY_STATUS.NOT_REQUIRED) })
                : null,
            )
          : h("span", { class: "muted" }, "—"),
      ];
    });

    return card("Signatures",
      h("p", {},
        summary.anyRequired
          ? h("span", {}, h("strong", {}, `${summary.done} of ${summary.total} recorded.`), " ", summary.text)
          : h("span", { class: "muted" }, "No signatures required on this PTAA yet."),
      ),
      h("p", { class: "muted small" },
        "Each signatory is tracked separately — not every PTAA needs the same people."),
      table(["Signatory", "Status", "Requested", "Signed", ""], rows),
      isAdmin()
        ? h("p", { class: "muted small" },
            "This table tracks whether a signature has been obtained. Placing the actual ",
            "image into the Word file is a separate, deliberate step under ",
            h("strong", {}, "Signature images"), " above — nothing is inserted automatically (§10).")
        : null,
    );
  }

  // --- Final checklist (brief §11.1) --------------------------------------

  function checklistCard() {
    const cl = req.finalChecklist || {};
    const progress = checklistProgress(cl);
    const blockers = checklistBlockers(req);

    const items = CHECKLIST.map(item => {
      const entry = cl[item.key];
      const blocked = blockers[item.key];
      const box = h("input", {
        type: "checkbox", id: "cl-" + item.key, class: "check",
        disabled: !isAdmin() || CLOSED_STATUSES.includes(req.status) || (!entry && !!blocked),
      });
      box.checked = !!(entry && entry.checked);
      box.addEventListener("change", () => act(async () => {
        await setChecklistItem(requestId, item.key, box.checked);
      }));

      return h("li", { class: "check-row" + (entry ? " done" : "") },
        box,
        h("label", { for: "cl-" + item.key },
          item.label,
          entry ? h("span", { class: "muted small" }, ` — ${fmtLogTime(entry.at)} by ${entry.by || "—"}`) : null,
          blocked && !entry ? h("span", { class: "check-block" }, blocked) : null,
        ),
      );
    });

    return card(`Final checklist (${progress.done} of ${progress.total})`,
      h("p", { class: "muted small" },
        "Every line must be confirmed before a PTAA can be completed. ",
        "Editing the request data clears these, because a confirmation about information ",
        "that has since changed is not a confirmation."),
      h("ul", { class: "checklist" }, items),

      progress.complete
        ? h("p", { class: "muted small" },
            "Every line is confirmed. Completing still depends on the Google Drive upload ",
            "succeeding — see ", h("strong", {}, "Complete and file"), " above. Rule #6: a PTAA ",
            "is not completed unless the upload actually happened, and the database rules ",
            "refuse the change without a Drive file id.")
        : h("p", { class: "muted small" },
            `${progress.outstanding.length} still to confirm: `,
            progress.outstanding.map(i => i.label).join(", "), "."),
    );
  }

  /** Schedule items 11, 12 and 13, as they will read in the agreement. */
  function utilitiesDetailCard() {
    const by = utilitiesByParty(req.utilities);
    const rows = [
      { party: UTILITY_PARTY.OWNER,    heading: "Borne by the Owner" },
      { party: UTILITY_PARTY.ADVANCED, heading: "Advanced by us, recovered from the rental" },
      { party: UTILITY_PARTY.TENANT,   heading: "Borne by the Tenant" },
    ].map(r => [
      h("div", {},
        h("strong", {}, r.heading),
        h("p", { class: "muted small" }, UTILITY_PARTY_LABEL[r.party])),
      by[r.party].length
        ? h("ul", { class: "util-list" }, by[r.party].map(l => h("li", {}, l)))
        : h("span", { class: "muted" }, "NIL"),
    ]);

    return card("Utilities and services",
      table(["Schedule row", "Items"], rows),
      by.none.length
        ? h("p", { class: "muted small" },
            "Marked not applicable: ", by.none.join(", "), ".")
        : null,
      req.ptaaType === "WUR"
        ? h("p", { class: "muted small" },
            "This is a Whole Unit Rental, so Cleaning Services default to the Tenant.")
        : null,
    );
  }

  function changeRequestCard() {
    const cr = req.openChangeRequest;
    if (!cr) return null;
    return noticeBox("warn",
      h("p", {}, h("strong", {}, "The Owner has asked for a change.")),
      h("p", { class: "pre-wrap" }, cr.text),
      h("p", { class: "muted small" },
        `Raised by ${cr.by || "the Sales Agent"} on ${fmtLogTime(cr.at)}. `,
        "Edit the request, then mark it PTAA OK again — that clears this note."),
    );
  }

  // --- The Word document (phases 4 and 5) ---------------------------------

  function generatedFilename() {
    return ptaaFilename({
      propertyName: req.propertyName, unitNo: req.unitNo,
      ownerName: (req.owner || {}).name,
    });
  }

  // --- Signature slots ----------------------------------------------------

  const SIG_SLOTS = [
    { key: "sig_director", label: "Director",
      note: "Signs for The Blank Company. Usually the stored company signature." },
    { key: "sig_agent", label: "Sales Agent",
      note: "The agent who raised this request, if they have uploaded one." },
    { key: "sig_admin", label: "PTAA Admin (witness)",
      note: "Whoever prepares the document — their details go in the witness block." },
  ];

  function sigLabel(key) {
    const s = signatures.find(x => x.id === key);
    return s ? (s.label || s.id) : null;
  }

  /** Bytes are fetched once per signature, then reused for preview and render. */
  async function signatureBytes(key) {
    if (!key) return null;
    if (sigBytes.has(key)) return sigBytes.get(key);
    const bytes = await loadSignatureBytes(key);
    sigBytes.set(key, bytes);
    return bytes;
  }

  async function previewUrl(key) {
    if (sigPreview.has(key)) return sigPreview.get(key);
    const bytes = await signatureBytes(key);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    sigPreview.set(key, url);
    return url;
  }

  function signatureCard() {
    if (!isAdmin()) return null;
    const host = h("div", { class: "sig-slots" });

    function renderSlots() {
      const rows = SIG_SLOTS.map(slot => {
        const chosen = (sigChoice && sigChoice[slot.key]) || "";
        const img = h("img", { class: "sig-preview", alt: "" });
        const shell = h("div", { class: "sig-preview-shell" },
          chosen ? img : h("span", { class: "muted small" }, "Left blank"));

        if (chosen) {
          previewUrl(chosen)
            .then(url => { if (url) img.src = url; })
            .catch(() => { shell.replaceChildren(
              h("span", { class: "muted small" }, "Preview unavailable")); });
        }

        return h("div", { class: "sig-slot" },
          h("div", {},
            h("strong", {}, slot.label),
            h("p", { class: "muted small" }, slot.note),
            select({
              id: "sig-" + slot.key,
              value: chosen,
              options: [
                { value: "", label: "— leave blank —" },
                ...signatures.map(s => ({
                  value: s.id,
                  label: (s.label || s.id) + (s.isDirector ? " (Director)" : ""),
                })),
              ],
              onChange: (e) => { sigChoice[slot.key] = e.target.value; renderSlots(); },
            }),
          ),
          shell,
        );
      });
      host.replaceChildren(...rows);
    }
    renderSlots();

    return card("Signature images",
      signatures.length
        ? h("p", { class: "muted small" },
            "Chosen here, placed only when you generate — never automatically (§10). ",
            "Whoever you pick is written to the history below.")
        : noticeBox("warn",
            h("p", {}, "No signature images have been uploaded yet."),
            h("p", { class: "small" },
              "Add the Director's under ", h("strong", {}, "Signatures"),
              ", and your own on your ", h("strong", {}, "Profile"),
              ". Until then the document generates with the signature lines empty, ",
              "which is fine if it is going to be signed on paper.")),
      signatures.length ? host : null,
    );
  }

  /** The admin's own details go into the witness block, so they must be there. */
  function adminProfileBlocker() {
    if (!isAdmin()) return "Only a PTAA Admin can generate the document.";
    if (!profileComplete()) {
      return "Your own profile is incomplete. The document records the admin who " +
             "prepared it in the witness block, so your full name, I/C and mobile " +
             "are needed first — fill them in under Profile.";
    }
    return null;
  }

  async function generate() {
    const filename = generatedFilename();
    try {
      const blocker = adminProfileBlocker();
      if (blocker) { toast(blocker, "error"); return; }

      // §5.4 / criterion #17: regenerating over manual edits destroys them.
      if (req.manuallyEdited) {
        const ok = confirmAction(
          `${req.ptaaId} has a manually edited document.\n\n` +
          `Regenerating from the template will REPLACE it, and every edit made in Word ` +
          `— reworded clauses, anything typed by hand — will be lost. The request data is not affected.\n\n` +
          `Replace the edited document?`);
        if (!ok) return;
        await clearManualEditFlag(requestId);
      }

      const bytes = await loadEffectiveTemplateBytes(req.propertyId);
      if (!bytes) {
        toast("No PTAA template has been uploaded yet — add it under Settings.", "error");
        return;
      }

      // The admin who presses this button is the one named in the document.
      const profile = (session.record && session.record.profile) || {};
      const adminSnapshot = {
        email: session.email,
        fullName: profile.fullName || "", nric: profile.nric || "",
        phone: profile.phone || "", nickname: profile.nickname || "",
        profileVersion: profile.version || 0,
      };
      const property = properties.find(p => p.id === req.propertyId) || null;
      const reqForDoc = { ...req, adminSnapshot };

      const missing = emptyRequiredValues(buildTemplateData(reqForDoc, { property }));
      if (missing.length) {
        const ok = confirmAction(
          `These fields are empty and will appear blank in the document:\n\n` +
          missing.map(m => "  " + m).join("\n") +
          `\n\nGenerate anyway?`);
        if (!ok) return;
      }

      // §10: a signature is placed only after it has been named and confirmed.
      // Solo: never on the draft — the Director signs after the Owner, on the
      // PDF (Sign PDF).
      const chosen = solo ? [] : SIG_SLOTS
        .map(s => ({ slot: s, key: (sigChoice && sigChoice[s.key]) || "" }))
        .filter(x => x.key);
      if (chosen.length) {
        const ok = confirmAction(
          `These signature images will be placed into ${req.ptaaId}:\n\n` +
          chosen.map(c => `  ${c.slot.label}: ${sigLabel(c.key) || c.key}`).join("\n") +
          `\n\nOnly place a signature you have been authorised to place.\n\nContinue?`);
        if (!ok) return;
      }

      const sigData = {};
      for (const c of chosen) {
        const b = await signatureBytes(c.key);
        if (!b) { toast(`The signature “${sigLabel(c.key) || c.key}” could not be read.`, "error"); return; }
        sigData[c.slot.key] = { bytes: b, name: c.key, label: sigLabel(c.key) || c.key };
      }

      // The agent's three supporting files go in as pictures too: the I/C onto
      // its own page, the quotation into Appendix A. Stored as data URLs, so
      // they only need decoding — the PDF was already rendered at attach time.
      const attachmentImages = {};
      for (const slot of ATTACHMENT_SLOTS) {
        // Solo: Appendix A of the Word file stays empty — the invoice goes in
        // only when the complete PDF is put together (step 6).
        if (solo && slot.key === "quotation") continue;
        const files = attachments
          .filter(a => a.kind === slot.key && a.dataUrl)
          .sort((x, y) => (x.page || 1) - (y.page || 1));
        if (!files.length) continue;
        attachmentImages[slot.tag] = {
          name: slot.label,
          pages: files.map(f => ({ bytes: dataUrlToBytes(f.dataUrl), name: f.name })),
        };
      }

      const result = await generateDocx(bytes, reqForDoc, {
        property, signatures: sigData, attachments: attachmentImages,
      });
      downloadBlob(result.blob, filename);

      const buf = await result.blob.arrayBuffer();
      await setAdminSnapshot(requestId, profile);
      await saveWorkingDocument(requestId, {
        fileName: filename, bytes: new Uint8Array(buf), source: "generated",
      });

      const placed = result.signatures && result.signatures.placed || [];
      const applied = {};
      for (const slot of placed) if (sigData[slot]) applied[slot] = sigData[slot];
      await logSignaturesApplied(requestId, applied);

      const skipped = chosen.filter(c => !placed.includes(c.slot.key));
      if (skipped.length) {
        toast(`Document generated, but the template has no place for: ` +
              skipped.map(c => c.slot.label).join(", ") + ".", "warn");
      } else {
        const n = Object.keys(applied).length;
        toast(n
          ? `Document generated with ${n} signature${n > 1 ? "s" : ""}.`
          : "Document generated and downloaded.");
      }
      await load();
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    }
  }

  async function downloadWorking() {
    try {
      const wd = await loadWorkingDocument(requestId);
      if (!wd) { toast("No document stored yet.", "warn"); return; }
      downloadBlob(new Blob([wd.bytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }), wd.meta.fileName || generatedFilename());
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function uploadEdited(file) {
    if (!looksLikeDocx(file)) { toast("That is not a .docx file.", "error"); return; }
    if (!confirmAction(
      `Replace the document for ${req.ptaaId} with “${file.name}”?\n\n` +
      `It will be recorded as manually edited, and regenerating from the template will then ` +
      `require an explicit confirmation.`)) return;
    try {
      const buf = await readFileAsArrayBuffer(file);
      await saveWorkingDocument(requestId, {
        fileName: generatedFilename(),        // §11.3 — the name is never typed
        bytes: new Uint8Array(buf), source: "uploaded",
      });
      toast("Edited document saved.");
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function documentCard() {
    const wd = req.workingDoc;
    const filename = generatedFilename();
    const editInput = h("input", {
      type: "file", accept: ".docx", class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadEdited(f); },
    });

    return card("Document",
      h("code", { class: "filename" }, filename),
      h("p", { class: "muted small" },
        "Generated automatically from the property's template. The filename is never typed."),

      templateMeta === undefined
        ? loading("Checking the template…")
        : templateMeta === null
          ? noticeBox("warn",
              h("p", {}, "No template is registered for ", h("strong", {}, req.propertyName || "this property"), "."),
              h("p", { class: "small" },
                isAdmin()
                  ? "Upload one under Templates. Until then no document can be produced for this property."
                  : "An admin needs to register one before the document can be produced."))
          : h("p", { class: "muted small" },
              "Template: ", h("code", {}, templateMeta.fileName),
              ` (v${templateMeta.version || 1}, uploaded ${fmtLogTime(templateMeta.uploadedAt)}).`),

      wd
        ? h("div", {},
            h("dl", { class: "detail-dl" },
              h("dt", {}, "Current document"), h("dd", {}, wd.fileName),
              h("dt", {}, "Source"), h("dd", {},
                wd.source === "uploaded"
                  ? badge("Manually edited", "warn")
                  : badge("Generated from template", "ok")),
              h("dt", {}, "Saved"), h("dd", {}, `${fmtLogTime(wd.savedAt)} by ${wd.savedBy || "—"}`),
              h("dt", {}, "Revision"), h("dd", {}, String(req.revision || 1)),
            ),
            req.manuallyEdited
              ? noticeBox("warn",
                  h("p", {}, "This document has been edited by hand."),
                  h("p", { class: "small" },
                    "Regenerating from the template would discard those edits, so it now asks first. ",
                    "Only the current document is kept — there are no V1/V2/V3 copies."))
              : null,
          )
        : h("p", { class: "empty" }, "No document has been produced yet."),

      h("div", { class: "actions" },
        editInput,
        isAdmin() && templateMeta
          ? button(wd ? "Regenerate from template" : "Generate document", {
              variant: wd ? "default" : "primary", onClick: generate,
              title: req.manuallyEdited ? "Will ask before discarding the manual edits." : null,
            })
          : null,
        wd ? button("Download", { variant: wd && isAdmin() ? "quiet" : "primary", onClick: downloadWorking }) : null,
        isAdmin() && wd
          ? button("Upload edited version", { variant: "quiet", onClick: () => editInput.click() })
          : null,
      ),

      isAdmin()
        ? h("p", { class: "muted small" },
            "To reword a clause: download, edit in Word, then upload it back here. ",
            "Structured data — dates, fees, owner details — should be changed under ",
            h("strong", {}, "Edit details"), " and regenerated instead.")
        : null,
    );
  }

  /**
   * Three named slots, not a gallery.
   *
   * Each of these has a specific place in the finished agreement — the I/C on
   * the page before Appendix A, the quotation inside Appendix A — so the app has
   * to know which photograph is which. A pile of unlabelled images cannot be
   * put anywhere automatically, which is what the old free-for-all produced.
   */
  function attachmentsCard() {
    const bySlot = new Map();
    for (const a of attachments) {
      if (!bySlot.has(a.kind)) bySlot.set(a.kind, []);
      bySlot.get(a.kind).push(a);
    }
    // Multi-page quotations keep their order.
    for (const list of bySlot.values()) list.sort((x, y) => (x.page || 1) - (y.page || 1));

    const missing = missingAttachments(attachments, {
      renovationCost: (req.financial || {}).renovationCost,
    });

    return card("Supporting files",
      h("p", { class: "muted small" },
        "The I/C goes onto its own page in the agreement; the quotation fills in the invoice. ",
        "These copies are working material and are cleared once the PTAA is done."),

      missing.length
        ? noticeBox("warn",
            h("p", {}, h("strong", {}, "Still needed: "),
              missing.map(m => m.label).join(", "), "."))
        : null,

      h("div", { class: "slots" }, ATTACHMENT_SLOTS.map(slot =>
        attachmentSlot(slot, bySlot.get(slot.key) || []))),

      isAdmin() && attachments.length
        ? h("div", { class: "actions" },
            button("Delete all supporting files", { variant: "quiet-danger",
              onClick: () => act(async () => {
                if (!confirmAction(
                  `Delete all supporting files for ${req.ptaaId}?\n\n` +
                  `Any document already generated keeps its copy of the images. ` +
                  `This cannot be undone.`)) return;
                const n = await deleteAllAttachments(requestId);
                toast(`${n} file${n === 1 ? "" : "s"} deleted.`);
              }) }))
        : null,
    );
  }

  function attachmentSlot(slot, files) {
    const busy = h("span", { class: "muted small" });
    const pick = h("input", {
      type: "file", accept: slot.accept, class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) attachTo(slot, f, busy); },
    });
    const camera = h("input", {
      type: "file", accept: "image/*", capture: "environment", class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) attachTo(slot, f, busy); },
    });
    const both = slot.key !== "ic_front" ? null : h("input", {
      type: "file", accept: "image/*,application/pdf", class: "visually-hidden", "data-both": "1",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) attachBothSides(f, busy); },
    });
    const bothInFront = attachments.some(a => a.kind === "ic_front" && a.bothSides);
    const haveFront = attachments.some(a => a.kind === "ic_front");
    const haveBack = attachments.some(a => a.kind === "ic_back");

    return h("div", { class: "slot" },
      h("div", { class: "slot-head" },
        h("strong", {}, slot.label),
        files.length ? badge(files.length > 1 ? `${files.length} pages` : "Attached", "ok")
                     : slot.key === "ic_back" && bothInFront ? badge("In the front picture", "ok")
                     : badge("Not attached", "off")),
      h("p", { class: "muted small" }, slot.where),
      slot.note ? h("p", { class: "muted small" }, slot.note) : null,
      !files.length && slot.key === "ic_back" && bothInFront ? backCoveredNote() : null,

      files.length
        ? h("div", { class: "thumbs" }, files.map(at =>
            h("figure", { class: "thumb" },
              h("a", { href: at.dataUrl, target: "_blank", rel: "noopener" },
                h("img", { src: at.dataUrl, alt: at.name })),
              h("figcaption", {},
                h("span", { class: "small" },
                  at.page ? `Page ${at.page}` : at.name),
                h("span", { class: "muted small" }, fmtBytes(at.bytes)),
                canEdit()
                  ? button("Remove", { variant: "quiet-danger",
                      onClick: () => act(async () => {
                        if (!confirmAction(`Remove “${at.name}”?`)) return;
                        await deleteAttachment(requestId, at.id, at.name);
                      }) })
                  : null,
              ))))
        : slot.key === "ic_back" && bothInFront ? null : h("p", { class: "empty" }, "Nothing attached."),

      canEdit()
        ? h("div", { class: "actions" },
            pick, camera, both,
            button(files.length ? "Replace" : "Choose file", { onClick: () => pick.click() }),
            slot.camera ? button("Take photo", { variant: "quiet", onClick: () => camera.click() }) : null,
            slot.key === "ic_front"
              ? button("Both sides in one file", { variant: "quiet", title: "One photo, scan or PDF with the front and the back",
                  onClick: () => both.click() })
              : null,
            slot.key === "ic_back" && haveFront && haveBack
              ? button("Swap front and back", { variant: "quiet", onClick: () => act(swapStoredIcSides) })
              : null,
            busy)
        : null,
    );
  }

  const icRecord = (a, kind) => ({ kind, name: a.name, dataUrl: a.dataUrl, bytes: a.bytes,
    width: a.width, height: a.height, page: null, bothSides: kind === "ic_front" && !!a.bothSides });

  /** One file with both sides of the I/C: cut into front and back and store both. */
  async function attachBothSides(file, busy) {
    const existing = attachments.filter(a => a.kind === "ic_front" || a.kind === "ic_back");
    if (existing.length && !confirmAction("Replace the I/C pictures that are already attached?")) return;
    try {
      busy.textContent = "Finding the front and the back…";
      const res = await prepareIcBothSides(file);
      for (const old of existing) await deleteAttachment(requestId, old.id, old.name, { silent: true });
      await addAttachment(requestId, icRecord({ ...res.front, name: res.front.originalName, bothSides: res.how === "whole" }, "ic_front"));
      if (res.back) await addAttachment(requestId, icRecord({ ...res.back, name: res.back.originalName }, "ic_back"));
      toast(bothSidesMessage(res.how), res.how === "whole" ? "warn" : "ok");
      await load();
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally {
      busy.textContent = "";
    }
  }

  async function swapStoredIcSides() {
    const front = attachments.find(a => a.kind === "ic_front");
    const back = attachments.find(a => a.kind === "ic_back");
    if (!front || !back) return;
    await deleteAttachment(requestId, front.id, front.name, { silent: true });
    await deleteAttachment(requestId, back.id, back.name, { silent: true });
    await addAttachment(requestId, icRecord(back, "ic_front"));
    await addAttachment(requestId, icRecord(front, "ic_back"));
    toast("Front and back swapped.");
  }

  /**
   * Attach one file to one slot. A PDF is rendered to images here, at attach
   * time, so what is stored is exactly what will go into the agreement.
   */
  async function attachTo(slot, file, busy) {
    const existing = attachments.filter(a => a.kind === slot.key);
    if (existing.length && !confirmAction(
      `Replace the ${slot.label.toLowerCase()} that is already attached?`)) return;

    try {
      busy.textContent = "Reading…";
      let prepared;
      if (isPdfFile(file)) {
        if (slot.key !== "quotation") {
          throw new Error(`${slot.label} must be a photo, not a PDF.`);
        }
        prepared = await preparePdf(file, (done, total) => {
          busy.textContent = done < total
            ? `Reading page ${done + 1} of ${total}…`
            : "Storing…";
        });
        if (prepared.truncatedFrom) {
          toast(`That PDF has ${prepared.truncatedFrom} pages; only the first ` +
                `${prepared.length} were attached.`, "warn");
        }
        if (solo) {
          busy.textContent = "Reading the items…";
          const parsed = await readQuotation(file);
          if (parsed) await saveQuotationParse(requestId, parsed);
        }
      } else {
        prepared = [await prepareImage(file)];
        if (solo && slot.key === "quotation" && req.quotation) await saveQuotationParse(requestId, null);
      }

      // Remove what was there first, so a two-page quotation never mixes with
      // the leftover pages of a five-page one.
      for (const old of existing) {
        await deleteAttachment(requestId, old.id, old.name, { silent: true });
      }

      let n = 0;
      for (const img of prepared) {
        busy.textContent = `Storing ${++n} of ${prepared.length}…`;
        await addAttachment(requestId, {
          kind: slot.key,
          name: img.originalName || file.name,
          dataUrl: img.dataUrl, bytes: img.bytes,
          width: img.width, height: img.height,
          page: img.page || null,
        });
      }
      toast(`${slot.label} attached${prepared.length > 1 ? ` (${prepared.length} pages)` : ""}.`);
      await load();
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally {
      busy.textContent = "";
    }
  }

  function historyCard() {
    return card("History",
      activity.length === 0
        ? h("p", { class: "empty" }, "Nothing recorded yet.")
        : h("ol", { class: "log" }, activity.map(e => h("li", { class: "log-row" },
            h("span", { class: "log-time" }, fmtLogTime(e.at)),
            h("span", { class: "log-actor" }, e.actorEmail || "—"),
            h("span", { class: "log-text" }, e.summary || e.action || ""),
          ))),
      h("p", { class: "muted small" }, "Append-only. Nothing here can be edited or removed."),
    );
  }

  function editView() {
    const draft = draftFromRequest(req);
    const form = buildRequestForm({ draft, properties, prefix: "ed", onChange: () => refreshEdit(),
      showTenancy: !agentMode, showSpecialTerms: !agentMode });
    const errorHost = h("div", {});
    const saveBtn = button("Save changes", { variant: "primary", onClick: save });
    let showAll = false, saving = false;

    function refreshEdit() {
      const result = validateRequestDraft(draft);
      applyValidation(form.fields, result, { showAll });
      saveBtn.disabled = saving || !result.ok;
      saveBtn.textContent = saving ? "Saving…" : "Save changes";
      return result;
    }

    async function save() {
      showAll = true;
      const result = refreshEdit();
      if (!result.ok || saving) { if (!result.ok) toast("Some fields still need attention.", "warn"); return; }
      saving = true; mount(errorHost); refreshEdit();
      try {
        const value = !agentMode ? result.value
          // The tenancy period and special terms are the admin's; an agent's
          // edit carries them over exactly as they were.
          : { ...result.value, tenancy: req.tenancy || result.value.tenancy,
              specialTerms: req.specialTerms || [] };
        await saveRequestData(requestId, value);
        toast("Changes saved.");
        editing = false;
        await load();
      } catch (err) {
        const msg = friendlyError(err);
        mount(errorHost, errorBox(msg));
        toast(msg, "error");
      } finally { saving = false; refreshEdit(); }
    }

    setTimeout(refreshEdit, 0);
    return h("div", {},
      noticeBox("info", h("p", {},
        "Editing the request data. Every change is recorded in the history below.")),
      form.node,
      errorHost,
      h("div", { class: "form-actions" },
        saveBtn,
        button("Cancel", { variant: "quiet", onClick: () => { editing = false; render(); } }),
      ),
    );
  }

  // =========================================================================
  // The Sales Agent's view (solo workflow)
  // =========================================================================

  function agentView() {
    const o = req.owner || {};
    const t = req.tenancy || {};
    const fin = req.financial || {};
    const st = agentStage(req);
    const by = utilitiesByParty(req.utilities);
    const lines = (items) => items.length
      ? h("ul", { class: "util-list" }, items.map(l => h("li", {}, l)))
      : h("span", { class: "muted" }, "NIL");

    return h("div", {},
      card("Status",
        h("div", { class: "status-row" }, badge(st.label, st.tone), h("span", { class: "muted" }, st.note)),
        req.status === STATUS.CANCELLED && req.cancelReason
          ? h("p", {}, "Reason: ", h("strong", {}, req.cancelReason)) : null,
        req.finalPdf
          ? h("div", {},
              h("p", { class: "muted small" }, `${req.finalPdf.fileName} — sent ${fmtLogTime(req.finalPdf.sharedAt)}.`),
              h("div", { class: "actions" },
                button("Download the PTAA (PDF)", { variant: "primary", onClick: downloadFinal })))
          : st === AGENT_STAGES.CANCELLED ? null
          : h("p", { class: "muted small" },
              "The PDF appears here once the admin sends it. You will also get a notification."),
        canEdit()
          ? h("p", { class: "muted small" },
              "You can still change the details until the admin starts preparing it — use “Edit details” above.")
          : null,
      ),
      card("Owner",
        h("dl", { class: "detail-dl" },
          h("dt", {}, "Name"),    h("dd", {}, o.name || "—"),
          h("dt", {}, "I/C"),     h("dd", {}, o.nric || "—"),
          h("dt", {}, "Phone"),   h("dd", {}, o.phone || "—"),
          h("dt", {}, "Email"),   h("dd", {}, o.email || "—"),
          h("dt", {}, "Address"), h("dd", {}, o.address || "—"),
          h("dt", {}, "Bank"),    h("dd", {}, [o.bankName, o.accountNumber].filter(Boolean).join(" · ") || "—"),
        )),
      card("Property",
        h("dl", { class: "detail-dl" },
          h("dt", {}, "Condo"),       h("dd", {}, req.propertyName || "—"),
          h("dt", {}, "Unit"),        h("dd", {}, req.unitNo || "—"),
          h("dt", {}, "Type"),        h("dd", {}, req.ptaaType || "—"),
          h("dt", {}, "Size"),        h("dd", {}, req.propertySize ? `${req.propertySize} sq ft` : "—"),
          h("dt", {}, "Address"),     h("dd", {}, req.propertyAddress || "—"),
          h("dt", {}, "Tenancy"),     h("dd", {}, t.commencementDate
            ? `${t.initialTermMonths ? t.initialTermMonths + " months, " : ""}${fmtDate(parseDateInput(t.commencementDate))} – ${t.expiryDate ? fmtDate(parseDateInput(t.expiryDate)) : "—"}`
            : h("span", { class: "muted" }, "Set by the admin")),
          h("dt", {}, "Admin fee"),   h("dd", {}, fmtPercent(fin.monthlyAdminFeePercent)),
          h("dt", {}, "Renovation"),  h("dd", {}, (fin.renovationCost == null || fin.renovationCost === "" ? "NIL" : fmtMoney(fin.renovationCost))),
        )),
      card("Utilities",
        table(["Schedule row", "Items"], [
          [h("strong", {}, "11 · Paid by the Owner"), lines(by.owner)],
          [h("strong", {}, "12 · Advanced by us, recovered from rent"), lines(by.advanced)],
          [h("strong", {}, "13 · Paid by the Tenant"), lines(by.tenant)],
        ])),
      req.notes ? card("Your notes for the admin", h("p", { class: "pre-wrap" }, req.notes)) : null,
      attachmentsCard(),
    );
  }

  function render() {
    const stage = solo ? soloStage(req) : agentMode ? agentStage(req) : null;
    mount(root,
      h("div", { class: "detail-head" },
        h("div", {},
          h("h1", { class: "screen-title" }, req.ptaaId, " ",
            stage ? badge(stage.label, stage.tone) : null),
          h("p", { class: "screen-sub" },
            solo || agentMode ? "" : [REQUEST_TYPE_LABEL[req.type] || req.type, " · "],
            req.propertyName || "—", " ", req.unitNo || "", " · ",
            (req.owner || {}).name || "—"),
        ),
        h("div", { class: "actions" },
          !editing && canEdit() && !(solo && req.status === STATUS.CANCELLED)
            ? button("Edit details", { onClick: () => { editing = true; render(); } })
            : null,
          button("Back", { variant: "quiet", onClick: () => navigate(solo || agentMode ? "dashboard" : "requests") }),
        ),
      ),
      editing ? editView() : (solo ? soloView() : agentMode ? agentView() : detailView()),
    );
  }

  // =========================================================================
  // Solo workflow (config.js → workflow.solo)
  // =========================================================================

  const SOLO_STEPS = [
    "Details and files", "Draft PTAA and invoice", "Edit and print", "Upload confirmed", "File to Drive",
  ];

  function soloStepper(stage) {
    const current = stage.step;
    return h("ol", { class: "stepper" }, SOLO_STEPS.map((label, i) => {
      const n = i + 1;
      const cls = n < current || stage.key === "filed" ? "done" : n === current ? "now" : "";
      return h("li", { class: "step " + cls }, h("span", { class: "step-n" }, String(n)), h("span", {}, label));
    }));
  }

  function soloView() {
    const stage = soloStage(req);
    const cancelled = req.status === STATUS.CANCELLED;
    return h("div", {},
      cancelled
        ? noticeBox("warn", h("p", {}, h("strong", {}, "Cancelled"), req.cancelReason ? ` — ${req.cancelReason}` : ""))
        : soloStepper(stage),
      soloDetailsCard(),
      attachmentsCard(),
      soloPtaaCard(),
      invoiceSection(),
      soloPrintCard(),
      soloConfirmCard(),
      soloFileCard(),
      soloPdfCard(),
      soloShareCard(),
      historyCard(),
    );
  }

  /** The invoice, or — for a PTAA without one — a note saying so. */
  function invoiceSection() {
    if (noInvoice(req)) {
      return card("Invoice",
        h("p", {}, badge("No invoice", "neutral"), " This PTAA goes ahead without an invoice. ",
          "It is filed and completed with the agreement only."),
        req.status === STATUS.CANCELLED ? null : h("div", { class: "actions" },
          button("An invoice is needed after all", { variant: "quiet",
            onClick: () => act(async () => { await setNoInvoice(requestId, false); toast("Invoice back on."); }) })));
    }
    if (!settings) return errorBox("The settings could not be read.", load);
    return h("div", {},
      costClash(req)
        ? noticeBox("warn", h("p", {}, h("strong", {}, "Check the total: "), costClashText(costClash(req))))
        : null,
      invoiceCard({ req, settings, onSaved: load }),
      req.status === STATUS.CANCELLED || req.status === STATUS.COMPLETED ? null : h("p", { class: "muted small" },
        "Nothing to invoice? ",
        button("No invoice for this PTAA", { variant: "link",
          onClick: () => act(async () => {
            if (!confirmAction("Go ahead without an invoice?\n\nThe PTAA is filed and completed with the agreement only. " +
                               "You can switch the invoice back on later.")) return;
            await setNoInvoice(requestId, true);
            toast("No invoice for this PTAA.");
          }) })));
  }

  function soloDetailsCard() {
    const o = req.owner || {};
    const t = req.tenancy || {};
    const fin = req.financial || {};
    const a = req.agentSnapshot || {};
    const cancelled = req.status === STATUS.CANCELLED;
    return card("1 · Details",
      h("dl", { class: "detail-dl two-col" },
        h("dt", {}, "Owner"),     h("dd", {}, o.name || "—", o.nric ? h("span", { class: "muted small" }, ` · ${o.nric}`) : null),
        h("dt", {}, "Phone"),     h("dd", {}, o.phone || "—"),
        h("dt", {}, "Bank"),      h("dd", {}, [o.bankName, o.accountNumber].filter(Boolean).join(" · ") || "—"),
        h("dt", {}, "Property"),  h("dd", {}, `${req.propertyName || "—"} ${req.unitNo || ""}`,
                                     req.ptaaType ? h("span", { class: "muted small" }, ` · ${req.ptaaType}`) : null),
        h("dt", {}, "Tenancy"),   h("dd", {},
          t.initialTermMonths ? `${t.initialTermMonths} months, ` : "",
          t.commencementDate ? fmtDate(parseDateInput(t.commencementDate)) : "—", " – ",
          t.expiryDate ? fmtDate(parseDateInput(t.expiryDate)) : "—"),
        h("dt", {}, "Admin fee"), h("dd", {}, fmtPercent(fin.monthlyAdminFeePercent)),
        h("dt", {}, "Renovation"), h("dd", {}, (fin.renovationCost == null || fin.renovationCost === "" ? "NIL" : fmtMoney(fin.renovationCost))),
        h("dt", {}, "Sales Agent"), h("dd", {}, a.nickname || "—",
                                      a.fullName ? h("span", { class: "muted small" }, ` · ${a.fullName}`) : null),
      ),
      (req.specialTerms || []).length
        ? h("p", { class: "small" }, h("strong", {}, "Special terms: "), req.specialTerms.join(" · "))
        : null,
      req.notes ? h("p", { class: "small pre-wrap muted" }, req.notes) : null,
      costClash(req)
        ? noticeBox("warn", h("p", {}, h("strong", {}, "Renovation cost and invoice don't match. "),
            costClashText(costClash(req))),
            h("div", { class: "actions" },
              button("Sort it out…", { variant: "quiet",
                onClick: () => act(() => resolveCostDifference(req, Number(req.invoice.total))) })))
        : costAcknowledged(req)
          ? h("p", { class: "muted small" }, "Renovation cost and invoice total differ on purpose — confirmed by ",
              costAcknowledged(req).by || "—", " on ", fmtLogTime(costAcknowledged(req).at), ".")
          : null,
      !cancelled && tenancyMissing(req).length
        ? noticeBox("warn", h("p", {}, h("strong", {}, "Tenancy period not set yet"),
            ` — ${tenancyMissing(req).join(", ")} missing. Set it before drafting the PTAA. `,
            button("Set the tenancy period", { variant: "link", onClick: () => { editing = true; render(); } })))
        : null,
      req.createdBy && req.createdBy !== session.email
        ? h("p", { class: "muted small" }, `Submitted by ${req.createdBy} on ${fmtLogTime(req.createdAt)}.`)
        : null,
      h("div", { class: "actions" },
        cancelled ? null : button("Edit details", { onClick: () => { editing = true; render(); } }),
        cancelled || req.status === STATUS.COMPLETED ? null : button("Cancel this PTAA", {
          variant: "quiet-danger",
          onClick: () => act(async () => {
            const reason = window.prompt(`Why is ${req.ptaaId} being cancelled?`, "");
            if (reason === null) return;
            if (!String(reason).trim()) { toast("A reason is needed.", "warn"); return; }
            await transitionRequest(requestId, STATUS.CANCELLED, { reason });
            toast(`${req.ptaaId} cancelled.`);
          }),
        }),
      ),
    );
  }

  function soloPtaaCard() {
    const wd = req.workingDoc;
    const blocker = adminProfileBlocker();
    return card("2 · Draft the PTAA and the invoice",
      h("p", { class: "muted small" },
        "The agreement is filled from this condo's Word template — owner, tenancy, fees, utilities, the ",
        "Sales Agent and you in the witness blocks, and the I/C page. Appendix A is left for the invoice, ",
        "which is added only in the complete PDF (step 6). The invoice below is filled from the quotation."),
      h("h3", { class: "sub-title" }, "PTAA (Word)"),
      h("code", { class: "filename" }, generatedFilename()),
      templateMeta === undefined
        ? loading("Checking the template…")
        : templateMeta === null
          ? noticeBox("warn",
              h("p", {}, "No PTAA template has been uploaded yet."),
              h("p", { class: "small" }, "Upload the Word template (one for every condo) under ",
                button("Settings", { variant: "link", onClick: () => navigate("settings") }), "."))
          : h("p", { class: "muted small" }, "Template: ", h("code", {}, templateMeta.fileName),
              ` (v${templateMeta.version || 1}).`),
      blocker ? noticeBox("warn", h("p", { class: "small" }, blocker, " ",
        button("Open my profile", { variant: "link", onClick: () => navigate("profile") }))) : null,
      wd ? h("dl", { class: "detail-dl" },
             h("dt", {}, "Current file"), h("dd", {}, wd.fileName),
             h("dt", {}, "State"), h("dd", {}, wd.confirmed ? badge("Confirmed", "ok")
                                             : wd.source === "uploaded" ? badge("Edited copy", "warn")
                                             : badge("Draft", "warn")),
             h("dt", {}, "Saved"), h("dd", {}, `${fmtLogTime(wd.savedAt)}`))
         : null,
      tenancyMissing(req).length
        ? h("p", { class: "small" }, "Set the tenancy period (step 1) before drafting.")
        : null,
      h("div", { class: "actions" },
        templateMeta && req.status !== STATUS.CANCELLED
          ? button(wd ? "Redraft the PTAA" : "Draft the PTAA (Word)", {
              variant: wd ? "default" : "primary", onClick: generate,
              disabled: tenancyMissing(req).length > 0 })
          : null,
        wd ? button("Download", { variant: "quiet", onClick: downloadWorking }) : null,
      ),
    );
  }

  function soloPrintCard() {
    const wd = req.workingDoc;
    const inv = req.invoice && req.invoice.file;
    return card("3 · Edit, save and print",
      h("ol", { class: "bullets" },
        h("li", {}, "Open the PTAA in Word and the invoice in Excel (they were downloaded when drafted — ",
          "or download them again below)."),
        h("li", {}, "Make any changes, then Save."),
        h("li", {}, "Print for signing."),
      ),
      h("div", { class: "actions" },
        wd ? button("Download PTAA", { variant: "quiet", onClick: downloadWorking }) : null,
        inv ? button("Download invoice", { variant: "quiet", onClick: () => downloadInvoice(req) }) : null,
        !wd && !inv ? h("span", { class: "muted small" }, "Nothing drafted yet.") : null,
      ),
    );
  }

  function soloConfirmCard() {
    const wd = req.workingDoc;
    const inv = req.invoice && req.invoice.file;
    const locked = req.status === STATUS.CANCELLED;

    const docxInput = h("input", { type: "file", accept: ".docx", class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadConfirmedPtaa(f); } });
    const xlsxInput = h("input", { type: "file", accept: ".xlsx", class: "visually-hidden",
      onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadConfirmedInvoice(f); } });

    const row = (label, meta, input, onUseDraft, what) => h("div", { class: "confirm-row" },
      h("div", {},
        h("strong", {}, label), " ",
        meta && meta.confirmed ? badge("Confirmed", "ok") : badge("Waiting", "warn"),
        meta ? h("p", { class: "muted small" }, meta.fileName,
                  meta.confirmed ? ` — saved ${fmtLogTime(meta.savedAt)}` : " (draft)") : null),
      locked ? null : h("div", { class: "actions" },
        input,
        button(`Upload confirmed ${what}`, { variant: meta && meta.confirmed ? "quiet" : "primary",
          onClick: () => input.click() }),
        meta && !meta.confirmed
          ? button("Use the draft as final", { variant: "quiet", title: "No changes were needed",
              onClick: () => act(async () => { await confirmDraft(requestId, onUseDraft); toast("Marked as final."); }) })
          : null,
      ));

    return card("4 · Upload the confirmed files",
      h("p", { class: "muted small" },
        "After editing and saving, upload the final Word and Excel files here. These are the copies that ",
        "get filed to Google Drive. If a draft needed no changes, “Use the draft as final” skips the upload."),
      row("PTAA (Word)", wd, docxInput, "ptaa", "PTAA"),
      noInvoice(req)
        ? h("div", { class: "confirm-row" }, h("div", {}, h("strong", {}, "Invoice (Excel)"), " ", badge("Not needed", "neutral")))
        : row("Invoice (Excel)", inv, xlsxInput, "invoice", "invoice"),
    );
  }

  // --- 6 · The complete PTAA as one PDF ----------------------------------

  function soloPdfCard() {
    if (req.status !== STATUS.COMPLETED) return null;
    const d = req.drive || {};
    const own = { ptaa: null, invoice: null };      // PDFs the admin supplies herself
    const status = h("p", { class: "muted small" });
    const errors = h("div", {});

    const pick = (which, label) => {
      const name = h("span", { class: "muted small" }, "");
      const input = h("input", { type: "file", accept: ".pdf,application/pdf", class: "visually-hidden",
        onChange: (e) => {
          const f = e.target.files[0]; e.target.value = "";
          if (!f) return;
          if (!looksLikePdf(f)) { toast("That is not a PDF.", "error"); return; }
          own[which] = f; name.textContent = ` Using “${f.name}”.`;
          clear.hidden = false;
        } });
      const clear = button("Use the automatic one", { variant: "link",
        onClick: () => { own[which] = null; name.textContent = ""; clear.hidden = true; } });
      clear.hidden = true;
      return h("div", { class: "confirm-row" },
        h("div", {}, h("strong", {}, label),
          h("p", { class: "muted small" }, which === "ptaa"
            ? "Automatic: Google converts the confirmed Word file. For an exact copy, save it as PDF in Word and use that."
            : "Automatic: the invoice Sheet in Drive, exported as PDF without gridlines or notes."),
          name),
        h("div", { class: "actions" }, input,
          button(`Use my own PDF…`, { variant: "quiet", onClick: () => input.click() }), clear));
    };

    const btn = button("Download the complete PDF", { variant: "primary" });
    const pdfName = generatedFilename().replace(/\.docx$/i, ".pdf");
    const sendBtn = button("Send this PDF to the Sales Agent", {
      onClick: () => act(async () => {
        if (!lastCompletePdf) return;
        await shareFinalPdf(requestId, lastCompletePdf);
        toast("Sent — the Sales Agent can download it now.");
      }) });
    sendBtn.hidden = !lastCompletePdf;

    btn.addEventListener("click", async () => {
      btn.disabled = true; mount(errors);
      try {
        const withInvoice = !noInvoice(req);
        const needDrive = !own.ptaa || (withInvoice && !own.invoice);
        const token = needDrive ? await driveToken() : null;   // first, so the pop-up is allowed

        status.textContent = "Getting the PTAA…";
        let ptaaPdf;
        if (own.ptaa) ptaaPdf = new Uint8Array(await own.ptaa.arrayBuffer());
        else {
          const wd = await loadWorkingDocument(requestId);
          if (!wd) throw new Error("The confirmed PTAA could not be read.");
          status.textContent = "Google is converting the Word file to PDF…";
          ptaaPdf = await wordToPdf(token, wd.bytes);
        }

        if (!withInvoice) {
          downloadBlob(new Blob([ptaaPdf], { type: "application/pdf" }), pdfName);
          lastCompletePdf = { bytes: ptaaPdf, fileName: pdfName };
          sendBtn.hidden = false;
          status.textContent = "Done — the agreement as one PDF (no invoice for this PTAA).";
          toast("Complete PDF downloaded.");
          return;
        }
        status.textContent = "Getting the invoice…";
        let invPdf;
        if (own.invoice) invPdf = new Uint8Array(await own.invoice.arrayBuffer());
        else {
          if (!(d.invoice && d.invoice.fileId)) throw new Error("The invoice has not been filed to Drive yet.");
          try { invPdf = await exportSheetPdf(token, d.invoice.fileId); }
          catch (err) {
            throw new Error("The invoice in Drive could not be exported as PDF (it must be a Google Sheet). " +
                            "Download it as PDF from Drive and use “Use my own PDF” for the invoice. (" + err.message + ")");
          }
        }

        status.textContent = "Putting the invoice into Appendix A…";
        const joined = await joinPtaaAndInvoice(ptaaPdf, invPdf);
        downloadBlob(new Blob([joined.bytes], { type: "application/pdf" }), pdfName);
        lastCompletePdf = { bytes: joined.bytes, fileName: pdfName };
        sendBtn.hidden = false;

        status.textContent = `Done — ${joined.pages} pages, the invoice (${joined.invoicePages} page` +
          `${joined.invoicePages === 1 ? "" : "s"}) placed after page ${joined.insertedAt}.`;
        toast("Complete PDF downloaded.");
      } catch (err) {
        status.textContent = "";
        mount(errors, noticeBox("error", h("p", {}, err.message || friendlyError(err)),
          err.code ? h("p", { class: "small" }, driveAdvice(err.code)) : null));
      } finally { btn.disabled = false; }
    });

    return card("6 · Complete PTAA as PDF",
      h("p", { class: "muted small" },
        "The whole agreement in one PDF, with the invoice put into Appendix A — just before Appendix B, ",
        "as in the office's finished copies. It downloads to this computer only; nothing is saved to Drive."),
      h("code", { class: "filename" }, pdfName),
      pick("ptaa", "Agreement (Word → PDF)"),
      noInvoice(req) ? null : pick("invoice", "Invoice (Sheet → PDF)"),
      errors,
      h("div", { class: "actions" }, btn, sendBtn, status),
    );
  }

  // --- 7 · The finished PDF for the Sales Agent --------------------------

  function soloShareCard() {
    if (req.status === STATUS.CANCELLED) return null;
    const fp = req.finalPdf;
    const input = h("input", { type: "file", accept: ".pdf,application/pdf", class: "visually-hidden",
      onChange: (e) => {
        const f = e.target.files[0]; e.target.value = "";
        if (!f) return;
        if (!looksLikePdf(f)) { toast("That is not a PDF.", "error"); return; }
        act(async () => {
          toast("Sending…");
          await shareFinalPdf(requestId, {
            fileName: generatedFilename().replace(/\.docx$/i, ".pdf"),
            bytes: new Uint8Array(await f.arrayBuffer()),
          });
          toast("Sent — the Sales Agent can download it now.");
        });
      } });
    const who = (req.agentSnapshot || {}).nickname || (req.agentSnapshot || {}).fullName || "the Sales Agent";
    // A PTAA the admin started herself is filed under her own account, so no
    // agent account can see it.
    const hasLogin = !!req.agentEmail && req.agentEmail !== session.email;

    return card("7 · Finished PDF for the Sales Agent",
      h("p", { class: "muted small" },
        "The only file a Sales Agent can see. Send the complete PDF from step 6, or upload a PDF — ",
        "for example the copy the Owner and the Director have signed. Sending again replaces it."),
      fp
        ? h("dl", { class: "detail-dl" },
            h("dt", {}, "Sent"), h("dd", {}, badge("Shared", "ok"), " ", fp.fileName),
            h("dt", {}, "When"), h("dd", {}, `${fmtLogTime(fp.sharedAt)} by ${fp.sharedBy || "—"}`))
        : h("p", { class: "empty" }, `Nothing sent to ${who} yet.`),
      hasLogin ? null : noticeBox("info", h("p", { class: "small" },
        "This PTAA was started by you, so there is no Sales Agent account to see it. ",
        "It will show for an agent only on PTAAs they submitted themselves.")),
      h("div", { class: "actions" }, input,
        button(fp ? "Replace with a PDF…" : "Upload a PDF…", { variant: fp ? "quiet" : "default", onClick: () => input.click() }),
        fp ? button("Download it", { variant: "quiet", onClick: () => downloadFinal() }) : null,
        fp ? button("Stop sharing", { variant: "quiet-danger", onClick: () => act(async () => {
          if (!confirmAction("Stop sharing the PDF? The Sales Agent will no longer be able to download it.")) return;
          await unshareFinalPdf(requestId);
          toast("No longer shared.");
        }) }) : null),
    );
  }

  async function downloadFinal() {
    try {
      const fp = await loadFinalPdf(requestId);
      if (!fp) { toast("Nothing has been shared yet.", "warn"); return; }
      downloadBlob(new Blob([fp.bytes], { type: "application/pdf" }), fp.meta.fileName || "PTAA.pdf");
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function uploadConfirmedPtaa(file) {
    if (!looksLikeDocx(file)) { toast("That is not a Word .docx file.", "error"); return; }
    try {
      const buf = await readFileAsArrayBuffer(file);
      await saveWorkingDocument(requestId, {
        fileName: generatedFilename(), bytes: new Uint8Array(buf), source: "uploaded", confirmed: true,
      });
      toast("Confirmed PTAA saved.");
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function uploadConfirmedInvoice(file) {
    if (!looksLikeXlsx(file)) { toast("That is not an Excel .xlsx file.", "error"); return; }
    try {
      const buf = await readFileAsArrayBuffer(file);
      const inv = req.invoice || {};
      const name = inv.file && inv.file.fileName
        ? inv.file.fileName
        : invoiceFilename({ propertyName: req.propertyName, unitNo: req.unitNo });
      await saveInvoiceFile(requestId, { fileName: name, bytes: new Uint8Array(buf), source: "uploaded", confirmed: true });
      toast("Confirmed invoice saved.");
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function soloFileCard() {
    if (req.status === STATUS.CANCELLED) return null;
    const blockers = soloFilingBlockers(req);
    const d = req.drive || {};
    const filed = req.status === STATUS.COMPLETED;
    const stageLine = h("p", { class: "muted small" });
    const errors = h("div", {});
    const dPtaa = destinationOf(settings, "ptaa"), dInv = destinationOf(settings, "invoice");
    const noFolder = !(settings && dPtaa.id && (dInv.id || noInvoice(req)));

    const btn = button(filed ? "File again (replaces the Drive copies)" : "File to Google Drive", {
      variant: filed ? "quiet" : "primary" });
    btn.disabled = blockers.length > 0 || noFolder;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      mount(errors);
      try {
        // Asked for first, straight from the click, so the browser lets Google's pop-up open.
        stageLine.textContent = "Asking Google for Drive permission…";
        const token = await driveToken();
        const result = await fileSoloRequest(requestId,
          (a) => fileToDrive(a, { token, settings }),
          (msg) => { stageLine.textContent = msg; }, { settings });
        toast(`${req.ptaaId} filed to Drive in ${result.ptaa.folderName}.`);
        await load();
      } catch (err) {
        stageLine.textContent = "";
        mount(errors, noticeBox("error",
          h("p", {}, h("strong", {}, filed ? "Not re-filed." : "Not filed.")),
          h("p", { class: "pre-wrap" }, err.message || friendlyError(err)),
          err.code ? h("p", { class: "small" }, driveAdvice(err.code)) : null,
          h("p", { class: "small" }, "Nothing on this PTAA was changed.")));
        btn.disabled = false;
      }
    });

    const folderLine = noFolder
      ? noticeBox("warn", h("p", { class: "small" }, "No Google Drive folder is set yet. ",
          button("Open Settings", { variant: "link", onClick: () => navigate("settings") }),
          " and paste the folder link."))
      : h("div", { class: "small" },
          h("p", { class: "dest-line" }, "PTAA → ", h("strong", {}, dPtaa.name || "the PTAA folder"),
            dPtaa.subfolder ? [" / ", h("strong", {}, req.propertyName || "condo")] : null),
          noInvoice(req) ? h("p", { class: "dest-line" }, "Invoice → none for this PTAA") :
          h("p", { class: "dest-line" }, "Invoice → ", h("strong", {}, dInv.name || "the invoice folder"),
            dInv.monthFolders ? [" / ", h("strong", {}, monthFolderName(dInv.monthPattern,
              parseDateInput((req.invoice || {}).date) || new Date()))] : null,
            dInv.subfolder ? [" / ", h("strong", {}, req.propertyName || "condo")] : null,
            " ", button("Change", { variant: "link", onClick: () => navigate("settings") })));

    return card(filed ? "5 · Filed in Google Drive" : "5 · File to Google Drive",
      filed
        ? h("dl", { class: "detail-dl" },
            h("dt", {}, "PTAA"), h("dd", {}, d.webViewLink
              ? h("a", { href: d.webViewLink, target: "_blank", rel: "noopener" }, d.fileName || "Open") : (d.fileName || "—")),
            h("dt", {}, "Invoice"), h("dd", {}, !d.invoice ? "None for this PTAA" : d.invoice.webViewLink
              ? h("a", { href: d.invoice.webViewLink, target: "_blank", rel: "noopener" }, d.invoice.fileName || "Open")
              : ((d.invoice || {}).fileName || "—")),
            h("dt", {}, "Folders"), h("dd", {}, d.folderName || "—", d.invoice && d.invoice.folderName ? ` · ${d.invoice.folderName}` : ""),
            h("dt", {}, "Filed"), h("dd", {}, `${fmtLogTime(req.completedAt)} by ${req.completedBy || "—"}`))
        : null,
      folderLine,
      !filed && blockers.length
        ? noticeBox("warn", h("p", {}, h("strong", {}, "Before filing:")),
            h("ul", { class: "bullets" }, blockers.map(b => h("li", {}, b))))
        : null,
      h("p", { class: "muted small" },
        "The first time in each session Google asks, in a pop-up, to let this site use your Drive. ",
        "The files are uploaded first; the PTAA is only marked filed if both uploads succeed."),
      errors,
      h("div", { class: "actions" }, btn, stageLine),
    );
  }

  async function load() {
    mount(root, loading());
    try {
      req = await getRequest(requestId);
      if (!req) {
        mount(root, card("Not found",
          h("p", {}, `No request called ${requestId}.`),
          h("div", { class: "actions" }, button("Back to requests", { onClick: () => navigate("requests") }))));
        return;
      }
      [attachments, activity, properties, templateMeta, signatures] = await Promise.all([
        listAttachments(requestId).catch(() => []),
        listRequestActivity(requestId).catch(() => []),
        listProperties().catch(() => []),
        getEffectiveTemplateMeta(req.propertyId).catch(() => null),
        isAdmin() ? listSignatures().catch(() => []) : Promise.resolve([]),
      ]);
      // Only asked for when it could matter — the endpoint reaches out to
      // Google, and every request detail view does not need to.
      if (isAdmin() && [STATUS.FINAL_CHECK].includes(req.status)) {
        drive = await driveStatus().catch(() => ({ ok: false, code: "drive_failed" }));
      }
      if (solo) settings = await getSettings().catch(() => null);
      // Seeded once, so a reload after saving does not undo the admin's choice.
      if (!sigChoice) sigChoice = defaultSignatureChoice(req, signatures);
      render();
    } catch (err) {
      mount(root, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}
