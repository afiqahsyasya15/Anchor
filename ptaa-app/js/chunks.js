// ---------------------------------------------------------------------------
// chunks.js — storing a binary file in Firestore, split across documents.
//
// Firestore caps a document at 1 MiB, and Cloud Storage needs the Blaze plan
// (this project is on Spark), so .docx files are base64-encoded and written in
// slices. Used for both the per-condo templates and each request's working
// document.
// ---------------------------------------------------------------------------

import { db, doc, getDoc, setDoc, deleteDoc } from "./core.js";
import { bytesToBase64, base64ToBytes } from "./docx.js";

/**
 * Base64 characters per document.
 *
 * Firestore's hard limit is 1 MiB per document, so 700 KB "fits". It was still
 * the wrong number: the bigger each write, the likelier it is to stall on a
 * slow or proxied connection, and a stalled write is retried silently forever
 * (see core.js). 250 KB means more round trips, each of which either completes
 * or fails quickly, and it makes real progress reportable.
 */
export const CHUNK_SIZE = 250_000;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** A single write that has not completed in this long is not going to. */
const WRITE_TIMEOUT_MS = 45_000;

export function assertSize(bytes, what = "file") {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(`That ${what} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. ` +
      `The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB — compress the images inside it and try again.`);
  }
}

/**
 * The Firestore SDK never rejects a write it cannot deliver; it queues and
 * retries until the connection recovers. That is right for a one-line status
 * change and wrong for a 4 MB upload, where it presents to the user as a button
 * that does nothing. This converts "hangs forever" into an error we can explain.
 */
function withTimeout(promise, what) {
  let timer;
  const bail = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${what} did not complete within ${WRITE_TIMEOUT_MS / 1000} seconds. ` +
      `The connection to the database is being blocked or is very slow. ` +
      `Nothing has been lost — try again on a different network, and if it keeps ` +
      `happening the file is probably too large to upload from here.`)), WRITE_TIMEOUT_MS);
  });
  return Promise.race([promise, bail]).finally(() => clearTimeout(timer));
}

/**
 * Write bytes into `<...path>/{0..n-1}`.
 * @param {string[]} path      collection path segments, e.g. ["templates","p1","chunks"]
 * @param {Uint8Array} bytes
 * @param {(done:number, total:number) => void} [onProgress]
 * @returns {Promise<number>} how many chunks were written
 */
export async function writeChunks(path, bytes, onProgress = null) {
  const b64 = bytesToBase64(bytes);
  const count = Math.max(1, Math.ceil(b64.length / CHUNK_SIZE));
  if (onProgress) onProgress(0, count);
  for (let i = 0; i < count; i++) {
    await withTimeout(
      setDoc(doc(db, ...path, String(i)), { data: b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) }),
      `Part ${i + 1} of ${count}`);
    if (onProgress) onProgress(i + 1, count);
  }
  return count;
}

/** Read chunks back and verify the result is the size that was stored. */
export async function readChunks(path, chunkCount, expectedBytes, label = "file", onProgress = null) {
  let b64 = "";
  if (onProgress) onProgress(0, chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const snap = await withTimeout(
      getDoc(doc(db, ...path, String(i))), `Part ${i + 1} of ${chunkCount}`);
    if (!snap.exists()) {
      throw new Error(`The stored ${label} is incomplete — part ${i + 1} of ${chunkCount} is missing. ` +
        `Upload it again.`);
    }
    b64 += snap.data().data || "";
    if (onProgress) onProgress(i + 1, chunkCount);
  }
  const bytes = base64ToBytes(b64);
  if (expectedBytes != null && bytes.length !== expectedBytes) {
    throw new Error(`The stored ${label} did not reassemble to its original size ` +
      `(${bytes.length} bytes, expected ${expectedBytes}). Upload it again.`);
  }
  return bytes;
}

/** Remove chunks `from`..`to-1`, ignoring ones that are already gone. */
export async function deleteChunks(path, from, to) {
  for (let i = from; i < to; i++) {
    await deleteDoc(doc(db, ...path, String(i))).catch(() => {});
  }
}
