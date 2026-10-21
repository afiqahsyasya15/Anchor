// ---------------------------------------------------------------------------
// functions/api/drive/upload.js — the ONE piece of this system that is not a
// static file. A Cloudflare Pages Function, deployed with the site.
//
// WHY THIS EXISTS
// ---------------
// Brief §4.2: documents are never written to an agent's personal Drive. Every
// upload goes to one designated company account, using a refresh token held
// server-side. A browser cannot hold that token — anyone with the developer
// console open would have it, and with it the whole document archive. So the
// token lives here, as a Cloudflare secret, and the browser can only ask this
// endpoint to do an upload on its behalf.
//
// WHAT IT WILL AND WILL NOT DO
// ----------------------------
// It verifies the caller is a signed-in admin of THIS Firebase project before
// touching Drive. It uploads into a named property folder under a fixed root,
// creating the folder only if it is genuinely absent. It refuses to overwrite a
// file that belongs to a different PTAA. It never lists, reads or deletes
// anything outside the folders it manages — the drive.file scope means it
// physically cannot reach files it did not create.
//
// SETUP: see README → "Connecting Google Drive". Four secrets are required:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, DRIVE_ROOT_ID
// plus FIREBASE_PROJECT_ID, which is not secret but must match config.js.
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Anything larger is not a PTAA; refuse before spending an access token on it. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---------------------------------------------------------------------------
// Verifying the caller
// ---------------------------------------------------------------------------

/**
 * Check a Firebase ID token properly: signature against Google's published
 * certificates, then issuer, audience and expiry.
 *
 * Decoding the token without verifying it would make this endpoint an open
 * proxy to the company Drive — anyone could hand it a self-made JWT. The whole
 * point of the endpoint is that it trusts the token, so the token has to earn it.
 */
