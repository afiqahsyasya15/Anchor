// ---------------------------------------------------------------------------
// auth.js — Google sign-in and the allowlist gate (brief §4.1, item 0.8).
//
// Agents sign in with the openid/email/profile scopes only. No Drive scope is
// requested here and none should ever be added to this file — Drive access
// belongs to the single designated company account, server-side (brief §4.2).
//
// The allowlist is enforced by firestore.rules, not by this file. What happens
// here is only the *reporting* of a refusal. If you deleted this check, an
// unapproved account would still be unable to read or write anything.
// ---------------------------------------------------------------------------

import {
  auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged,
  doc, getDoc, updateDoc, serverTimestamp,
  emailKey, isProfileComplete, setActor, logActivity,
} from "./core.js";

export const PHASE = {
  LOADING:  "loading",
  SIGNED_OUT: "signed-out",
  DENIED:   "denied",
  READY:    "ready",
};

export const session = {
  phase: PHASE.LOADING,
  email: null,           // allowlisted email (document ID in users/)
  record: null,          // the users/{email} document data
  role: null,            // "admin" | "agent"
  googleName: null,
  photoURL: null,
  denied: null,          // { reason, email, detail }
};

const listeners = new Set();
export function onSessionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(session); }

function setSession(patch) {
  Object.assign(session, patch);
  setActor(session.phase === PHASE.READY ? session.email : null, session.role);
  emit();
}

export function isAdmin() { return session.phase === PHASE.READY && session.role === "admin"; }
export function isAgent() { return session.phase === PHASE.READY && session.role === "agent"; }
export function profileComplete() { return isProfileComplete(session.record && session.record.profile); }

/** Agents must complete their profile before doing anything (brief §6).
 *  Admins are prompted but not blocked — they do not submit requests as agents. */
export function profileRequired() {
  return session.phase === PHASE.READY && session.role === "agent" && !profileComplete();
}

// --- Sign in / out ----------------------------------------------------------

export async function signIn() {
  await signInWithPopup(auth, googleProvider);
  // onAuthStateChanged below takes it from here.
}

export async function signOutNow() {
  setSession({ phase: PHASE.LOADING, denied: null });
  await signOut(auth);
}

/** Clear a refusal and go back to the sign-in screen. */
export async function dismissDenial() {
  setSession({ denied: null, phase: PHASE.LOADING });
  try { await signOut(auth); } catch { /* already signed out */ }
  setSession({ phase: PHASE.SIGNED_OUT });
}

// --- The gate ---------------------------------------------------------------

let refreshInFlight = null;

export function startAuthWatch() {
  onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      // Preserve a refusal we are already showing; a refusal signs the user
      // out, and that must not bounce them straight back to the sign-in screen.
      if (session.phase === PHASE.DENIED) return;
      setSession({ phase: PHASE.SIGNED_OUT, email: null, record: null, role: null });
      return;
    }

    const email = emailKey(fbUser.email);
    if (!email) {
      await refuse({ reason: "no-email", email: "(none)" });
      return;
    }

    try {
      const snap = await getDoc(doc(db, "users", email));

      if (!snap.exists()) {
        await refuse({ reason: "not-listed", email });
        return;
      }

      const data = snap.data() || {};

      if (data.active !== true) {
        await refuse({ reason: "deactivated", email });
        return;
      }

      if (data.role !== "admin" && data.role !== "agent") {
        await refuse({
          reason: "bad-role", email,
          detail: `The users/${email} document has role = ${JSON.stringify(data.role ?? null)}. ` +
                  `It must be exactly the text "admin" or "agent".`,
        });
        return;
      }

      setSession({
        phase: PHASE.READY,
        email,
        record: data,
        role: data.role,
        googleName: fbUser.displayName || null,
        photoURL: fbUser.photoURL || null,
        denied: null,
      });

      // Record the sign-in. Only metadata — role and active are untouched, and
      // firestore.rules rejects the write if either of them changes.
      const firstLogin = !data.firstLoginAt;
      try {
        await updateDoc(doc(db, "users", email), {
          uid: fbUser.uid,
          googleDisplayName: fbUser.displayName || null,
          photoURL: fbUser.photoURL || null,
          lastLoginAt: serverTimestamp(),
          ...(firstLogin ? { firstLoginAt: serverTimestamp() } : {}),
        });
      } catch (err) {
        console.warn("[auth] could not record sign-in metadata:", err);
      }

      await logActivity({
        action: firstLogin ? "auth.first_login" : "auth.login",
        summary: firstLogin ? "Signed in for the first time." : "Signed in.",
        targetType: "user", targetId: email,
      });

    } catch (err) {
      if (err && err.code === "permission-denied") {
        // Under the rules in firestore.rules, someone who is merely not on the
        // allowlist reads their own (non-existent) record successfully — the
        // getDoc above returns "does not exist". So a permission error here
        // means the rules in the Firebase console are not the ones in this
        // repository, which during setup almost always means step 4 was missed.
        await refuse({ reason: "rules", email });
      } else {
        await refuse({ reason: "error", email, detail: err && err.message ? err.message : String(err) });
      }
    }
  });
}

async function refuse({ reason, email, detail = null }) {
  setSession({
    phase: PHASE.DENIED,
    denied: { reason, email, detail },
    record: null, role: null, email: null,
  });
  try { await signOut(auth); } catch { /* ignore */ }
}

/** Re-read the current user's record (after a profile save, or a role change
 *  made by an admin in another tab). */
export async function refreshRecord() {
  if (session.phase !== PHASE.READY) return;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const snap = await getDoc(doc(db, "users", session.email));
      if (snap.exists()) setSession({ record: snap.data(), role: snap.data().role });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
