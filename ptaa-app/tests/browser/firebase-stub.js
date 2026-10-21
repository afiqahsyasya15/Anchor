// ---------------------------------------------------------------------------
// An in-memory stand-in for the parts of the Firebase SDK this app uses.
//
// Used only by tests/browser/harness.html, which redirects the gstatic imports
// here with an import map. It lets the whole sign-in gate, the users screen and
// the profile form be exercised in a browser with no Firebase project, no
// network and no credentials.
//
// It deliberately does NOT model security rules — those are server-side, and
// the only honest way to test them is the Firestore emulator. See README
// "Verifying the permission rules".
// ---------------------------------------------------------------------------

// --- shared store -----------------------------------------------------------

export const store = new Map();       // "users/a@b.com" -> { ...fields }
let autoId = 0;

const SERVER_TS = Symbol("serverTimestamp");
function resolveSentinels(obj) {
  if (obj === SERVER_TS) return new Date();
  if (Array.isArray(obj)) return obj.map(resolveSentinels);
  if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveSentinels(v);
    return out;
  }
  return obj;
}

function asTimestamp(v) {
  if (v instanceof Date) return { toDate: () => v, __ts: true };
  return v;
}
function wrapTimestamps(obj) {
  if (obj instanceof Date) return asTimestamp(obj);
  if (Array.isArray(obj)) return obj.map(wrapTimestamps);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = wrapTimestamps(v);
    return out;
  }
  return obj;
}

export function seed(path, data) { store.set(path, resolveSentinels(data)); }
export function reset() { store.clear(); autoId = 0; denyAll = false; reauthOutcome = "grant"; }
export function dump() { return Object.fromEntries(store); }

/** Test hook: make every read fail the way unpublished security rules would. */
let denyAll = false;
export function setDenyAll(v) { denyAll = v; }
function guard() {
  if (denyAll) {
    throw Object.assign(new Error("Missing or insufficient permissions."), { code: "permission-denied" });
  }
}

// --- firebase-app -----------------------------------------------------------

export function initializeApp(config) { return { options: config }; }

// --- firebase-auth ----------------------------------------------------------

const authState = { user: null, listeners: new Set() };

export function getAuth() { return authState; }

export class GoogleAuthProvider {
  setCustomParameters() { return this; }
  addScope() { return this; }
  static credentialFromResult(result) { return (result && result.__cred) || null; }
}

/** Test hook: how the next Drive-permission pop-up should end. */
let reauthOutcome = "grant";
export function setReauthOutcome(v) { reauthOutcome = v; }
export async function reauthenticateWithPopup(user) {
  if (reauthOutcome === "close") {
    throw Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" });
  }
  return { user, __cred: { accessToken: "stub-drive-token" } };
}

export function onAuthStateChanged(_auth, cb) {
  authState.listeners.add(cb);
  queueMicrotask(() => cb(authState.user));
  return () => authState.listeners.delete(cb);
}

export async function signInWithPopup() {
  throw Object.assign(new Error("stub: drive sign-in with setUser()"), { code: "auth/popup-blocked" });
}

export async function signOut() { setUser(null); }

/** Test hook: pretend Google returned this user (or null for signed out). */
export function setUser(user) {
  // The real SDK exposes the signed-in user as auth.currentUser, with
  // getIdToken() on it. drive.js needs both to prove who is asking before an
  // upload — without them the upload path fails at the first line and every
  // test of what happens *after* an upload passes for the wrong reason.
  authState.user = user;
  authState.currentUser = user
    ? { ...user, getIdToken: async () => `stub-id-token-for-${user.email}` }
    : null;
  for (const cb of authState.listeners) cb(user);
}

// --- firebase-firestore -----------------------------------------------------

export function getFirestore() { return { __db: true }; }
// core.js uses initializeFirestore so it can turn on long-polling auto-detect;
// the stub ignores the settings but must exist, or the app never boots.
export function initializeFirestore() { return { __db: true }; }

export function doc(_db, ...segments) {
  const path = segments.join("/");
  return { __ref: true, path, id: segments[segments.length - 1] };
}

