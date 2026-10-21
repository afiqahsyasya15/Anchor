// ---------------------------------------------------------------------------
// core.js — Firebase wiring, DOM helper, activity log, error text.
// Pure helpers (formatting + validation) live in validate.js and are
// re-exported from here so screens have a single import.
//
// The Firebase SDK version is pinned in the three import URLs below. To
// upgrade, change 12.18.0 in all three places.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  reauthenticateWithPopup,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  initializeFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, addDoc, query, orderBy, limit, where,
  serverTimestamp, runTransaction, increment, Timestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

import * as appConfig from "../config.js";

const { firebaseConfig, company } = appConfig;

/**
 * One person running everything (see config.js → workflow). Read defensively:
 * an older config.js without the `workflow` export means the team workflow.
 */
export const soloMode = !!(appConfig.workflow && appConfig.workflow.solo);

// Re-exported so every screen has a single import: fmtLogTime, fmtDate,
// emailKey, isValidEmail, PROFILE_FIELDS, validateNric, validatePhone, …
export * from "./validate.js";

// --- Firebase ---------------------------------------------------------------

export const configLooksUnset =
  !firebaseConfig.apiKey || String(firebaseConfig.apiKey).startsWith("PASTE_");

// When config.js still holds the PASTE_… placeholders, hand the SDK a
// structurally valid dummy so importing this module cannot throw. app.js
// notices `configLooksUnset` and shows the setup screen instead of signing in.
const app = initializeApp(configLooksUnset
  ? { apiKey: "unset", authDomain: "unset.firebaseapp.com", projectId: "unset", appId: "1:0:web:0" }
  : firebaseConfig);

export const auth = getAuth(app);

/**
 * Firestore, with long-polling auto-detect turned on.
 *
 * By default the SDK streams over WebChannel. On networks that inspect or
 * buffer streamed responses — corporate proxies, some ISPs, a few mobile
 * networks — a large write stalls, and the SDK's behaviour when a write cannot
 * complete is to retry it silently, forever. `setDoc` never resolves and never
 * rejects, so a screen awaiting it simply sits there with no error to show.
 *
 * That is exactly what a multi-megabyte template upload looks like when it
 * fails. Auto-detect probes the connection once and falls back to long polling
 * when the stream is being mangled, which costs a little latency on a healthy
 * network and turns an unfixable hang into a working upload on a bad one.
 */
export const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
});

export const googleProvider = new GoogleAuthProvider();
// Always show the account chooser. Without this, someone signed into several
// Google accounts silently gets whichever one the browser picked last, which is
// exactly how an agent ends up refused by the allowlist for no clear reason.
googleProvider.setCustomParameters({ prompt: "select_account" });

export {
  GoogleAuthProvider, reauthenticateWithPopup,
  signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, addDoc, query, orderBy, limit, where,
  serverTimestamp, runTransaction, increment, Timestamp,
  company,
};

// --- DOM helper -------------------------------------------------------------
// h('div', {class:'x', onClick: fn}, 'text', h('span', {}, 'more'))
// Children are appended as text nodes unless they are already DOM nodes, so a
// value typed by a user can never be interpreted as HTML.

export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "for") node.htmlFor = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === "") continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function mount(parent, ...nodes) {
  const list = nodes.flat(Infinity).filter(Boolean);
  // A screen that reloads after a button shows "Loading…" for a moment. If it
  // shrank to that one line, the browser would lose the scroll position and
  // the page would jump back to the top. So while it reloads it keeps its
  // height, and the fresh content lands where you were.
  const reloading = list.length === 1 && list[0].classList && list[0].classList.contains("loading")
                    && parent.childNodes.length > 0;
  if (reloading) parent.style.minHeight = parent.offsetHeight + "px";
  else if (parent.style && parent.style.minHeight) parent.style.minHeight = "";
  parent.replaceChildren(...list);
  return parent;
}

// --- Activity log (brief §14.1, non-negotiable rule #11) --------------------
// Append-only. firestore.rules denies update and delete outright, so there is
// no code path — here or in a later phase — that can edit history.

let actorRef = { email: null, role: null };
export function setActor(email, role) { actorRef = { email, role }; }

export async function logActivity({ action, summary, targetType = null, targetId = null, detail = {} }) {
  if (!actorRef.email) return;           // not signed in / not allowlisted
  try {
    await addDoc(collection(db, "activity"), {
      at: serverTimestamp(),
      actorEmail: actorRef.email,
      actorRole: actorRef.role,
      action, summary, targetType, targetId, detail,
    });
  } catch (err) {
    // A failed log write must never block the action the user was taking, but
    // it must not vanish silently either.
    console.error("[activity] failed to write log entry:", action, err);
  }
}

// --- Error text -------------------------------------------------------------

const ERRORS = {
  "auth/popup-blocked": "Your browser blocked the Google sign-in pop-up. Allow pop-ups for this site and try again.",
  "auth/popup-closed-by-user": "Sign-in was cancelled.",
  "auth/cancelled-popup-request": "Sign-in was cancelled.",
  "auth/network-request-failed": "Could not reach Google. Check your internet connection and try again.",
  "auth/unauthorized-domain": "This web address is not in the Firebase Authentication “Authorized domains” list. Firebase allows “localhost” by default but NOT “127.0.0.1” — if the address bar shows 127.0.0.1, just change it to localhost. Otherwise add this address in the Firebase console (README step 9).",
  "auth/operation-not-allowed": "Google sign-in is not enabled on this Firebase project. Enable it under Authentication → Sign-in method (README step 2).",
  "auth/invalid-api-key": "The apiKey in config.js is not valid for this Firebase project (README step 5).",
  "permission-denied": "The database refused this action. That usually means your account is not on the approved list, or the security rules have not been published yet (README step 4).",
  "unavailable": "Could not reach the database. Check your internet connection and try again.",
  "failed-precondition": "The database rejected this query. If this was the activity log, Firestore may still be building its index — wait a minute and retry.",
};

export function friendlyError(err) {
  const code = err && err.code ? String(err.code) : "";
  if (ERRORS[code]) return ERRORS[code];
  const msg = err && err.message ? String(err.message) : "Unexpected error.";
  return code ? `${msg} (${code})` : msg;
}
