// ---------------------------------------------------------------------------
// Tests for the Drive endpoint's caller verification.
//
// Run:  node --test tests/drive-auth.test.mjs
//
// This is the security boundary of the whole system. functions/api/drive/upload.js
// holds the refresh token for the company Google account; anyone who can
// persuade it to run an upload can write into the company's document archive.
// The only thing standing between the open internet and that token is
// verifyFirebaseToken, so it gets tested against real signatures rather than
// read and hoped over.
//
// Certificates and tokens here are generated with node:crypto, so no network
// and no Google project are needed.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, X509Certificate, createPrivateKey } from "node:crypto";

import {
  verifyFirebaseToken, pemToArrayBuffer, spkiFromCertificate,
} from "../functions/api/drive/upload.js";

const PROJECT = "ptaa-60427";
const KID = "testkey1";

// --- A throwaway certificate authority --------------------------------------

// node cannot mint an X.509 certificate, so the fixtures are made once by
// OpenSSL at test time. If openssl is unavailable the certificate-shaped tests
// skip rather than fail — the JWT tests below do not need it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtures = null;
try {
  const dir = mkdtempSync(join(tmpdir(), "anchor-cert-"));
  const keyPath = join(dir, "k.pem"), certPath = join(dir, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048",
    "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes",
    "-subj", "/CN=securetoken.google.com"], { stdio: "ignore" });
  fixtures = {
    dir,
    certPem: readFileSync(certPath, "utf8"),
    privateKey: createPrivateKey(readFileSync(keyPath)),
  };
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
} catch {
  fixtures = null;
}

const skip = fixtures ? false : "openssl not available";

const b64url = (buf) => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mint a Firebase-shaped ID token signed with the fixture key. */
function makeToken(payloadOver = {}, { kid = KID, tamper = false, key = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: "uid-123",
    email: "boss@gmail.com",
    email_verified: true,
    auth_time: now - 60,
    iat: now - 60,
    exp: now + 3600,
    ...payloadOver,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign("RSA-SHA256").update(signingInput).end()
    .sign(key || fixtures.privateKey);
  const token = `${signingInput}.${b64url(sig)}`;
  if (!tamper) return token;

  // Flip one character of the payload, keeping the original signature — the
  // classic "decode and trust" attack.
  const [h, p, s] = token.split(".");
  const decoded = JSON.parse(Buffer.from(p, "base64url").toString());
  decoded.email = "attacker@example.com";
  return `${h}.${b64url(JSON.stringify(decoded))}.${s}`;
}

const certs = () => ({ [KID]: fixtures.certPem });

// --- The certificate walk ---------------------------------------------------

test("a real certificate yields a key WebCrypto will import", { skip }, async () => {
  const spki = pemToArrayBuffer(fixtures.certPem);
  const key = await crypto.subtle.importKey("spki", spki,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  assert.equal(key.type, "public");

  // And it is the SAME key the certificate carries, not merely a valid one.
  const expected = new X509Certificate(fixtures.certPem)
    .publicKey.export({ type: "spki", format: "der" });
  assert.deepEqual(Buffer.from(spki), expected,
    "the extracted key must be byte-identical to the certificate's own");
});

test("a truncated certificate is refused rather than half-read", { skip }, () => {
  const der = new Uint8Array(
    Buffer.from(fixtures.certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));
  assert.throws(() => spkiFromCertificate(der.slice(0, 40)), /certificate/i);
  assert.throws(() => spkiFromCertificate(new Uint8Array([0x02, 0x01, 0x00])),
    /not a DER SEQUENCE/);
});

// --- Accepting a genuine token ----------------------------------------------

test("a correctly signed, current token is accepted", { skip }, async () => {
  const claims = await verifyFirebaseToken(makeToken(), PROJECT, certs);
  assert.equal(claims.email, "boss@gmail.com");
  assert.equal(claims.sub, "uid-123");
});

// --- Refusing everything else -----------------------------------------------

test("a token with a valid signature but edited payload is refused", { skip }, async () => {
  // If this ever passes, anyone can upload into the company Drive as anyone.
  await assert.rejects(
    () => verifyFirebaseToken(makeToken({}, { tamper: true }), PROJECT, certs),
    /signature did not verify/);
});

test("a token signed by somebody else's key is refused", { skip }, async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(
    () => verifyFirebaseToken(makeToken({}, { key: privateKey }), PROJECT, certs),
    /signature did not verify/);
});

test("a token for a different Firebase project is refused", { skip }, async () => {
  await assert.rejects(
    () => verifyFirebaseToken(
      makeToken({ aud: "someone-elses-project",
                  iss: "https://securetoken.google.com/someone-elses-project" }),
      PROJECT, certs),
    /different project/);
});

test("a token with the wrong issuer is refused", { skip }, async () => {
  await assert.rejects(
    () => verifyFirebaseToken(makeToken({ iss: "https://evil.example.com/" }), PROJECT, certs),
    /wrong issuer/);
});

test("an expired token is refused", { skip }, async () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  await assert.rejects(
    () => verifyFirebaseToken(makeToken({ exp: past }), PROJECT, certs),
    /expired/);
});

test("a token signed with an unknown key id is refused", { skip }, async () => {
  await assert.rejects(
    () => verifyFirebaseToken(makeToken({}, { kid: "not-a-google-key" }), PROJECT, certs),
    /unknown key/);
});

test("garbage is refused without throwing something unreadable", { skip }, async () => {
  for (const bad of ["", "abc", "a.b", "a.b.c.d", null, undefined]) {
    await assert.rejects(() => verifyFirebaseToken(bad, PROJECT, certs),
      /Malformed sign-in token/, `accepted: ${JSON.stringify(bad)}`);
  }
});

test("an unsigned “alg: none” token is refused", { skip }, async () => {
  // The oldest JWT attack there is: claim there is no signature to check.
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT", kid: KID }));
  const payload = b64url(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT,
    sub: "uid-123", email: "attacker@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  await assert.rejects(
    () => verifyFirebaseToken(`${header}.${payload}.`, PROJECT, certs),
    /signature did not verify|Malformed/);
});
