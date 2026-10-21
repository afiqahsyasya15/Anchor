// ---------------------------------------------------------------------------
// directory.js — the lists the admin keeps: Sales Agents (people to pick from,
// NOT sign-in accounts), the Customer Relationship team who look after each
// condo, and the app settings (Drive folder, invoice numbering, invoice
// defaults).
//
// Agents carry I/C numbers, so the collection is admin-only in the security
// rules and nothing about it ships in the page. It is loaded from Firestore
// after sign-in, never baked into a file anyone can download.
// ---------------------------------------------------------------------------

import {
  db, doc, getDoc, setDoc, updateDoc, collection, getDocs, addDoc,
  serverTimestamp, runTransaction, logActivity,
} from "./core.js";
import { session } from "./auth.js";
import { DEFAULT_FOC_ITEMS } from "./quotation.js";
import { nextInvoiceNo, parseInvoiceNo } from "./invoice.js";

// Pure helpers (CSV, cleaning and matching agents, Drive links) live in
// lists.js so they can be tested without Firebase; re-exported here.
export {
  parseCsv, csvObjects, tidyPhone, tidyNric, normaliseAgent, sameAgent, planAgentImport,
  driveFolderIdFrom, AGENT_ALIASES, monthFolderName,
} from "./lists.js";
import { csvObjects, tidyPhone, normaliseAgent, sameAgent, planAgentImport, AGENT_ALIASES } from "./lists.js";

// ===========================================================================
// Sales Agents
// ===========================================================================

