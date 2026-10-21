// ---------------------------------------------------------------------------
// requests.js — everything that talks to Firestore about properties, PTAA
// requests, their attachments and their history.
//
// Queries here deliberately avoid combining `where` with `orderBy` on a
// different field, because that would require a composite index the user has to
// create by hand in the console. At this volume (small internal team) sorting
// and filtering in the browser is cheaper than that setup step. Phase 13 revisits
// this when global search arrives.
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, addDoc, query, orderBy, limit, where,
  serverTimestamp, runTransaction, toDate, logActivity,
} from "./core.js";

import { session } from "./auth.js";

import {
  STATUS, STATUS_LABEL, ACTOR, defaultCurrentAction, formatPtaaId, isTransitionAllowed,
  REQUEST_TYPE, OPEN_STATUSES, CLOSED_STATUSES, ptaaFilename, parseDateInput,
} from "./model.js";

import { writeChunks, readChunks, deleteChunks, assertSize } from "./chunks.js";
import { notify, NOTICES } from "./notifications.js";
import {
  CHECKLIST, checklistProgress, SIGNATORY_TYPES, SIGNATORY_STATUS,
  signatureSummary, signatureCurrentAction,
} from "./model.js";

// ===========================================================================
// Properties (the registry agents pick from)
// ===========================================================================

export async function listProperties({ includeInactive = false } = {}) {
  const snap = await getDocs(collection(db, "properties"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => includeInactive || p.active !== false)
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

export async function createProperty({ name, address, picNickname, picMobile }) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Property name is required.");

  // The property name ends up in the filename and the Drive folder, so two
  // spellings of the same condo is a real problem, not a cosmetic one.
  const existing = await listProperties({ includeInactive: true });
  const clash = existing.find(p => String(p.name || "").toLowerCase() === clean.toLowerCase());
  if (clash) throw new Error(`“${clash.name}” is already on the list.`);

  const ref = await addDoc(collection(db, "properties"), {
    name: clean,
    nameLower: clean.toLowerCase(),
    address: String(address || "").trim(),
    // Schedule item 4a — the Owner Group Admin differs by condo.
    picNickname: String(picNickname || "").trim(),
    picMobile: String(picMobile || "").trim(),
    active: true,
    createdBy: session.email,
    createdAt: serverTimestamp(),
  });
  await logActivity({
    action: "property.created",
    summary: `Added property “${clean}”.`,
    targetType: "property", targetId: ref.id,
  });
  return ref.id;
}

export async function updateProperty(id, patch) {
  await updateDoc(doc(db, "properties", id), patch);
  await logActivity({
    action: "property.updated",
    summary: `Updated property ${patch.name ? `“${patch.name}”` : id}.`,
    targetType: "property", targetId: id, detail: patch,
  });
}

// ===========================================================================
// Requests
// ===========================================================================

/**
 * Create a New PTAA Request. The PTAA number and the request document are
 * written in one transaction, so a failure cannot burn an identifier or leave
 * two requests sharing one.
 *
 * The agent's details are SNAPSHOTTED here (brief §6, rule #4): editing a
 * profile later must never change a PTAA that already exists.
 */
export async function createRequest(value, { agentSnapshot = null } = {}) {
  const profile = (session.record && session.record.profile) || {};
  // In solo mode the admin starts the PTAA and picks the Sales Agent from the
  // list; their details are snapshotted exactly as a signed-in agent's are.
  const snapshot = agentSnapshot || {
    email: session.email,
    fullName: profile.fullName || "",
    nric: profile.nric || "",
    phone: profile.phone || "",
    nickname: profile.nickname || "",
    profileVersion: profile.version || 0,
  };

  const id = await runTransaction(db, async (tx) => {
    const counterRef = doc(db, "counters", "requests");
    const counterSnap = await tx.get(counterRef);
    const next = counterSnap.exists() ? Number(counterSnap.data().next || 1) : 1;
    const ptaaId = formatPtaaId(next);

    const ref = doc(db, "requests", ptaaId);
    tx.set(counterRef, { next: next + 1 });
    tx.set(ref, {
      ptaaId,
      type: REQUEST_TYPE.NEW_PTAA,
      status: STATUS.NEW,
      currentAction: ACTOR.ADMIN,
      previousStatus: null,
      holdReason: null,
      holdNote: null,
      cancelReason: null,

      agentEmail: session.email,
      agentSnapshot: snapshot,

      owner: value.owner,
      propertyId: value.propertyId,
      propertyName: value.propertyName,
      propertyAddress: value.propertyAddress,
      unitNo: value.unitNo,
      propertySize: value.propertySize,
      ptaaType: value.ptaaType,
      tenancy: value.tenancy,
      financial: value.financial,
      utilities: value.utilities,
      specialTerms: value.specialTerms,
      notes: value.notes,
      adminSnapshot: null,

      // Filled only by completeRequest, and only after Drive confirms the file.
      drive: null,
      completedAt: null,
      completedBy: null,

      attachmentCount: 0,
      dueDate: null,
      revision: 1,
      manuallyEdited: false,
      signatories: {},
      finalChecklist: {},
      openChangeRequest: null,

      createdAt: serverTimestamp(),
      createdBy: session.email,
      updatedAt: serverTimestamp(),
      lastActionBy: session.email,
    });
    return ptaaId;
  });

  await logRequestEvent(id, {
    action: "request.submitted",
    summary: agentSnapshot
      ? `PTAA started for Sales Agent ${agentSnapshot.nickname || agentSnapshot.fullName || "—"}.`
      : "Sales Agent submitted New PTAA Request.",
  });
  await logActivity({
    action: "request.submitted",
    summary: `Submitted ${id} — ${value.propertyName} ${value.unitNo} for ${value.owner.name}.`,
    targetType: "request", targetId: id,
  });

  const created = await getRequest(id);
  if (created) {
    await notify({ toEmail: session.email, request: created,
                   event: "submitted", text: NOTICES.submitted(created) });
  }
  return id;
}

/** Agents get only their own (the rules enforce it too). */
export async function listRequests({ mine = false } = {}) {
  const base = collection(db, "requests");
  const q = mine ? query(base, where("agentEmail", "==", session.email)) : base;
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = toDate(a.updatedAt), bt = toDate(b.updatedAt);
      return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0);
    });
}

