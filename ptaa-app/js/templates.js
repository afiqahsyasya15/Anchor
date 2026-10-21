// ---------------------------------------------------------------------------
// templates.js — the PTAA Word template.
//
// ONE template serves every condo: the condo's name and address come from the
// Condos list ({{property_full_address}}), so adding a condo needs no Word
// file at all. It is stored as templates/default. A condo may still have a
// template of its own from before (templates/<propertyId>); that is used only
// while no shared template has been uploaded.
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, setDoc, deleteDoc, collection, getDocs,
  serverTimestamp, logActivity,
} from "./core.js";
import { session } from "./auth.js";
import { writeChunks, readChunks, deleteChunks, assertSize } from "./chunks.js";

const chunkPath = (propertyId) => ["templates", propertyId, "chunks"];

/** The document ID of the one template every condo uses. */
export const SHARED_TEMPLATE_ID = "default";

/** The template a PTAA for this condo is drafted from, or null. */
export async function getEffectiveTemplateMeta(propertyId) {
  const shared = await getTemplateMeta(SHARED_TEMPLATE_ID);
  if (shared) return shared;
  return propertyId ? getTemplateMeta(propertyId) : null;
}

export async function loadEffectiveTemplateBytes(propertyId, onProgress = null) {
  const meta = await getEffectiveTemplateMeta(propertyId);
  if (!meta) return null;
  return readChunks(chunkPath(meta.id), meta.chunkCount, meta.bytes, "PTAA template", onProgress);
}

export async function getTemplateMeta(propertyId) {
  const snap = await getDoc(doc(db, "templates", propertyId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function listTemplates() {
  const snap = await getDocs(collection(db, "templates"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Store a validated template against a property.
 * @param {object} info { propertyName, fileName, buffer, found, loops }
 */
export async function saveTemplate(propertyId, { propertyName, fileName, buffer, found, loops }, onProgress = null) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  assertSize(bytes, "template");

  const previous = await getTemplateMeta(propertyId);

  // Chunks first, metadata second. If this fails halfway the old metadata still
  // points at the old chunk count, so the previous template keeps working.
  const chunkCount = await writeChunks(chunkPath(propertyId), bytes, onProgress);

  await setDoc(doc(db, "templates", propertyId), {
    propertyId,
    propertyName: propertyName || "",
    fileName: fileName || "template.docx",
    bytes: bytes.length,
    chunkCount,
    placeholders: found || [],
    loops: loops || [],
    version: (previous && Number(previous.version) || 0) + 1,
    uploadedBy: session.email,
    uploadedAt: serverTimestamp(),
  });

  // Only now drop leftovers from a previous, longer template.
  if (previous && previous.chunkCount > chunkCount) {
    await deleteChunks(chunkPath(propertyId), chunkCount, previous.chunkCount);
  }

  await logActivity({
    action: previous ? "template.replaced" : "template.uploaded",
    summary: `${previous ? "Replaced" : "Uploaded"} the PTAA template for ${propertyName || propertyId} ` +
             `(${fileName}, ${(bytes.length / 1024).toFixed(0)} KB).`,
    targetType: "template", targetId: propertyId,
    detail: { fileName, bytes: bytes.length, chunkCount },
  });

  return chunkCount;
}

/** Reassemble a stored template. Returns a Uint8Array, or null if none. */
export async function loadTemplateBytes(propertyId, onProgress = null) {
  const meta = await getTemplateMeta(propertyId);
  if (!meta) return null;
  return readChunks(chunkPath(propertyId), meta.chunkCount, meta.bytes,
                    `template for ${meta.propertyName || propertyId}`, onProgress);
}

export async function deleteTemplate(propertyId, propertyName) {
  const meta = await getTemplateMeta(propertyId);
  if (!meta) return;
  await deleteChunks(chunkPath(propertyId), 0, meta.chunkCount);
  await deleteDoc(doc(db, "templates", propertyId));
  await logActivity({
    action: "template.removed",
    summary: `Removed the PTAA template for ${propertyName || propertyId}. ` +
             `Documents cannot be generated for this property until a new one is uploaded.`,
    targetType: "template", targetId: propertyId,
  });
}
