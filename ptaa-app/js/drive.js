// ---------------------------------------------------------------------------
// drive.js — filing finished PTAAs and invoices into Google Drive.
//
// HOW IT WORKS NOW
// ----------------
// The upload happens straight from the admin's browser, as the admin's own
// Google account. When a file is to be filed, Google asks — in a pop-up, once
// an hour at most — for permission to use Drive. The token that comes back
// lives only in this tab's memory for about an hour and is never stored.
//
// That replaced an earlier design (a Cloudflare Pages Function holding a
// company refresh token). That design needed a server, four secrets and a
// command-line deploy; this one needs none of them and works on the plain
// static site. The trade: only someone who can reach the Drive folder can
// file into it — which, for one admin filing into her own folder, is exactly
// right. See README → "Connecting Google Drive".
//
// WHAT IT WILL AND WILL NOT DO
// ----------------------------
//   - It only ever writes inside the folder set under Settings (and one
//     sub-folder per property, found by name and reused, never duplicated).
//   - It replaces a file it filed earlier for the same PTAA (tagged with the
//     PTAA number), and refuses to overwrite a same-named file it did not put
//     there.
//   - It never deletes anything.
// ---------------------------------------------------------------------------

import { auth, GoogleAuthProvider, reauthenticateWithPopup } from "./core.js";
import { getSettings, destinationOf, monthFolderName } from "./directory.js";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const TAG = "anchorPtaa";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const DRIVE_STATE = {
  OK:             "ok",
  NOT_CONFIGURED: "not_configured",     // no folder chosen under Settings
  DISCONNECTED:   "drive_disconnected", // permission refused or expired
  FAILED:         "drive_failed",
};

export class DriveError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "DriveError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

let cached = null;           // { token, expires }

export function forgetDriveToken() { cached = null; }

/**
 * An access token for Drive. The first call in a session opens Google's
 * pop-up, so it must be called straight from a click — before any other await —
 * or the browser's pop-up blocker will stop it.
 */
export async function driveToken({ fresh = false } = {}) {
  if (!fresh && cached && cached.expires > Date.now() + 60_000) return cached.token;
  const user = auth.currentUser;
  if (!user) throw new DriveError("unauthenticated", "You are not signed in any more. Reload the page.");

  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  provider.setCustomParameters({ login_hint: user.email || "" });

  let result;
  try {
    result = await reauthenticateWithPopup(user, provider);
  } catch (err) {
    const code = err && err.code;
    if (code === "auth/popup-blocked") {
      throw new DriveError("popup_blocked",
        "Your browser blocked Google's pop-up. Allow pop-ups for this site, then press the button again.");
    }
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      throw new DriveError(DRIVE_STATE.DISCONNECTED, "Google Drive permission was not given, so nothing was filed.");
    }
    if (code === "auth/user-mismatch") {
      throw new DriveError(DRIVE_STATE.DISCONNECTED,
        `Choose the same Google account you are signed in with (${user.email}).`);
    }
    throw new DriveError(DRIVE_STATE.FAILED, "Google did not give Drive permission: " + (err.message || code));
  }

  const cred = GoogleAuthProvider.credentialFromResult(result);
  const token = cred && cred.accessToken;
  if (!token) {
    throw new DriveError(DRIVE_STATE.DISCONNECTED, "Google did not return a Drive permission. Try again.");
  }
  cached = { token, expires: Date.now() + 50 * 60_000 };
  return token;
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function call(url, { method = "GET", token, headers = {}, body = null, raw = false } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  } catch {
    throw new DriveError(DRIVE_STATE.FAILED, "Could not reach Google Drive. Check the internet connection and try again.");
  }
  if (raw && res.ok) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw explain(res.status, data);
  return data;
}