export async function getRequest(id) {
  const snap = await getDoc(doc(db, "requests", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** Edit the request's data without changing its status. */
export async function saveRequestData(id, value, { summary } = {}) {
  // Brief §11.1 asks the admin to confirm "PTAA information checked". If the
  // information then changes, that tick is no longer true — so editing the data
  // clears the checklist rather than leaving a stale confirmation standing.
  const before = await getRequest(id);
  const hadTicks = before && checklistProgress(before.finalChecklist).done > 0;

  await updateDoc(doc(db, "requests", id), {
    owner: value.owner,
    propertyId: value.propertyId,
    propertyName: value.propertyName,
    propertyAddress: value.propertyAddress,
    unitNo: value.unitNo,
    propertySize: value.propertySize,
    ptaaType: value.ptaaType,
    tenancy: value.tenancy,
    financial: value.financial,
    utilities: value.utilities,
    specialTerms: value.specialTerms,
    notes: value.notes,
    finalChecklist: {},
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  await logRequestEvent(id, {
    action: "request.edited",
    summary: summary || `${session.role === "admin" ? "Admin" : "Sales Agent"} edited the request details.`,
  });
  if (hadTicks) {
    await logRequestEvent(id, {
      action: "checklist.cleared",
      summary: "The final checklist was cleared because the request data changed after it was ticked.",
    });
  }
}

export async function setDueDate(id, dueDate) {
  await updateDoc(doc(db, "requests", id), {
    dueDate: dueDate || null,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  await logRequestEvent(id, {
    action: "request.due_date",
    summary: dueDate ? `Due date set to ${dueDate}.` : "Due date cleared.",
  });
}

export async function setCurrentAction(id, actor) {
  await updateDoc(doc(db, "requests", id), {
    currentAction: actor,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  await logRequestEvent(id, {
    action: "request.current_action",
    summary: `Current action set to ${actor}.`,
  });
}

/**
 * Move a request through the state machine.
 * The same table is enforced by firestore.rules; this check exists so a
 * disallowed move fails with a sentence rather than "permission denied".
 */
export async function transitionRequest(id, to, { note = "", reason = "", currentAction = null } = {}) {
  const current = await getRequest(id);
  if (!current) throw new Error(`${id} no longer exists.`);

  const role = session.role;
  const target = to === "__resume__"
    ? (current.previousStatus || STATUS.UNDER_REVIEW)
    : to;

  if (to === "__resume__") {
    if (current.status !== STATUS.ON_HOLD) throw new Error("This request is not on hold.");
  } else if (!isTransitionAllowed(current.status, target, role)) {
    throw new Error(`A request cannot go from ${current.status} to ${target}.`);
  }

  const patch = {
    status: target,
    currentAction: currentAction || defaultCurrentAction(target),
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  };

  if (target === STATUS.ON_HOLD) {
    patch.previousStatus = current.status;
    patch.holdReason = reason || "Other";
    patch.holdNote = note || "";
    patch.currentAction = ACTOR.NONE;
  } else if (to === "__resume__") {
    patch.previousStatus = null;
    patch.holdReason = null;
    patch.holdNote = null;
  }

  if (target === STATUS.CANCELLED) {
    patch.cancelReason = reason || "";
    patch.currentAction = ACTOR.NONE;
  }

  // Brief §9.3 — the Owner change request. The agent describes what the Owner
  // wants; no supporting document is required. It stays visible on the request
  // until the admin has dealt with it and marks PTAA OK again.
  const isChangeRequest = role === "agent"
    && current.status === STATUS.READY_FOR_AGENT
    && target === STATUS.UNDER_REVIEW;
  if (isChangeRequest) {
    patch.openChangeRequest = { text: note, at: serverTimestamp(), by: session.email };
  }
  if (target === STATUS.PTAA_OK) {
    patch.openChangeRequest = null;
  }

  // While waiting for signatures, who has the ball is whichever signatory has
  // not signed yet — not always the Director.
  if (target === STATUS.WAITING_FOR_SIGNATURE && !currentAction) {
    patch.currentAction = signatureCurrentAction(current.signatories);
  }

  await updateDoc(doc(db, "requests", id), patch);

  const who = role === "admin" ? "Admin" : "Sales Agent";
  let summary;
  if (target === STATUS.ON_HOLD) {
    summary = `${who} put the request on hold — ${patch.holdReason}${note ? `: “${note}”` : ""}.`;
  } else if (to === "__resume__") {
    summary = `${who} resumed the request. Status returned to ${target}.`;
  } else if (target === STATUS.CANCELLED) {
    summary = `${who} cancelled the request — ${reason}.`;
  } else if (isChangeRequest) {
    summary = `Sales Agent requested changes on behalf of the Owner: “${note}”`;
  } else {
    summary = `${who} changed the status to ${target}${note ? `: “${note}”` : ""}.`;
  }

  await logRequestEvent(id, {
    action: isChangeRequest ? "change.requested" : "status." + target.toLowerCase(),
    summary,
    detail: { from: current.status, to: target, note, reason },
  });
  await logActivity({
    action: "request.status",
    summary: `${id}: ${current.status} → ${target}.`,
    targetType: "request", targetId: id,
  });

  // Brief §14.2 — the Sales Agent is told what happened to their PTAA.
  // Nothing is sent when the agent themselves caused it.
  if (role === "admin") {
    const notices = {
      [STATUS.CHANGES_REQUIRED]: () => NOTICES.changes(current, note),
      [STATUS.PTAA_OK]:          () => NOTICES.ptaaOk(current),
      [STATUS.READY_FOR_AGENT]:  () => NOTICES.ready(current),
      [STATUS.ON_HOLD]:          () => NOTICES.onHold(current, patch.holdReason),
      [STATUS.CANCELLED]:        () => NOTICES.cancelled(current, reason || "no reason given"),
    };
    const text = to === "__resume__" ? NOTICES.resumed(current)
                                     : (notices[target] && notices[target]());
    if (text) {
      await notify({ toEmail: current.agentEmail, request: current,
                     event: "status." + target.toLowerCase(), text });
    }
  }
}

// ===========================================================================
// Signatories (brief §9.2, §10)
// ===========================================================================

/**
 * Set one signatory's state. Each is tracked separately — a PTAA that needs a
 * Director but no Witness is normal, and the overall state is derived from
 * these rather than stored.
 */
export async function setSignatory(requestId, key, status, { note = "" } = {}) {
  if (!SIGNATORY_TYPES.some(t => t.key === key)) throw new Error(`Unknown signatory “${key}”.`);
  if (!Object.values(SIGNATORY_STATUS).includes(status)) throw new Error(`Unknown status “${status}”.`);

  const current = await getRequest(requestId);
  if (!current) throw new Error(`${requestId} no longer exists.`);

  const previous = (current.signatories || {})[key] || {};
  const entry = {
    status,
    note: note || previous.note || "",
    requestedAt: status === SIGNATORY_STATUS.REQUESTED
      ? serverTimestamp()
      : (previous.requestedAt || null),
    signedAt: status === SIGNATORY_STATUS.SIGNED ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
    updatedBy: session.email,
  };

  const signatories = { ...(current.signatories || {}), [key]: entry };
  const patch = {
    signatories,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  };

  // Ticking a signature can change who is holding things up, and it invalidates
  // the "Required signatures completed" line on the checklist.
  if (current.status === STATUS.WAITING_FOR_SIGNATURE) {
    patch.currentAction = signatureCurrentAction(signatories);
  }
  const cl = { ...(current.finalChecklist || {}) };
  if (cl.signatures) { delete cl.signatures; patch.finalChecklist = cl; }

  await updateDoc(doc(db, "requests", requestId), patch);

  const label = (SIGNATORY_TYPES.find(t => t.key === key) || {}).label || key;
  const summary = status === SIGNATORY_STATUS.SIGNED
    ? `${label} signature recorded.`
    : status === SIGNATORY_STATUS.NOT_REQUIRED
      ? `${label} signature marked not required.`
      : `${label} signature marked ${status.toLowerCase()}.`;

  await logRequestEvent(requestId, {
    action: "signature." + status.toLowerCase(),
    summary, detail: { signatory: key, status },
  });

  const summaryNow = signatureSummary(signatories);
  await notify({
    toEmail: current.agentEmail, request: current, event: "signature",
    text: NOTICES.signature(current, `${summary} ${summaryNow.text}`),
  });
}

// ===========================================================================
// Final checklist (brief §11.1)
// ===========================================================================

export async function setChecklistItem(requestId, key, checked) {
  if (!CHECKLIST.some(i => i.key === key)) throw new Error(`Unknown checklist item “${key}”.`);
  const current = await getRequest(requestId);
  if (!current) throw new Error(`${requestId} no longer exists.`);

  const cl = { ...(current.finalChecklist || {}) };
  if (checked) cl[key] = { checked: true, at: serverTimestamp(), by: session.email };
  else delete cl[key];

  await updateDoc(doc(db, "requests", requestId), {
    finalChecklist: cl,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });

  const label = (CHECKLIST.find(i => i.key === key) || {}).label || key;
  await logRequestEvent(requestId, {
    action: checked ? "checklist.checked" : "checklist.unchecked",
    summary: `${checked ? "Confirmed" : "Un-confirmed"}: ${label}.`,
    detail: { key, checked },
  });
}

export async function clearChecklist(requestId, why) {
  await updateDoc(doc(db, "requests", requestId), {
    finalChecklist: {},
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  await logRequestEvent(requestId, {
    action: "checklist.cleared",
    summary: `The final checklist was cleared${why ? ` — ${why}` : "."}`,
  });
}

// ===========================================================================
// Attachments (brief §12 — used to prepare a PTAA, never kept permanently)
// ===========================================================================

export async function listAttachments(requestId) {
  const snap = await getDocs(collection(db, "requests", requestId, "attachments"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = toDate(a.addedAt), bt = toDate(b.addedAt);
      return (at ? at.getTime() : 0) - (bt ? bt.getTime() : 0);
    });
}

export async function addAttachment(requestId, { kind, name, dataUrl, bytes, width, height, page = null, bothSides = false }) {
  const ref = await addDoc(collection(db, "requests", requestId, "attachments"), {
    kind, name, dataUrl, bytes, width, height,
    // Front of the I/C only: the picture shows both sides and could not be cut.
    bothSides: !!bothSides,
    // Set only for a quotation that arrived as a multi-page PDF, so the pages
    // can be put back in order when they go into Appendix A.
    page,
    addedBy: session.email,
    addedAt: serverTimestamp(),
  });
  await bumpAttachmentCount(requestId);
  await logRequestEvent(requestId, {
    action: "attachment.added",
    summary: `Attached ${attachmentLabel(kind)}${page ? `, page ${page}` : ""} — “${name}”.`,
  });
  return ref.id;
}

const ATTACHMENT_LABELS = {
  ic_front: "the Owner's I/C (front)",
  ic_back: "the Owner's I/C (back)",
  quotation: "the renovation quotation",
};
const attachmentLabel = (kind) => ATTACHMENT_LABELS[kind] || "a supporting file";

/**
 * `silent` skips the history entry — used when replacing a file, where one
 * "attached" line reads better than a delete and an add for every page of a
 * five-page quotation.
 */
export async function deleteAttachment(requestId, attachmentId, attachmentName = "", { silent = false } = {}) {
  await deleteDoc(doc(db, "requests", requestId, "attachments", attachmentId));
  await bumpAttachmentCount(requestId);
  if (silent) return;
  await logRequestEvent(requestId, {
    action: "attachment.deleted",
    summary: `Removed supporting file${attachmentName ? ` “${attachmentName}”` : ""}.`,
  });
}

/** Brief §12: clear supporting material once it has served its purpose. */
export async function deleteAllAttachments(requestId) {
  const items = await listAttachments(requestId);
  for (const a of items) {
    await deleteDoc(doc(db, "requests", requestId, "attachments", a.id));
  }
  await bumpAttachmentCount(requestId);
  await logRequestEvent(requestId, {
    action: "attachment.purged",
    summary: `Deleted all ${items.length} supporting image${items.length === 1 ? "" : "s"} (data retention).`,
  });
  return items.length;
}

async function bumpAttachmentCount(requestId) {
  const snap = await getDocs(collection(db, "requests", requestId, "attachments"));
  await updateDoc(doc(db, "requests", requestId), {
    attachmentCount: snap.size,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
}

// ===========================================================================
// The working document (brief §5.4)
// ===========================================================================
// Each request holds at most one Word document: the one generated from the
// template, or an edited version an admin uploaded in its place. Brief §11.5 —
// only the current document is kept. There is no V1/V2/V3.

const docChunkPath = (requestId) => ["requests", requestId, "docChunks"];

/**
 * @param {"generated"|"uploaded"} source
 *   "uploaded" means an admin edited it in Word and put it back, which sets
 *   manuallyEdited and blocks regeneration until it is explicitly confirmed.
 */
export async function saveWorkingDocument(requestId, { fileName, bytes, source, confirmed = false }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertSize(data, "document");

  const current = await getRequest(requestId);
  const previousCount = (current && current.workingDoc && current.workingDoc.chunkCount) || 0;

  const chunkCount = await writeChunks(docChunkPath(requestId), data);

  await updateDoc(doc(db, "requests", requestId), {
    workingDoc: {
      fileName, bytes: data.length, chunkCount, source,
      confirmed: !!confirmed,
      savedAt: serverTimestamp(), savedBy: session.email,
    },
    manuallyEdited: source === "uploaded",
    revision: ((current && Number(current.revision)) || 0) + 1,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });

  if (previousCount > chunkCount) {
    await deleteChunks(docChunkPath(requestId), chunkCount, previousCount);
  }

  await logRequestEvent(requestId, {
    action: source === "uploaded" ? "document.uploaded" : "document.generated",
    summary: confirmed
      ? `Uploaded the confirmed PTAA (${fileName}).`
      : source === "uploaded"
        ? `Uploaded a manually edited document (${fileName}). Regenerating from the template is now blocked.`
        : `Generated the document from the template (${fileName}).`,
    detail: { fileName, bytes: data.length, source },
  });
}

/**
 * Record the admin who prepared the document. Their details go into the second
 * "Witnessed by" block, so the request has to remember who it was at the time —
 * the same reason the agent's details are snapshotted (rule #4).
 */
export async function setAdminSnapshot(requestId, profile) {
  await updateDoc(doc(db, "requests", requestId), {
    adminSnapshot: {
      email: session.email,
      fullName: profile.fullName || "",
      nric: profile.nric || "",
      phone: profile.phone || "",
      nickname: profile.nickname || "",
      profileVersion: profile.version || 0,
    },
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
}

/** Who signed what, written to the request's history rather than assumed. */
export async function logSignaturesApplied(requestId, applied) {
  const names = Object.entries(applied)
    .filter(([, v]) => v && v.label)
    .map(([slot, v]) => `${slot.replace("sig_", "")}: ${v.label}`);
  if (!names.length) return;
  await logRequestEvent(requestId, {
    action: "document.signatures_applied",
    summary: `Signature images placed — ${names.join(", ")}.`,
    detail: { applied: Object.keys(applied) },
  });
}

export async function loadWorkingDocument(requestId) {
  const r = await getRequest(requestId);
  const meta = r && r.workingDoc;
  if (!meta) return null;
  const bytes = await readChunks(docChunkPath(requestId), meta.chunkCount, meta.bytes, "document");
  return { bytes, meta };
}

// ===========================================================================
// Completion (brief §11.2) — phase 11
// ===========================================================================

/**
 * Everything that must be true before Complete is even offered. Returned as a
 * list of reasons rather than a boolean so the screen can say what is missing
 * instead of showing a disabled button with no explanation.
 */
export function completionBlockers(request) {
  const r = request || {};
  const out = [];
  if (r.status !== STATUS.FINAL_CHECK) {
    out.push(`A PTAA can only be completed from Final check. This one is ${STATUS_LABEL[r.status] || r.status}.`);
  }
  const progress = checklistProgress(r.finalChecklist);
  if (!progress.complete) {
    out.push(`${progress.total - progress.done} of ${progress.total} checklist items are still unconfirmed.`);
  }
  if (!r.workingDoc) {
    out.push("There is no final Word document to upload.");
  }
  if (r.openChangeRequest) {
    out.push("There is an open change request from the Sales Agent.");
  }
  return out;
}

/**
 * Complete a PTAA: brief §11.2, in the order it specifies.
 *
 *   1. every checklist item ticked          ← completionBlockers, above
 *   2. the final Word document exists       ← completionBlockers, above
 *   3. generate and verify the filename     ← here
 *   4. upload to Drive                      ← the caller's `upload` function
 *   5. store the Drive id and link          ┐
 *   6. stamp who completed it and when      ├ one write, after the upload
 *   7. set status COMPLETED                 ┘
 *   8. notify the Sales Agent
 *
 * The ordering is the whole point. `upload` is awaited before a single field is
 * written, so a failed upload leaves the request exactly as it was — at Final
 * check, not completed, with nothing to unpick. That is §11.2's "if step 4
 * fails, steps 5–8 must not run", and it is why this takes the upload as a
 * function rather than doing the write first and uploading afterwards.
 *
 * @param {string} requestId
 * @param {(args:{ptaaId,propertyName,fileName,bytes}) => Promise<object>} upload
 * @param {(stage:string) => void} [onStage]  progress, for a long upload
 */
export async function completeRequest(requestId, upload, onStage = null) {
  const say = (s) => { if (onStage) onStage(s); };

  const req = await getRequest(requestId);
  if (!req) throw new Error(`${requestId} no longer exists.`);

  // 1 and 2.
  const blockers = completionBlockers(req);
  if (blockers.length) {
    throw new Error("This PTAA cannot be completed yet:\n\n" + blockers.map(b => "  " + b).join("\n"));
  }

  // 3. The filename is derived, never taken from the stored document — if the
  // request was edited after the document was generated, the stored name is
  // stale and the archive would get the wrong one.
  const fileName = ptaaFilename({
    propertyName: req.propertyName,
    unitNo: req.unitNo,
    ownerName: (req.owner || {}).name,
  });
  if (/\[(property|unit|owner)\]/.test(fileName)) {
    throw new Error(`The filename would be “${fileName}”. Fill in the missing details first — ` +
                    `a placeholder must never reach the archive.`);
  }

  say("Reading the document…");
  const wd = await loadWorkingDocument(requestId);
  if (!wd || !wd.bytes || !wd.bytes.length) {
    throw new Error("The stored document could not be read, so there is nothing to upload.");
  }

  // 4. If this throws, nothing below runs and nothing has changed.
  say(`Uploading to Google Drive as ${fileName}…`);
  const result = await upload({
    ptaaId: req.ptaaId,
    propertyName: req.propertyName,
    fileName,
    bytes: wd.bytes,
  });
  if (!result || !result.fileId) {
    throw new Error("Google Drive did not confirm the upload, so this PTAA has not been completed.");
  }

  // 5, 6 and 7 — one write, so the record can never hold a Drive link without
  // the completion stamp, or a COMPLETED status without a Drive link.
  say("Recording the completion…");
  await updateDoc(doc(db, "requests", requestId), {
    status: STATUS.COMPLETED,
    currentAction: ACTOR.NONE,
    drive: {
      fileId: result.fileId,
      fileName: result.fileName || fileName,
      webViewLink: result.webViewLink || null,
      folderId: result.folderId || null,
      folderName: result.folderName || req.propertyName || null,
      uploadedAt: new Date(),
      uploadedBy: session.email,
      replaced: !!result.replaced,
    },
    completedAt: serverTimestamp(),
    completedBy: session.email,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });

  await logRequestEvent(requestId, {
    action: "request.completed",
    summary: `Completed and filed to Google Drive as “${result.fileName || fileName}” ` +
             `in ${result.folderName || req.propertyName}` +
             `${result.folderCreated ? " (folder created)" : ""}` +
             `${result.replaced ? ", replacing the previous upload of this PTAA" : ""}.`,
    detail: { fileId: result.fileId, webViewLink: result.webViewLink || null },
  });
  await logActivity({
    action: "request.completed",
    summary: `${req.ptaaId} completed and filed to Drive.`,
    targetType: "request", targetId: requestId,
    detail: { fileId: result.fileId },
  });

  // 8.
  await notify({
    toEmail: req.agentEmail,
    request: req,
    event: "completed",
    text: NOTICES.completed(req),
  });

  return { fileName, ...result };
}

/** Brief §5.4: regenerating over manual edits destroys them, so it is deliberate. */
export async function clearManualEditFlag(requestId) {
  await updateDoc(doc(db, "requests", requestId), {
    manuallyEdited: false,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  await logRequestEvent(requestId, {
    action: "document.manual_edits_discarded",
    summary: "Confirmed that the manually edited document may be replaced by a fresh generation.",
  });
}

// ===========================================================================
// Solo workflow: the quotation, the invoice, and filing both to Drive
// ===========================================================================

/** What was read out of the quotation PDF, kept so the invoice can use it. */
export async function saveQuotationParse(requestId, parse) {
  await updateDoc(doc(db, "requests", requestId), {
    quotation: parse ? {
      fileName: parse.fileName || "",
      grandTotal: parse.grandTotal ?? null,
      projectName: parse.projectName || null,
      entries: (parse.entries || []).map(e => ({
        code: e.code || null, description: e.description || "",
        qty: Number(e.qty) || 0, unit: e.unit || "", price: e.price ?? null,
      })),
      parsedAt: serverTimestamp(),
    } : null,
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  if (parse) {
    await logRequestEvent(requestId, {
      action: "quotation.read",
      summary: `Read ${parse.entries.length} line${parse.entries.length === 1 ? "" : "s"} from the quotation` +
               (parse.grandTotal ? ` (grand total RM${Number(parse.grandTotal).toLocaleString("en-MY")}).` : "."),
    });
  }
}

const invoiceChunkPath = (requestId) => ["requests", requestId, "invoiceChunks"];

/** The invoice's details (not the file). Keeps whatever file is already there. */
export async function saveInvoiceData(requestId, data) {
  const current = await getRequest(requestId);
  const prev = (current && current.invoice) || {};
  await updateDoc(doc(db, "requests", requestId), {
    invoice: {
      invoiceNo: data.invoiceNo || "",
      date: data.date || "",
      billTo: data.billTo || "",
      remark: data.remark || "",
      items: (data.items || []).map(i => ({
        description: String(i.description || ""),
        qty: i.qty === "FOC" ? "FOC" : (Number(i.qty) || 0),
      })),
      total: Number(data.total) || 0,
      pay1: Number(data.pay1) || 0,
      pay2: Number(data.pay2) || 0,
      pay3: Number(data.pay3) || 0,
      pay4: Number(data.pay4) || 0,
      file: prev.file || null,
      none: false,
      costAck: prev.costAck || null,
    },
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
}

/**
 * Store the invoice .xlsx — the generated draft, or the confirmed one uploaded
 * after editing in Excel.
 */
export async function saveInvoiceFile(requestId, { fileName, bytes, source, confirmed = false }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertSize(data, "invoice");
  const current = await getRequest(requestId);
  const inv = (current && current.invoice) || {};
  const previousCount = (inv.file && inv.file.chunkCount) || 0;

  const chunkCount = await writeChunks(invoiceChunkPath(requestId), data);
  await updateDoc(doc(db, "requests", requestId), {
    invoice: {
      ...inv,
      file: {
        fileName, bytes: data.length, chunkCount, source, confirmed: !!confirmed,
        savedAt: new Date(), savedBy: session.email,
      },
    },
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  if (previousCount > chunkCount) {
    await deleteChunks(invoiceChunkPath(requestId), chunkCount, previousCount);
  }
  await logRequestEvent(requestId, {
    action: confirmed ? "invoice.confirmed" : "invoice.generated",
    summary: confirmed
      ? `Uploaded the confirmed invoice (${fileName}).`
      : `Drafted the invoice ${inv.invoiceNo || ""} (${fileName}).`,
  });
}

export async function loadInvoiceFile(requestId) {
  const r = await getRequest(requestId);
  const meta = r && r.invoice && r.invoice.file;
  if (!meta) return null;
  const bytes = await readChunks(invoiceChunkPath(requestId), meta.chunkCount, meta.bytes, "invoice");
  return { bytes, meta };
}

// ===========================================================================
// The finished PDF, shared with the Sales Agent
// ===========================================================================
// The one file a Sales Agent can download. The admin sends it — the complete
// PDF built in step 6, or a copy she uploads (e.g. after the Director signed).
// Stored like the Word file, as chunks; only an admin may write it.

const finalChunkPath = (requestId) => ["requests", requestId, "finalChunks"];

export async function shareFinalPdf(requestId, { fileName, bytes }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertSize(data, "PDF");
  const current = await getRequest(requestId);
  if (!current) throw new Error(`${requestId} no longer exists.`);
  const previousCount = (current.finalPdf && current.finalPdf.chunkCount) || 0;

  const chunkCount = await writeChunks(finalChunkPath(requestId), data);
  await updateDoc(doc(db, "requests", requestId), {
    finalPdf: {
      fileName, bytes: data.length, chunkCount,
      sharedAt: new Date(), sharedBy: session.email,
    },
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  });
  if (previousCount > chunkCount) {
    await deleteChunks(finalChunkPath(requestId), chunkCount, previousCount);
  }
  await logRequestEvent(requestId, {
    action: "final_pdf.shared",
    summary: `Sent the finished PDF to the Sales Agent (${fileName}).`,
  });
  const updated = await getRequest(requestId);
  if (updated && updated.agentEmail && updated.agentEmail !== session.email) {
    await notify({ toEmail: updated.agentEmail, request: updated, event: "final_pdf",
                   text: NOTICES.finalPdf(updated) });
  }
}

export async function unshareFinalPdf(requestId) {
  const current = await getRequest(requestId);
  const count = (current && current.finalPdf && current.finalPdf.chunkCount) || 0;
  await updateDoc(doc(db, "requests", requestId), {
    finalPdf: null, updatedAt: serverTimestamp(), lastActionBy: session.email,
  });
  await deleteChunks(finalChunkPath(requestId), 0, count);
  await logRequestEvent(requestId, {
    action: "final_pdf.withdrawn",
    summary: "Stopped sharing the finished PDF with the Sales Agent.",
  });
}

export async function loadFinalPdf(requestId) {
  const r = await getRequest(requestId);
  const meta = r && r.finalPdf;
  if (!meta) return null;
  const bytes = await readChunks(finalChunkPath(requestId), meta.chunkCount, meta.bytes, "PDF");
  return { bytes, meta };
}

// ===========================================================================
// Renovation cost vs the invoice total
// ===========================================================================

/** The admin confirms the two amounts differ on purpose. */
export async function acknowledgeCostDifference(requestId, { renovationCost, invoiceTotal }) {
  const current = await getRequest(requestId);
  const prev = (current && current.invoice) || {};
  await updateDoc(doc(db, "requests", requestId), {
    invoice: { ...prev, costAck: {
      renovationCost: renovationCost === "" || renovationCost == null ? null : Number(renovationCost),
      invoiceTotal: Number(invoiceTotal), by: session.email, at: new Date(),
    } },
    updatedAt: serverTimestamp(), lastActionBy: session.email,
  });
  const fmt = (n) => n === null || n === "" || n === undefined ? "NIL" : "RM" + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2 });
  await logRequestEvent(requestId, {
    action: "cost.acknowledged",
    summary: `Confirmed the renovation cost (${fmt(renovationCost)}) and the invoice total (${fmt(invoiceTotal)}) differ on purpose.`,
  });
}

/** Change the PTAA's renovation cost — the amount printed in the agreement. */
export async function setRenovationCost(requestId, amount) {
  const current = await getRequest(requestId);
  if (!current) throw new Error(`${requestId} no longer exists.`);
  const before = (current.financial || {}).renovationCost;
  const value = amount === "" || amount == null ? null : Math.round(Number(amount) * 100) / 100;
  await updateDoc(doc(db, "requests", requestId), {
    financial: { ...(current.financial || {}), renovationCost: value },
    updatedAt: serverTimestamp(), lastActionBy: session.email,
  });
  const fmt = (n) => n === null || n === undefined ? "NIL" : "RM" + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2 });
  await logRequestEvent(requestId, {
    action: "cost.changed",
    summary: `Renovation cost changed from ${fmt(before)} to ${fmt(value)} to match the invoice.`,
  });
}

/** Mark the draft as final without uploading an edited copy. */
export async function confirmDraft(requestId, which) {
  const r = await getRequest(requestId);
  if (!r) throw new Error(`${requestId} no longer exists.`);
  if (which === "ptaa") {
    if (!r.workingDoc) throw new Error("There is no PTAA draft yet.");
    await updateDoc(doc(db, "requests", requestId), {
      workingDoc: { ...r.workingDoc, confirmed: true },
      updatedAt: serverTimestamp(), lastActionBy: session.email,
    });
  } else {
    if (!(r.invoice && r.invoice.file)) throw new Error("There is no invoice draft yet.");
    await updateDoc(doc(db, "requests", requestId), {
      invoice: { ...r.invoice, file: { ...r.invoice.file, confirmed: true } },
      updatedAt: serverTimestamp(), lastActionBy: session.email,
    });
  }
  await logRequestEvent(requestId, {
    action: `${which}.confirmed`,
    summary: `Marked the ${which === "ptaa" ? "PTAA" : "invoice"} draft as the final version, unchanged.`,
  });
}

/** Everything that must be true before filing. Reasons, not a boolean. */
export function soloFilingBlockers(r) {
  const out = [];
  if (!r) return ["The PTAA could not be read."];
  if (r.status === STATUS.CANCELLED) out.push("This PTAA was cancelled.");
  if (!r.workingDoc) out.push("There is no PTAA document yet — draft it in step 2.");
  else if (!r.workingDoc.confirmed) out.push("The confirmed PTAA (Word) has not been uploaded yet.");
  if (noInvoice(r)) return out;
  const f = r.invoice && r.invoice.file;
  if (!f) out.push("There is no invoice yet — draft it in step 2, or tick “No invoice for this PTAA”.");
  else if (!f.confirmed) out.push("The confirmed invoice (Excel) has not been uploaded yet.");
  return out;
}

/** This PTAA goes ahead without an invoice (nothing to renovate, say). */
export const noInvoice = (r) => !!(r && r.invoice && r.invoice.none);

export async function setNoInvoice(requestId, none) {
  const current = await getRequest(requestId);
  const prev = (current && current.invoice) || {};
  await updateDoc(doc(db, "requests", requestId), {
    invoice: { ...prev, none: !!none },
    updatedAt: serverTimestamp(), lastActionBy: session.email,
  });
  await logRequestEvent(requestId, {
    action: none ? "invoice.not_needed" : "invoice.needed",
    summary: none ? "Marked as having no invoice — it can be filed and completed without one."
                  : "An invoice is needed for this PTAA after all.",
  });
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * File the confirmed PTAA and invoice to Drive, then — and only then — mark the
 * PTAA as filed. Same ordering rule as the team workflow: if either upload
 * fails, nothing about the request changes.
 *
 * @param {(a:object)=>Promise<object>} upload   drive.js → fileToDrive, bound to a token
 */
export async function fileSoloRequest(requestId, upload, onStage = null, options = {}) {
  const say = (s) => { if (onStage) onStage(s); };
  const req = await getRequest(requestId);
  const blockers = soloFilingBlockers(req);
  if (blockers.length) throw new Error("Not ready to file yet:\n\n" + blockers.map(b => "  " + b).join("\n"));

  const ptaaName = ptaaFilename({ propertyName: req.propertyName, unitNo: req.unitNo,
                                  ownerName: (req.owner || {}).name });
  const withInvoice = !noInvoice(req);
  const invoiceName = withInvoice ? req.invoice.file.fileName : "";
  // Invoices are kept as Google Sheets in Drive, named without the extension,
  // like every other invoice in the month folders.
  const settings = options.settings || {};
  const asSheet = settings.invoiceAsGoogleSheet !== false;
  const invoiceDriveName = asSheet ? invoiceName.replace(/\.xlsx$/i, "") : invoiceName;

  say("Reading the confirmed files…");
  const [wd, inv] = await Promise.all([loadWorkingDocument(requestId),
                                       withInvoice ? loadInvoiceFile(requestId) : Promise.resolve(null)]);
  if (!wd || !wd.bytes.length) throw new Error("The stored PTAA could not be read.");
  if (withInvoice && (!inv || !inv.bytes.length)) throw new Error("The stored invoice could not be read.");

  say(`Uploading ${ptaaName}…`);
  const p = await upload({ ptaaId: req.ptaaId, kind: "ptaa", propertyName: req.propertyName,
                           fileName: ptaaName, bytes: wd.bytes, mimeType: DOCX_MIME });
  if (withInvoice) say(`Uploading ${invoiceName}…`);
  const i = !withInvoice ? null : await upload({ ptaaId: req.ptaaId, kind: "invoice", propertyName: req.propertyName,
                           date: parseDateInput(req.invoice.date) || new Date(),
                           fileName: invoiceDriveName, bytes: inv.bytes, mimeType: XLSX_MIME,
                           convertTo: asSheet ? "application/vnd.google-apps.spreadsheet" : null });
  if (!p || !p.fileId || (withInvoice && (!i || !i.fileId))) {
    throw new Error("Google Drive did not confirm the upload, so this PTAA has not been marked as filed.");
  }

  say("Recording…");
  const now = new Date();
  const patch = {
    drive: {
      fileId: p.fileId, fileName: p.fileName, webViewLink: p.webViewLink || null,
      folderId: p.folderId || null, folderName: p.folderName || req.propertyName || null,
      uploadedAt: now, uploadedBy: session.email, replaced: !!p.replaced,
      invoice: i ? { fileId: i.fileId, fileName: i.fileName, webViewLink: i.webViewLink || null,
                     folderId: i.folderId || null, folderName: i.folderName || null } : null,
    },
    updatedAt: serverTimestamp(),
    lastActionBy: session.email,
  };
  if (req.status !== STATUS.COMPLETED) {
    patch.status = STATUS.COMPLETED;
    patch.currentAction = ACTOR.NONE;
    patch.completedAt = serverTimestamp();
    patch.completedBy = session.email;
  }
  await updateDoc(doc(db, "requests", requestId), patch);

  await logRequestEvent(requestId, {
    action: "request.filed",
    summary: `Filed to Google Drive: “${p.fileName}” in ${p.folderName || req.propertyName}` +
             (i ? `, “${i.fileName}” in ${i.folderName || "the invoice folder"}` : " (no invoice)") +
             `${p.folderCreated ? " (folder created)" : ""}${p.replaced || (i && i.replaced) ? ", replacing the earlier upload" : ""}.`,
    detail: { ptaaFileId: p.fileId, invoiceFileId: i ? i.fileId : null },
  });
  await logActivity({
    action: "request.filed", summary: `${req.ptaaId} filed to Drive.`,
    targetType: "request", targetId: requestId,
  });
  return { ptaa: p, invoice: i };
}

// ===========================================================================
// Per-request history (brief §14.1 — append-only)
// ===========================================================================

export async function logRequestEvent(requestId, { action, summary, detail = {} }) {
  try {
    await addDoc(collection(db, "requests", requestId, "activity"), {
      at: serverTimestamp(),
      actorEmail: session.email,
      actorRole: session.role,
      action, summary, detail,
    });
  } catch (err) {
    console.error("[request-activity] could not write entry:", action, err);
  }
}

export async function listRequestActivity(requestId, max = 200) {
  const snap = await getDocs(query(
    collection(db, "requests", requestId, "activity"),
    orderBy("at", "desc"), limit(max),
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ===========================================================================
// Dashboard groupings
// ===========================================================================

export function isOpen(r)   { return OPEN_STATUSES.includes(r.status); }
export function isClosed(r) { return CLOSED_STATUSES.includes(r.status); }

export function needsAction(r, actor) {
  return isOpen(r) && r.currentAction === actor;
}