export function collection(_db, ...segments) {
  return { __coll: true, path: segments.join("/") };
}

export function serverTimestamp() { return SERVER_TS; }

export function orderBy(field, dir = "asc") { return { __c: "orderBy", field, dir }; }
export function limit(n)  { return { __c: "limit", n }; }
export function where(f, op, v) { return { __c: "where", f, op, v }; }
export function query(coll, ...constraints) { return { __query: true, coll, constraints }; }

export async function getDoc(ref) {
  guard();
  const data = store.get(ref.path);
  return {
    id: ref.id,
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : wrapTimestamps(data)),
  };
}

export async function setDoc(ref, data, opts) {
  const next = resolveSentinels(data);
  store.set(ref.path, opts && opts.merge ? { ...(store.get(ref.path) || {}), ...next } : next);
}

export async function updateDoc(ref, patch) {
  if (!store.has(ref.path)) {
    throw Object.assign(new Error("No document to update: " + ref.path), { code: "not-found" });
  }
  store.set(ref.path, { ...store.get(ref.path), ...resolveSentinels(patch) });
}

export async function addDoc(coll, data) {
  guard();
  const id = "auto" + (++autoId);
  store.set(coll.path + "/" + id, resolveSentinels(data));
  return { id, path: coll.path + "/" + id };
}

export async function deleteDoc(ref) {
  guard();
  store.delete(ref.path);
}

export function increment(n) { return { __increment: n }; }

export const Timestamp = {
  fromDate: (d) => ({ toDate: () => d, __ts: true }),
  now: () => ({ toDate: () => new Date(), __ts: true }),
};

/**
 * Transactions run straight against the store — no isolation, no retries.
 * Enough to exercise the read-compute-write shape of the PTAA counter.
 */
export async function runTransaction(_db, fn) {
  const tx = {
    get: (ref) => getDoc(ref),
    set: (ref, data, opts) => { setDoc(ref, data, opts); return tx; },
    update: (ref, patch) => { updateDoc(ref, patch); return tx; },
    delete: (ref) => { store.delete(ref.path); return tx; },
  };
  return fn(tx);
}

export async function getDocs(qOrColl) {
  guard();
  const coll = qOrColl.__query ? qOrColl.coll : qOrColl;
  const constraints = qOrColl.__query ? qOrColl.constraints : [];
  const prefix = coll.path + "/";

  let rows = [...store.entries()]
    // direct children only — "users/a@b.com/profileVersions/1" is not in "users"
    .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .map(([p, v]) => ({ id: p.slice(prefix.length), _data: v }));

  for (const c of constraints) {
    if (c.__c !== "where") continue;
    rows = rows.filter(r => {
      const v = r._data[c.f];
      switch (c.op) {
        case "==":  return v === c.v;
        case "!=":  return v !== c.v;
        case ">":   return v > c.v;
        case ">=":  return v >= c.v;
        case "<":   return v < c.v;
        case "<=":  return v <= c.v;
        case "in":  return Array.isArray(c.v) && c.v.includes(v);
        default: throw new Error("stub: unsupported where operator " + c.op);
      }
    });
  }

  for (const c of constraints) {
    if (c.__c === "orderBy") {
      rows.sort((a, b) => {
        const av = a._data[c.field], bv = b._data[c.field];
        if (av === undefined || bv === undefined) {
          // Match Firestore: documents missing the ordered field are not returned.
          return 0;
        }
        const an = av instanceof Date ? av.getTime() : av;
        const bn = bv instanceof Date ? bv.getTime() : bv;
        return (an < bn ? -1 : an > bn ? 1 : 0) * (c.dir === "desc" ? -1 : 1);
      });
      if (rows.some(r => r._data[c.field] === undefined)) {
        throw Object.assign(
          new Error(`stub: documents in ${coll.path} are missing the ordered field "${c.field}"`),
          { code: "failed-precondition" });
      }
    }
  }
  for (const c of constraints) if (c.__c === "limit") rows = rows.slice(0, c.n);

  const docs = rows.map(r => ({ id: r.id, data: () => wrapTimestamps(r._data) }));
  return { docs, empty: docs.length === 0, size: docs.length };
}
