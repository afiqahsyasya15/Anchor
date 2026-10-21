// ---------------------------------------------------------------------------
// property-requests.js — a Sales Agent asking for a condo to be added.
//
// Agents pick a property from a list rather than typing one, because that name
// becomes the Drive folder and part of the filename. So when they take on a
// condo that is not on the list they need a way to ask, rather than being stuck.
//
// The admin still decides: approving is what creates the property, with the
// spelling the admin settles on.
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, updateDoc, collection, getDocs, addDoc,
  query, where, serverTimestamp, toDate, logActivity,
} from "./core.js";
import { session } from "./auth.js";
import { createProperty } from "./requests.js";
import { notify } from "./notifications.js";

export const PROPERTY_REQUEST_STATUS = {
  PENDING:  "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

export async function createPropertyRequest({ name, address, note }) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("The condo name is required.");

  const ref = await addDoc(collection(db, "propertyRequests"), {
    name: clean,
    address: String(address || "").trim(),
    note: String(note || "").trim(),
    status: PROPERTY_REQUEST_STATUS.PENDING,
    requestedBy: session.email,
    requestedAt: serverTimestamp(),
    decidedBy: null, decidedAt: null, decisionNote: null, propertyId: null,
  });

  await logActivity({
    action: "property_request.created",
    summary: `Sales Agent asked for a new property: “${clean}”.`,
    targetType: "propertyRequest", targetId: ref.id,
  });
  return ref.id;
}

/** Agents see only their own; the rules enforce that too. */
export async function listPropertyRequests({ mine = false } = {}) {
  const base = collection(db, "propertyRequests");
  const q = mine ? query(base, where("requestedBy", "==", session.email)) : base;
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = toDate(a.requestedAt), bt = toDate(b.requestedAt);
      return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0);
    });
}

export function pendingCount(items) {
  return items.filter(r => r.status === PROPERTY_REQUEST_STATUS.PENDING).length;
}

/**
 * Approving creates the property. The admin can correct the name first — the
 * agent's spelling is a suggestion, not the record.
 */
export async function approvePropertyRequest(id, { name, address, picNickname, picMobile } = {}) {
  const snap = await getDoc(doc(db, "propertyRequests", id));
  if (!snap.exists()) throw new Error("That request no longer exists.");
  const req = snap.data();

  const propertyId = await createProperty({
    name: name || req.name,
    address: address || req.address,
    picNickname, picMobile,
  });

  await updateDoc(doc(db, "propertyRequests", id), {
    status: PROPERTY_REQUEST_STATUS.APPROVED,
    decidedBy: session.email,
    decidedAt: serverTimestamp(),
    propertyId,
  });

  await logActivity({
    action: "property_request.approved",
    summary: `Approved “${name || req.name}” and added it to the property list.`,
    targetType: "propertyRequest", targetId: id,
  });
  await notify({
    toEmail: req.requestedBy, request: null, event: "property_request.approved",
    text: `“${name || req.name}” has been added to the property list. You can submit a PTAA request for it now.`,
  });
  return propertyId;
}

export async function rejectPropertyRequest(id, reason) {
  const snap = await getDoc(doc(db, "propertyRequests", id));
  if (!snap.exists()) throw new Error("That request no longer exists.");
  const req = snap.data();

  await updateDoc(doc(db, "propertyRequests", id), {
    status: PROPERTY_REQUEST_STATUS.REJECTED,
    decidedBy: session.email,
    decidedAt: serverTimestamp(),
    decisionNote: String(reason || "").trim(),
  });

  await logActivity({
    action: "property_request.rejected",
    summary: `Declined the request for “${req.name}” — ${reason || "no reason given"}.`,
    targetType: "propertyRequest", targetId: id,
  });
  await notify({
    toEmail: req.requestedBy, request: null, event: "property_request.rejected",
    text: `Your request to add “${req.name}” was declined${reason ? `: ${reason}` : "."}`,
  });
}