function explain(status, data) {
  const err = (data && data.error) || {};
  const reason = ((err.errors || [])[0] || {}).reason || err.status || "";
  const msg = err.message || `HTTP ${status}`;
  if (status === 401) {
    cached = null;
    return new DriveError(DRIVE_STATE.DISCONNECTED, "The Google Drive permission has expired. Press the button again.");
  }
  if (reason === "accessNotConfigured" || /has not been used|is disabled/i.test(msg)) {
    return new DriveError("api_disabled",
      "The Google Drive API is switched off for this Firebase project. Turn it on once — see README → " +
      "“Connecting Google Drive”, step 1 — then try again.", msg);
  }
  if (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient/i.test(msg)) {
    cached = null;
    return new DriveError(DRIVE_STATE.DISCONNECTED,
      "Google Drive permission was not fully given. Press the button again and tick the Drive box on Google's screen.");
  }
  if (status === 404) {
    return new DriveError("folder_missing",
      "That Google Drive folder cannot be found from this account. Check the folder link under Settings, " +
      "and that this Google account can open it.", msg);
  }
  if (status === 403) {
    return new DriveError("forbidden", "Google Drive refused: " + msg, msg);
  }
  return new DriveError(DRIVE_STATE.FAILED, "Google Drive: " + msg, msg);
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function getFolder(token, id) {
  const f = await call(`${API}/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`, { token });
  if (f.mimeType !== FOLDER_MIME) {
    throw new DriveError("folder_missing", `“${f.name}” is a file, not a folder. Choose a folder under Settings.`);
  }
  if (f.trashed) throw new DriveError("folder_missing", `The folder “${f.name}” is in the Drive bin.`);
  return f;
}

async function listChildren(token, parentId, extra = "") {
  const params = new URLSearchParams({
    q: `'${q(parentId)}' in parents and trashed = false${extra}`,
    fields: "files(id,name,mimeType,webViewLink,appProperties)",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const r = await call(`${API}?${params}`, { token });
  return r.files || [];
}

/** Find a sub-folder by name (ignoring case), or create it. */
async function folderFor(token, parentId, name) {
  const wanted = String(name || "").trim();
  const folders = await listChildren(token, parentId, ` and mimeType = '${FOLDER_MIME}'`);
  const hit = folders.find(f => f.name.trim().toLowerCase() === wanted.toLowerCase());
  if (hit) return { id: hit.id, name: hit.name, created: false };
  const made = await call(`${API}?supportsAllDrives=true&fields=id,name`, {
    method: "POST", token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: wanted, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return { id: made.id, name: made.name, created: true };
}

/** Upload bytes as a new file or new content for an existing one. */
async function sendFile(token, { fileId = null, metadata, bytes, mimeType }) {
  const fields = "id,name,webViewLink";
  const blob = new Blob([bytes], { type: mimeType });

  // Resumable upload: fine for any size.
  try {
    const start = await call(
      fileId
        ? `${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=resumable&supportsAllDrives=true&fields=${fields}`
        : `${UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=${fields}`,
      {
        method: fileId ? "PATCH" : "POST", token, raw: true,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(bytes.length),
        },
        body: JSON.stringify(metadata),
      });
    const location = start.headers.get("Location") || start.headers.get("location");
    if (location) {
      let res;
      try {
        res = await fetch(location, { method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType }, body: blob });
      } catch {
        const e = new DriveError(DRIVE_STATE.FAILED, "The upload to Google Drive was interrupted. Check the connection and try again.");
        e.stage = "upload";
        throw e;
      }
      const text = await res.text();
      let data = {}; try { data = JSON.parse(text); } catch { /* keep {} */ }
      if (!res.ok) { const e = explain(res.status, data); e.stage = "upload"; throw e; }
      return data;
    }
  } catch (err) {
    // Only a session that could not be STARTED falls back to a single-request
    // upload. Anything that went wrong once the bytes were on their way is
    // reported, not retried behind the person's back.
    if (!(err instanceof DriveError) || err.code !== DRIVE_STATE.FAILED || err.stage === "upload") throw err;
  }

  const boundary = "anchor" + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return call(
    fileId
      ? `${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=${fields}`
      : `${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=${fields}`,
    { method: fileId ? "PATCH" : "POST", token,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

/**
 * File one document.
 *
 * @param {object} a
 *   ptaaId, kind ("ptaa"|"invoice"), propertyName, fileName, bytes, mimeType
 * @param {object} [opts]  { token, settings }
 * @returns {Promise<{fileId,fileName,webViewLink,folderId,folderName,folderCreated,replaced}>}
 */
export async function fileToDrive(a, opts = {}) {
  if (!a.bytes || !a.bytes.length) throw new DriveError("no_document", "There is no file to upload.");
  const settings = opts.settings || await getSettings();
  const dest = destinationOf(settings, a.kind);
  if (!dest.id) {
    throw new DriveError(DRIVE_STATE.NOT_CONFIGURED,
      `No Google Drive folder has been chosen for ${a.kind === "invoice" ? "invoices" : "PTAAs"} yet. ` +
      "Paste the folder link under Settings.");
  }
  const token = opts.token || await driveToken();

  const root = await getFolder(token, dest.id);
  let folder = { id: root.id, name: root.name, created: false };
  // Invoices: the month's folder first ("SEP 26 INV"), found by name and reused.
  if (dest.monthFolders) {
    const m = await folderFor(token, folder.id, monthFolderName(dest.monthPattern, a.date || new Date()));
    folder = { ...m, name: `${root.name} / ${m.name}` };
  }
  if (dest.subfolder && a.propertyName) {
    const c = await folderFor(token, folder.id, a.propertyName);
    folder = { ...c, name: `${folder.name} / ${c.name}`, created: folder.created || c.created };
  }

  const tagValue = `${a.ptaaId}:${a.kind}`;
  const siblings = await listChildren(token, folder.id, ` and mimeType != '${FOLDER_MIME}'`);
  const mine = siblings.find(f => (f.appProperties || {})[TAG] === tagValue);
  const sameName = siblings.find(f => f.name === a.fileName && f !== mine);

  if (sameName && !mine) {
    const other = (sameName.appProperties || {})[TAG];
    throw new DriveError("name_clash", other
      ? `A different PTAA (${other.split(":")[0]}) already has a file called “${a.fileName}” in ${folder.name}. ` +
        "Nothing was uploaded. Check the owner name and unit on both."
      : `“${a.fileName}” already exists in ${folder.name} and was not put there by this app. ` +
        "Nothing was uploaded or overwritten. Rename or move that file in Drive, then file again.");
  }

  // convertTo: e.g. a Google Sheet, so the invoice sits in Drive the same way
  // the office's hand-made ones do. Only asked for when creating the file.
  const metadata = mine
    ? { name: a.fileName, appProperties: { [TAG]: tagValue } }
    : { name: a.fileName, parents: [folder.id], appProperties: { [TAG]: tagValue },
        ...(a.convertTo ? { mimeType: a.convertTo } : {}) };

  const saved = await sendFile(token, { fileId: mine ? mine.id : null, metadata, bytes: a.bytes, mimeType: a.mimeType });
  if (!saved || !saved.id) {
    throw new DriveError(DRIVE_STATE.FAILED, "Google Drive did not confirm the upload.");
  }
  return {
    fileId: saved.id,
    fileName: saved.name || a.fileName,
    webViewLink: saved.webViewLink || `https://drive.google.com/file/d/${saved.id}/view`,
    folderId: folder.id, folderName: folder.name, folderCreated: folder.created,
    replaced: !!mine,
  };
}

/** Check the folder can be reached. Opens the permission pop-up if needed. */
export async function testDriveFolder(settings = null, token = null, kind = "ptaa") {
  const s = settings || await getSettings();
  const dest = destinationOf(s, kind);
  if (!dest.id) throw new DriveError(DRIVE_STATE.NOT_CONFIGURED, "Paste the Drive folder link first.");
  token = token || await driveToken();
  return getFolder(token, dest.id);
}

// ---------------------------------------------------------------------------
// PDFs, for the complete PTAA
// ---------------------------------------------------------------------------

/** A Google Sheet / Doc in Drive, exported as PDF bytes. */
export async function exportPdf(token, fileId) {
  const res = await call(`${API}/${encodeURIComponent(fileId)}/export?mimeType=application%2Fpdf`,
                         { token, raw: true });
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * A Google Sheet as a PDF laid out for printing: A4, fitted to the page width,
 * and WITHOUT gridlines, notes, the sheet name or page numbers. Drive's own
 * export has no such options (it prints the gridlines), so this uses the
 * Sheets export link, which accepts the same Drive permission. If Google ever
 * refuses it, the plain Drive export is used instead.
 */
export function sheetPdfUrl(fileId) {
  const q = new URLSearchParams({
    format: "pdf", size: "A4", portrait: "true", fitw: "true", scale: "2",
    gridlines: "false", printnotes: "false", sheetnames: "false", printtitle: "false",
    pagenum: "UNDEFINED", fzr: "false", horizontal_alignment: "CENTER",
    top_margin: "0.5", bottom_margin: "0.5", left_margin: "0.5", right_margin: "0.5",
  });
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/export?${q}`;
}

export async function exportSheetPdf(token, fileId) {
  try {
    const res = await fetch(sheetPdfUrl(fileId), { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      // A sign-in page instead of a PDF means the permission was not accepted.
      if (bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") return bytes;
    }
    console.warn("[drive] Sheets export refused (" + res.status + "); using the Drive export.");
  } catch (err) {
    console.warn("[drive] Sheets export failed; using the Drive export.", err);
  }
  return exportPdf(token, fileId);
}

/**
 * The Word file as a PDF, by letting Google convert it: a temporary Google Doc
 * is made, exported, and moved to the bin straight away. Google's conversion
 * can shift a page break or a table slightly — a PDF saved from Word itself is
 * the exact copy, and can be used instead.
 */
export async function wordToPdf(token, docxBytes, name = "PTAA (temporary for PDF)") {
  const boundary = "anchor" + Math.random().toString(36).slice(2);
  const meta = { name, mimeType: "application/vnd.google-apps.document" };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`,
    new Blob([docxBytes], { type: DOCX_MIME }), `\r\n--${boundary}--`,
  ]);
  const made = await call(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST", token, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  try {
    return await exportPdf(token, made.id);
  } finally {
    // Never left lying around; trashed rather than deleted, so nothing is
    // ever destroyed outright.
    await call(`${API}/${encodeURIComponent(made.id)}?fields=id`, {
      method: "PATCH", token, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }) }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The team workflow's single-document completion uses the same path.
// ---------------------------------------------------------------------------

export async function uploadCompletedPtaa({ ptaaId, propertyName, fileName, bytes }, opts = {}) {
  return fileToDrive({ ptaaId, kind: "ptaa", propertyName, fileName, bytes, mimeType: DOCX_MIME }, opts);
}

/** No network: just whether a folder has been chosen. */
export async function driveStatus() {
  try {
    const s = await getSettings();
    return s.ptaaFolderId
      ? { ok: true, rootId: s.ptaaFolderId, rootName: s.ptaaFolderName || "" }
      : { ok: false, code: DRIVE_STATE.NOT_CONFIGURED };
  } catch {
    return { ok: false, code: DRIVE_STATE.FAILED, error: "Could not read the settings." };
  }
}

export function driveAdvice(code) {
  switch (code) {
    case DRIVE_STATE.NOT_CONFIGURED:
      return "Choose the Drive folder under Settings — paste the folder's link from the browser's address bar.";
    case DRIVE_STATE.DISCONNECTED:
      return "Press the button again and allow Google Drive on Google's screen.";
    case "popup_blocked":
      return "Allow pop-ups for this site (the icon at the right of the address bar), then try again.";
    case "api_disabled":
      return "A one-time switch in the Google Cloud console — README → “Connecting Google Drive”.";
    case "folder_missing":
      return "Open Settings and check the folder link, and that your Google account can open that folder.";
    case "name_clash":
      return "Nothing was uploaded and nothing was overwritten.";
    default:
      return "Nothing has been marked as filed, so nothing is half-done. You can safely try again.";
  }
}
