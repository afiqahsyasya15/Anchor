// ---------------------------------------------------------------------------
// drafts.js — a PTAA saved half-way, before it is submitted.
//
// A draft is NOT a request: it has no PTAA number (so an abandoned draft never
// leaves a gap in the numbering), the admin never sees it, and it can be
// deleted outright. On submit it becomes a real request and the draft goes.
//
//   drafts/{id}          { agentEmail, form, agentId, quotation, title, createdAt, updatedAt }
//   drafts/{id}/files/*  one per attached picture (I/C front/back, quotation pages)
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, setDoc, deleteDoc, collection, getDocs, addDoc,
  query, where, serverTimestamp, toDate,
} from "./core.js";
import { session } from "./auth.js";

/** A short name for a draft in a list, from whatever has been typed so far. */
export function draftTitle(form) {
  const f = form || {};
  const where_ = [f.propertyName, f.unitNo].filter(Boolean).join(" ").trim();
  const who = ((f.owner || {}).name || "").trim().toUpperCase();
  return [where_, who].filter(Boolean).join(" · ") || "Untitled draft";
}

export async function listMyDrafts() {
  const snap = await getDocs(query(collection(db, "drafts"), where("agentEmail", "==", session.email)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => {
      const at = toDate(a.updatedAt), bt = toDate(b.updatedAt);
      return (bt ? bt.getTime() : 0) - (at ? at.getTime() : 0);
    });
}

export async function getDraft(id) {
  const snap = await getDoc(doc(db, "drafts", id));
  if (!snap.exists()) return null;
  const files = await getDocs(collection(db, "drafts", id, "files"));
  return {
    id: snap.id, ...snap.data(),
    files: files.docs.map(d => ({ draftFileId: d.id, ...d.data() }))
      .sort((a, b) => (a.order || 0) - (b.order || 0)),
  };
}

/**
 * Save the form as it stands. `files` are the attachments held in memory; a
 * file already stored (it has draftFileId) is not written again, and stored
 * files that are no longer attached are removed. Returns the draft id.
 */
export async function saveDraft(id, { form, agentId = "", quotation = null, files = [] }) {
  const draftId = id || newDraftId();
  const ref = doc(db, "drafts", draftId);
  const existing = id ? await getDoc(ref) : null;
  await setDoc(ref, {
    agentEmail: session.email,
    form: JSON.parse(JSON.stringify(form)),
    agentId: agentId || "",
    quotation: quotation ? JSON.parse(JSON.stringify(quotation)) : null,
    title: draftTitle(form),
    createdAt: existing && existing.exists() ? existing.data().createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const stored = await getDocs(collection(db, "drafts", draftId, "files"));
  const keep = new Set(files.map(f => f.draftFileId).filter(Boolean));
  for (const d of stored.docs) {
    if (!keep.has(d.id)) await deleteDoc(doc(db, "drafts", draftId, "files", d.id));
  }
  let order = 0;
  for (const f of files) {
    order++;
    if (f.draftFileId) continue;
    const added = await addDoc(collection(db, "drafts", draftId, "files"), {
      kind: f.kind, name: f.name || "", dataUrl: f.dataUrl, bytes: f.bytes || 0,
      width: f.width || null, height: f.height || null, page: f.page || null, order,
      bothSides: !!f.bothSides,
    });
    f.draftFileId = added.id;
  }
  return draftId;
}

function newDraftId() {
  return "D" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 7).toUpperCase();
}

export async function deleteDraft(id) {
  const files = await getDocs(collection(db, "drafts", id, "files"));
  for (const d of files.docs) await deleteDoc(doc(db, "drafts", id, "files", d.id));
  await deleteDoc(doc(db, "drafts", id));
}