export async function verifyFirebaseToken(idToken, projectId, getCerts = fetchGoogleCerts) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed sign-in token.");

  const [rawHeader, rawPayload, rawSig] = parts;
  const header = JSON.parse(b64urlToText(rawHeader));
  const payload = JSON.parse(b64urlToText(rawPayload));

  const certs = await getCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error("Sign-in token was signed with an unknown key.");

  const key = await crypto.subtle.importKey(
    "spki", pemToArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`));
  if (!ok) throw new Error("Sign-in token signature did not verify.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("Sign-in token is for a different project.");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Sign-in token has the wrong issuer.");
  if (!payload.exp || payload.exp < now) throw new Error("Sign-in token has expired. Reload the page and try again.");
  if (payload.auth_time && payload.auth_time > now + 60) throw new Error("Sign-in token is not valid yet.");
  if (!payload.sub) throw new Error("Sign-in token has no subject.");

  return payload;                       // { sub, email, email_verified, ... }
}

let certCache = { at: 0, certs: null };

async function fetchGoogleCerts() {
  // Cached for an hour; Google rotates these slowly and the endpoint is called
  // once per completion, not per page view.
  if (certCache.certs && Date.now() - certCache.at < 3600_000) return certCache.certs;
  const res = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  if (!res.ok) throw new Error("Could not reach Google to check the sign-in token.");
  const certs = await res.json();
  certCache = { at: Date.now(), certs };
  return certs;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlToText = (s) => new TextDecoder().decode(b64urlToBytes(s));

export function pemToArrayBuffer(pem) {
  const body = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  return spkiFromCertificate(base64ToBytes(body));
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- Just enough DER to find one field --------------------------------------
//
// Google publishes X.509 certificates; WebCrypto imports SPKI public keys, so
// the SubjectPublicKeyInfo has to be lifted out of the certificate.
//
// This is a structural walk rather than a search for the rsaEncryption OID with
// fixed offsets back to the enclosing SEQUENCE. That shortcut is tempting and
// wrong: the SPKI SEQUENCE header is two bytes for a short body but four for a
// 2048-bit key (30 82 01 22), so fixed offsets land mid-length-field and
// produce a key WebCrypto refuses. Verified against OpenSSL output for 2048-
// and 4096-bit certificates — see the note in README → Running the tests.

function readDerLength(der, at) {
  const first = der[at];
  if (first < 0x80) return { length: first, headerLength: 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 4) throw new Error("Unsupported DER length in the certificate.");
  let length = 0;
  for (let i = 0; i < n; i++) length = (length * 256) + der[at + 1 + i];
  return { length, headerLength: 1 + n };
}

/** One tag-length-value, with both the outer and inner boundaries. */
function readTlv(der, offset) {
  if (offset >= der.length) throw new Error("Ran off the end of the certificate.");
  const tag = der[offset];
  const { length, headerLength } = readDerLength(der, offset + 1);
  const start = offset + 1 + headerLength;      // where the VALUE begins
  return { tag, tlvStart: offset, start, end: start + length };
}

function derChildren(der, parent) {
  const out = [];
  let at = parent.start;
  while (at < parent.end) {
    const child = readTlv(der, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

/**
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 * TBSCertificate ::= SEQUENCE {
 *   [0] version OPTIONAL, serialNumber, signature, issuer, validity, subject,
 *   subjectPublicKeyInfo, ...
 * }
 * So the SPKI is the 7th child of tbsCertificate when the optional version tag
 * is present (it always is, for a v3 certificate), and the 6th when it is not.
 */
export function spkiFromCertificate(der) {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("Google's certificate is not a DER SEQUENCE.");

  const tbs = derChildren(der, cert)[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("Could not read the certificate body.");

  const kids = derChildren(der, tbs);
  const index = (kids[0] && kids[0].tag === 0xa0) ? 6 : 5;
  const spki = kids[index];
  if (!spki || spki.tag !== 0x30) {
    throw new Error("Could not read the public key from Google's certificate.");
  }
  return der.slice(spki.tlvStart, spki.end).buffer;
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 *
 * If this fails with invalid_grant the token has been revoked or has expired —
 * which is what happens if the OAuth app is left in Testing mode, where Google
 * expires refresh tokens after seven days. The caller turns that into the
 * "Drive connection expired — reconnect" state the brief §4.3(b) asks for,
 * rather than a generic failure.
 */
async function accessToken(env) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || "Google refused the refresh token.");
    err.code = body.error === "invalid_grant" ? "drive_disconnected" : "drive_auth_failed";
    throw err;
  }
  return body.access_token;
}

const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function driveGet(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(driveMessage(body, res.status));
  return body;
}

function driveMessage(body, status) {
  const msg = body && body.error && (body.error.message || body.error);
  if (status === 403) return `Google Drive refused the request: ${msg || "permission denied"}.`;
  if (status === 404) return "That Drive folder no longer exists, or this account cannot see it.";
  return `Google Drive returned an error (${status}): ${msg || "no detail given"}.`;
}

/**
 * Find the property's folder under the root, and create it only if it is really
 * not there.
 *
 * Brief §11.4 is explicit: do not create duplicate or parallel folders alongside
 * ones that already exist. Irfan's Drive already has this structure, so the
 * search comes first and matching is case-insensitive — "M Astra" and "M ASTRA"
 * are the same folder to a person, and two of them would be a mess to unpick.
 */
async function findOrCreateFolder(token, rootId, name, { createIfMissing = true } = {}) {
  const search = `${DRIVE_FILES}?q=${encodeURIComponent(
    `'${q(rootId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
  )}&fields=files(id,name)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`;

  const { files = [] } = await driveGet(search, token);
  const wanted = String(name).trim().toLowerCase();
  const hit = files.find(f => String(f.name).trim().toLowerCase() === wanted);
  if (hit) return { id: hit.id, name: hit.name, created: false };

  if (!createIfMissing) return null;

  const res = await fetch(`${DRIVE_FILES}?supportsAllDrives=true&fields=id,name`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: String(name).trim(), mimeType: FOLDER_MIME, parents: [rootId] }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(driveMessage(body, res.status));
  return { id: body.id, name: body.name, created: true };
}

/** Is a file of this name already in the folder? */
async function findFile(token, folderId, fileName) {
  const search = `${DRIVE_FILES}?q=${encodeURIComponent(
    `'${q(folderId)}' in parents and name='${q(fileName)}' and trashed=false`
  )}&fields=files(id,name,webViewLink,appProperties)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const { files = [] } = await driveGet(search, token);
  return files[0] || null;
}

/**
 * Upload, either as a new file or as a new revision of an existing one.
 * `ptaaId` is stamped into appProperties so a later upload can tell its own
 * file from someone else's with the same name — which matters, because the
 * filename no longer contains the PTAA type and is not guaranteed unique.
 */
async function uploadDocx(token, { folderId, fileId, fileName, ptaaId, bytes }) {
  const metadata = fileId
    ? { name: fileName, appProperties: { ptaaId } }
    : { name: fileName, parents: [folderId], appProperties: { ptaaId } };

  const boundary = "anchor" + crypto.randomUUID().replace(/-/g, "");
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
               `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const body = new Uint8Array(
    new TextEncoder().encode(head).length + bytes.length + new TextEncoder().encode(tail).length);
  const headBytes = new TextEncoder().encode(head);
  const tailBytes = new TextEncoder().encode(tail);
  body.set(headBytes, 0);
  body.set(bytes, headBytes.length);
  body.set(tailBytes, headBytes.length + bytes.length);

  const url = fileId
    ? `${DRIVE_UPLOAD}/${fileId}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`
    : `${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`;

  const res = await fetch(url, {
    method: fileId ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(driveMessage(out, res.status));
  return out;
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export async function onRequestPost({ request, env }) {
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN",
                   "DRIVE_ROOT_ID", "FIREBASE_PROJECT_ID"].filter(k => !env[k]);
  if (missing.length) {
    return json({
      ok: false, code: "not_configured",
      error: `Google Drive is not connected yet. Missing on the server: ${missing.join(", ")}. ` +
             `See the README section "Connecting Google Drive".`,
    }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "bad_request", error: "Malformed request." }, 400);
  }

  const { idToken, propertyName, fileName, ptaaId, fileBase64 } = payload || {};
  if (!idToken || !propertyName || !fileName || !ptaaId || !fileBase64) {
    return json({ ok: false, code: "bad_request",
                  error: "Missing one of: idToken, propertyName, fileName, ptaaId, fileBase64." }, 400);
  }

  // 1. Who is asking? -------------------------------------------------------
  let claims;
  try {
    claims = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (err) {
    return json({ ok: false, code: "unauthenticated", error: err.message }, 401);
  }
  if (claims.email_verified === false) {
    return json({ ok: false, code: "unauthenticated",
                  error: "That Google account's email is not verified." }, 401);
  }

  // 2. Are they an admin of this system? ------------------------------------
  // Asked of Firestore directly rather than trusted from the request body: the
  // token proves who they are, not what they are allowed to do.
  try {
    const email = String(claims.email || "").trim().toLowerCase();
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}` +
                `/databases/(default)/documents/users/${encodeURIComponent(email)}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${idToken}` } });
    if (!res.ok) {
      return json({ ok: false, code: "forbidden",
                    error: "That account is not on the approved list." }, 403);
    }
    const doc = await res.json();
    const fields = doc.fields || {};
    const role = fields.role && fields.role.stringValue;
    const active = fields.active && fields.active.booleanValue;
    if (role !== "admin" || active !== true) {
      return json({ ok: false, code: "forbidden",
                    error: "Only an active PTAA Admin can upload to Google Drive." }, 403);
    }
  } catch {
    return json({ ok: false, code: "forbidden",
                  error: "Could not confirm your account has permission to upload." }, 403);
  }

  // 3. Decode the document ---------------------------------------------------
  let bytes;
  try {
    const bin = atob(fileBase64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return json({ ok: false, code: "bad_request", error: "The document could not be decoded." }, 400);
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return json({ ok: false, code: "too_large",
                  error: `That document is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, ` +
                         `over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.` }, 413);
  }

  // 4. Drive -----------------------------------------------------------------
  try {
    const token = await accessToken(env);
    const folder = await findOrCreateFolder(token, env.DRIVE_ROOT_ID, propertyName);

    const existing = await findFile(token, folder.id, fileName);
    if (existing) {
      const owner = existing.appProperties && existing.appProperties.ptaaId;
      // Replacing this PTAA's own file is right — §11.5 keeps one document, not
      // a version history. Replacing a DIFFERENT PTAA's file would destroy
      // somebody else's agreement, so it stops and says whose it is.
      if (owner && owner !== ptaaId) {
        return json({
          ok: false, code: "name_clash",
          error: `A different PTAA (${owner}) already has a file called “${fileName}” in ` +
                 `${folder.name}. Nothing has been uploaded. Check the owner name and unit ` +
                 `on both requests before completing this one.`,
        }, 409);
      }
      if (!owner) {
        return json({
          ok: false, code: "name_clash",
          error: `A file called “${fileName}” is already in ${folder.name}, and it was not put ` +
                 `there by this system, so it will not be overwritten. Move or rename it in ` +
                 `Drive, then complete this PTAA again.`,
        }, 409);
      }
    }

    const file = await uploadDocx(token, {
      folderId: folder.id,
      fileId: existing ? existing.id : null,
      fileName, ptaaId, bytes,
    });

    return json({
      ok: true,
      fileId: file.id,
      fileName: file.name,
      webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      folderId: folder.id,
      folderName: folder.name,
      folderCreated: folder.created,
      replaced: !!existing,
    });
  } catch (err) {
    const code = err.code || "drive_failed";
    const status = code === "drive_disconnected" ? 503 : 502;
    return json({ ok: false, code, error: err.message || "The upload to Google Drive failed." }, status);
  }
}

/** A cheap health check the admin UI uses to show whether Drive is connected. */
export async function onRequestGet({ env }) {
  const configured = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN",
                      "DRIVE_ROOT_ID", "FIREBASE_PROJECT_ID"].every(k => !!env[k]);
  if (!configured) return json({ ok: false, code: "not_configured" }, 503);
  try {
    const token = await accessToken(env);
    const root = await driveGet(
      `${DRIVE_FILES}/${env.DRIVE_ROOT_ID}?fields=id,name&supportsAllDrives=true`, token);
    return json({ ok: true, rootId: root.id, rootName: root.name });
  } catch (err) {
    return json({ ok: false, code: err.code || "drive_failed", error: err.message }, 503);
  }
}