export async function listAgents({ includeInactive = false } = {}) {
  const snap = await getDocs(collection(db, "agents"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => includeInactive || a.active !== false)
    .sort((a, b) => String(a.nickname || a.fullName).localeCompare(String(b.nickname || b.fullName)));
}

export async function addAgent(raw) {
  const { value } = normaliseAgent(raw);
  if (!value.fullName && !value.nickname) throw new Error("Give the agent a name or nickname.");
  const existing = await listAgents({ includeInactive: true });
  const clash = existing.find(x => sameAgent(x, value));
  if (clash) throw new Error(`${clash.nickname || clash.fullName} is already on the list with that I/C or name.`);
  const ref = await addDoc(collection(db, "agents"), {
    ...value, active: true,
    createdBy: session.email, createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await logActivity({ action: "agent.added", summary: `Added Sales Agent ${value.nickname || value.fullName}.`,
                      targetType: "agent", targetId: ref.id });
  return ref.id;
}

export async function updateAgent(id, raw) {
  const { value } = normaliseAgent(raw);
  const existing = await listAgents({ includeInactive: true });
  const clash = existing.find(x => x.id !== id && sameAgent(x, value));
  if (clash) throw new Error(`That I/C or name belongs to ${clash.nickname || clash.fullName}.`);
  await updateDoc(doc(db, "agents", id), { ...value, updatedAt: serverTimestamp() });
  await logActivity({ action: "agent.updated", summary: `Updated Sales Agent ${value.nickname || value.fullName}.`,
                      targetType: "agent", targetId: id });
}

export async function setAgentActive(id, active) {
  await updateDoc(doc(db, "agents", id), { active: !!active, updatedAt: serverTimestamp() });
}

export async function importAgents(csvText) {
  const rows = csvObjects(csvText, AGENT_ALIASES);
  const existing = await listAgents({ includeInactive: true });
  const plan = planAgentImport(rows, existing);
  for (const row of plan.toAdd) {
    await addDoc(collection(db, "agents"), {
      ...row.value, active: true,
      createdBy: session.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  }
  if (plan.toAdd.length) {
    await logActivity({ action: "agent.imported",
      summary: `Imported ${plan.toAdd.length} Sales Agent${plan.toAdd.length === 1 ? "" : "s"}.` });
  }
  return plan;
}

/** What goes onto a PTAA — the same shape a signed-in agent's profile snapshot has. */
export function agentSnapshotOf(agent) {
  const a = agent || {};
  return {
    email: a.email || "",
    fullName: a.fullName || "",
    nric: a.nric || "",
    phone: a.phone || "",
    nickname: a.nickname || "",
    profileVersion: 0,
    agentId: a.id || null,
  };
}

// ===========================================================================
// Customer Relationship team (the condo PIC)
// ===========================================================================

/** From "To-do list - CRD TEAM.pdf". Offered once, as a starting point. */
export const DEFAULT_CRD_TEAM = [
  { nickname: "AMELIE",  phone: "012-592 4419" },
  { nickname: "ANGELA",  phone: "012-428 4195" },
  { nickname: "EUNICE",  phone: "012-952 4193" },
  { nickname: "IVERSON", phone: "012-442 4195" },
  { nickname: "JACOB",   phone: "012-511 9423" },
  { nickname: "KAI",     phone: "018-769 9839" },
  { nickname: "KEITH",   phone: "012-499 4195" },
  { nickname: "LUCY",    phone: "012-467 4195" },
  { nickname: "MIYUKI",  phone: "018-910 9839" },
];

export async function listCrd({ includeInactive = false } = {}) {
  const snap = await getDocs(collection(db, "crdTeam"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => includeInactive || p.active !== false)
    .sort((a, b) => String(a.nickname).localeCompare(String(b.nickname)));
}

export async function addCrd({ nickname, phone }) {
  const nick = String(nickname || "").trim().toUpperCase();
  if (!nick) throw new Error("A nickname is needed.");
  const existing = await listCrd({ includeInactive: true });
  if (existing.some(p => String(p.nickname).toUpperCase() === nick)) {
    throw new Error(`${nick} is already on the list.`);
  }
  await addDoc(collection(db, "crdTeam"), {
    nickname: nick, phone: tidyPhone(phone), active: true,
    createdBy: session.email, createdAt: serverTimestamp(),
  });
}

export async function updateCrd(id, patch) {
  const out = { ...patch };
  if (out.nickname !== undefined) out.nickname = String(out.nickname).trim().toUpperCase();
  if (out.phone !== undefined) out.phone = tidyPhone(out.phone);
  await updateDoc(doc(db, "crdTeam", id), out);
}

export async function seedCrd() {
  const existing = await listCrd({ includeInactive: true });
  let added = 0;
  for (const p of DEFAULT_CRD_TEAM) {
    if (existing.some(x => String(x.nickname).toUpperCase() === p.nickname)) continue;
    await addDoc(collection(db, "crdTeam"), { ...p, active: true,
      createdBy: session.email, createdAt: serverTimestamp() });
    added++;
  }
  return added;
}

// ===========================================================================
// Properties import (name, full address, PIC)
// ===========================================================================

const PROPERTY_ALIASES = {
  name: ["propertyname", "property", "name", "condo", "condoname", "project"],
  address: ["fulladdress", "address", "propertyaddress"],
  pic: ["pic", "crd", "crdpic", "personincharge", "picname", "ownergroupadmin"],
  picPhone: ["picphone", "picmobile", "picno", "crdphone", "phone", "mobile"],
};

export function parsePropertyCsv(text) {
  return csvObjects(text, PROPERTY_ALIASES)
    .map(p => ({ ...p, name: p.name.replace(/\s+/g, " ").trim() }))
    .filter(p => p.name);
}

// ===========================================================================
// Settings
// ===========================================================================

export const DEFAULT_SETTINGS = {
  // Where finished PTAAs go (Word).
  ptaaFolderId: "1YWq2jMnTgmEzk6zVEMlpGs5770JcZ71M",
  ptaaFolderName: "",
  ptaaSubfolder: true,              // one sub-folder per condo
  // Where invoices go (Excel): a separate main folder, with one sub-folder per
  // month named from the invoice date — "SEP 26 INV", "OCT 26 INV" …
  invoiceRootId: "1i_6FWMyvUbelVTLcHVDfCRxotkYKkW9r",
  invoiceRootName: "",
  invoiceSubfolder: false,          // (a condo folder inside the month, if wanted)
  invoiceMonthFolders: true,
  invoiceMonthPattern: "MMM YY INV",
  invoiceAsGoogleSheet: true,       // stored in Drive as a Google Sheet, like the rest
  resetInvoiceMonthly: true,        // BLKINV-YYMM001 again each new month
  payment1: 1000,
  payment2: 9000,
  payment3: 0,
  focItems: DEFAULT_FOC_ITEMS,
};

/** Which Drive folder a kind of file goes to: { id, name, subfolder }. */
export function destinationOf(settings, kind) {
  const s = settings || DEFAULT_SETTINGS;
  return kind === "invoice"
    ? { id: s.invoiceRootId || "", name: s.invoiceRootName || "", subfolder: !!s.invoiceSubfolder,
        monthFolders: s.invoiceMonthFolders !== false, monthPattern: s.invoiceMonthPattern || "MMM YY INV" }
    : { id: s.ptaaFolderId || "", name: s.ptaaFolderName || "", subfolder: s.ptaaSubfolder !== false };
}

export async function getSettings() {
  const snap = await getDoc(doc(db, "settings", "app"));
  return { ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) };
}

export async function saveSettings(patch) {
  await setDoc(doc(db, "settings", "app"), {
    ...(await getSettings()), ...patch,
    updatedBy: session.email, updatedAt: serverTimestamp(),
  });
  await logActivity({ action: "settings.updated", summary: "Updated app settings.",
                      detail: { keys: Object.keys(patch) } });
}

// ===========================================================================
// Invoice numbering — counters/invoices { last: "BLKINV-2609033" }
// ===========================================================================

export async function getInvoiceCounter() {
  const snap = await getDoc(doc(db, "counters", "invoices"));
  return snap.exists() ? snap.data() : { last: "" };
}

/** Set where numbering continues from ("the last number I used"). */
export async function setLastInvoiceNo(value) {
  const p = parseInvoiceNo(value);
  if (!p) throw new Error("Type the last invoice number exactly as printed, e.g. BLKINV-2609033.");
  await setDoc(doc(db, "counters", "invoices"), {
    last: `${p.prefix}${p.yymm}${String(p.seq).padStart(3, "0")}`,
    updatedBy: session.email, updatedAt: serverTimestamp(),
  });
  await logActivity({ action: "invoice.counter", summary: `Invoice numbering set to continue after ${value}.` });
}

/** What the next number would be, without taking it. */
export async function peekNextInvoiceNo(settings = null) {
  const s = settings || await getSettings();
  const c = await getInvoiceCounter();
  return nextInvoiceNo(c.last, { resetMonthly: !!s.resetInvoiceMonthly });
}

/**
 * Take the next number, atomically, so two tabs can never issue the same one.
 * A number typed by hand is used as-is and, if it is later than the counter,
 * becomes the new "last".
 */
export async function takeInvoiceNo({ typed = "", resetMonthly = false } = {}) {
  return runTransaction(db, async (tx) => {
    const ref = doc(db, "counters", "invoices");
    const snap = await tx.get(ref);
    const last = snap.exists() ? (snap.data().last || "") : "";
    const next = String(typed || "").trim() || nextInvoiceNo(last, { resetMonthly });
    const pn = parseInvoiceNo(next), pl = parseInvoiceNo(last);
    const later = !pl || (pn && (pn.yymm + String(pn.seq).padStart(6, "0")) > (pl.yymm + String(pl.seq).padStart(6, "0")));
    if (later) tx.set(ref, { last: next, updatedBy: session.email, updatedAt: serverTimestamp() });
    return next;
  });
}
