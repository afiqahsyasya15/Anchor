// ---------------------------------------------------------------------------
// notifications.js — in-app notifications (brief §14.2).
//
// In-app only. The brief is explicit: do not build a fake email path. When
// email is actually configured and working, this is where it would hook in.
//
// Each notification names a PTAA and links to it, in the wording the brief
// gives as an example:
//   "PTAA (M ASTRA A-18-09) LOY HUI TING is ready for you."
// ---------------------------------------------------------------------------

import {
  db, doc, updateDoc, collection, getDocs, addDoc,
  query, where, orderBy, limit, serverTimestamp, toDate,
} from "./core.js";
import { session } from "./auth.js";
import { ptaaFilename } from "./model.js";

/** The document name, minus the .docx, is how a PTAA is referred to in prose. */
export function ptaaLabel(request) {
  return ptaaFilename({
    propertyName: request.propertyName, unitNo: request.unitNo,
    ownerName: (request.owner || {}).name,
  }).replace(/\.docx$/, "");
}

/**
 * Write one notification. Silent on failure — a notification that does not
 * arrive must never roll back the action that caused it.
 */
export async function notify({ toEmail, request, text, event }) {
  if (!toEmail) return;
  try {
    await addDoc(collection(db, "notifications"), {
      forEmail: String(toEmail).trim().toLowerCase(),
      requestId: request ? request.ptaaId || request.id : null,
      ptaaLabel: request ? ptaaLabel(request) : null,
      text,
      event,
      createdAt: serverTimestamp(),
      createdBy: session.email,
      readAt: null,
    });
  } catch (err) {
    console.error("[notifications] could not deliver:", event, err);
  }
}

/** The six moments brief §14.2 lists, all addressed to the Sales Agent. */
export const NOTICES = {
  submitted:  (r) => `${ptaaLabel(r)} has been submitted and is with the PTAA Admin.`,
  changes:    (r, note) => `Changes are needed on ${ptaaLabel(r)}${note ? `: “${note}”` : "."}`,
  ptaaOk:     (r) => `${ptaaLabel(r)} has been checked and marked PTAA OK.`,
  ready:      (r) => `${ptaaLabel(r)} is ready for you.`,
  signature:  (r, detail) => `Signature update on ${ptaaLabel(r)}${detail ? `: ${detail}` : "."}`,
  completed:  (r) => `${ptaaLabel(r)} is completed and filed.`,
  finalPdf:   (r) => `${ptaaLabel(r)} is ready — the finished PDF can be downloaded.`,
  onHold:     (r, reason) => `${ptaaLabel(r)} has been put on hold — ${reason}.`,
  resumed:    (r) => `${ptaaLabel(r)} is moving again.`,
  cancelled:  (r, reason) => `${ptaaLabel(r)} has been cancelled — ${reason}.`,
};

// --- Reading ----------------------------------------------------------------

/**
 * A single-field equality query, so Firestore needs no composite index. Sorting
 * happens in the browser; at this volume that is cheaper than a manual index.
 */
export async function listMyNotifications({ max = 100 } = {}) {
  const snap = await getDocs(query(
    collection(db, "notifications"),
    where("forEmail", "==", session.email),
  ));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = toDate(a.createdAt), bt = toDate(b.createdAt);
      return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0);
    })
    .slice(0, max);
}

export function unreadCount(items) {
  return items.filter(n => !n.readAt).length;
}

export async function markRead(id) {
  await updateDoc(doc(db, "notifications", id), { readAt: serverTimestamp() });
}

export async function markAllRead(items) {
  for (const n of items.filter(x => !x.readAt)) {
    await updateDoc(doc(db, "notifications", n.id), { readAt: serverTimestamp() }).catch(() => {});
  }
}
