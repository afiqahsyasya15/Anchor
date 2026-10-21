// ---------------------------------------------------------------------------
// signatures.js — the signature images, and where they are kept.
//
// Two kinds:
//   shared:<slug>   company signatures — the Director's, for instance. Uploaded
//                   and managed by admins.
//   user:<email>    a person's own signature, uploaded on their profile page.
//
// Brief §10 still holds where it matters: a signature is never applied
// automatically. Placing one is an explicit choice made at generation time, it
// is previewed first, and who applied which is written to the request history.
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, setDoc, deleteDoc, collection, getDocs,
  serverTimestamp, logActivity,
} from "./core.js";
import { session } from "./auth.js";
import { writeChunks, readChunks, deleteChunks, assertSize } from "./chunks.js";
import { pngSize } from "./docximage.js";

/** Word needs a PNG here — a JPEG has no transparency and prints a white box. */
const PNG_MIME = "image/png";

/** Large enough to stay crisp at 2 cm tall, small enough to store comfortably. */
const MAX_EDGE = 1200;
export const MAX_SIGNATURE_BYTES = 600 * 1024;

export const sharedKey = (slug) => "shared:" + String(slug).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
export const userKey = (email) => "user:" + String(email || "").trim().toLowerCase();

export function isUserKey(key) { return String(key).startsWith("user:"); }
export function keyEmail(key) { return isUserKey(key) ? String(key).slice(5) : null; }

const chunkPath = (key) => ["signatures", key, "chunks"];

// --- Preparing a file -------------------------------------------------------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function fileBytes(file) {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Read a signature file, shrink it if it is large, and always end up with a PNG
 * so the transparency survives into the Word document.
 * @returns {Promise<{bytes, width, height, name, warning}>}
 */
export async function prepareSignature(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("A signature must be an image file.");
  }

  let warning = null;
  if (file.type !== PNG_MIME) {
    warning = "That was not a PNG, so it has been converted. A JPEG has no transparent " +
              "background, which usually shows as a white box over the signature line — " +
              "a PNG with a transparent background gives a much better result.";
  }

  // A PNG that is already a sensible size is used untouched, so nothing is lost.
  if (file.type === PNG_MIME) {
    const bytes = await fileBytes(file);
    const size = pngSize(bytes);
    if (Math.max(size.width, size.height) <= MAX_EDGE && bytes.length <= MAX_SIGNATURE_BYTES) {
      return { bytes, width: size.width, height: size.height, name: file.name || "signature.png", warning };
    }
  }

  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);   // no fill: keep alpha
  const bytes = dataUrlToBytes(canvas.toDataURL(PNG_MIME));

  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw new Error("That signature image is too large even after shrinking. " +
                    "Crop it closer to the signature and try again.");
  }
  return { bytes, width: w, height: h, name: (file.name || "signature").replace(/\.\w+$/, "") + ".png", warning };
}

// --- Storage ----------------------------------------------------------------

export async function listSignatures() {
  const snap = await getDocs(collection(db, "signatures"));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
                  .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

export async function getSignatureMeta(key) {
  const snap = await getDoc(doc(db, "signatures", key));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function saveSignature(key, { label, bytes, width, height, name, isDirector = false }) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  assertSize(data, "signature");

  const previous = await getSignatureMeta(key);
  const chunkCount = await writeChunks(chunkPath(key), data);

  await setDoc(doc(db, "signatures", key), {
    key,
    kind: isUserKey(key) ? "user" : "shared",
    ownerEmail: keyEmail(key),
    label: label || name || key,
    fileName: name || "signature.png",
    bytes: data.length, chunkCount, width, height,
    isDirector: !!isDirector,
    uploadedBy: session.email,
    uploadedAt: serverTimestamp(),
  });

  if (previous && previous.chunkCount > chunkCount) {
    await deleteChunks(chunkPath(key), chunkCount, previous.chunkCount);
  }

  await logActivity({
    action: previous ? "signature.replaced" : "signature.uploaded",
    summary: `${previous ? "Replaced" : "Uploaded"} the signature “${label || key}”.`,
    targetType: "signature", targetId: key,
  });
}

/**
 * Exactly one signature carries the Director mark, because that is the one the
 * Director slot offers first. Setting it clears the mark from any other.
 */
export async function setDirectorSignature(key) {
  const all = await listSignatures();
  for (const s of all) {
    const should = s.id === key;
    if (!!s.isDirector === should) continue;
    await setDoc(doc(db, "signatures", s.id), { isDirector: should }, { merge: true });
  }
  const chosen = all.find(s => s.id === key);
  await logActivity({
    action: "signature.director_set",
    summary: `“${(chosen && chosen.label) || key}” is now the Director's signature.`,
    targetType: "signature", targetId: key,
  });
}

export async function loadSignatureBytes(key) {
  const meta = await getSignatureMeta(key);
  if (!meta) return null;
  return readChunks(chunkPath(key), meta.chunkCount, meta.bytes, `signature “${meta.label || key}”`);
}

export async function deleteSignature(key, label) {
  const meta = await getSignatureMeta(key);
  if (!meta) return;
  await deleteChunks(chunkPath(key), 0, meta.chunkCount);
  await deleteDoc(doc(db, "signatures", key));
  await logActivity({
    action: "signature.removed",
    summary: `Removed the signature “${label || key}”.`,
    targetType: "signature", targetId: key,
  });
}

// --- Choosing which signature goes where ------------------------------------

/**
 * Sensible starting choices for one request: the Director's shared signature,
 * the agent's own, and the signed-in admin's own. The admin can change any of
 * them before generating, and nothing is applied without that confirmation.
 */
export function defaultSignatureChoice(request, available) {
  const byKey = new Map(available.map(s => [s.id, s]));
  const director = available.find(s => s.isDirector) ||
                   available.find(s => s.kind === "shared");
  return {
    sig_director: director ? director.id : "",
    sig_agent:    byKey.has(userKey(request.agentEmail)) ? userKey(request.agentEmail) : "",
    sig_admin:    byKey.has(userKey(session.email)) ? userKey(session.email) : "",
  };
}
