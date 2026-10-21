// ---------------------------------------------------------------------------
// screens-queue.js — the admin request queue, the agent's own list, the
// property registry, and the two dashboards that sit on top of them.
//
// Filtering and sorting happen in the browser. At this team's volume that is
// cheaper than the composite Firestore indexes the equivalent server-side
// queries would need, and it keeps setup to zero. Phase 13 revisits it.
// ---------------------------------------------------------------------------

import { h, mount, fmtDate, fmtLogTime, friendlyError, toDate, soloMode } from "./core.js";
import { session, isAdmin } from "./auth.js";
import {
  card, button, badge, stat, table, textInput, select, liveField,
  loading, errorBox, noticeBox, toast, confirmAction,
} from "./ui.js";
import {
  STATUS, STATUS_LABEL, STATUS_TONE, ACTOR, OPEN_STATUSES, CLOSED_STATUSES,
  isOverdue, isDueToday, parseDateInput,
} from "./model.js";
import {
  listRequests, listProperties, createProperty, updateProperty, isOpen,
} from "./requests.js";
import {
  listPropertyRequests, approvePropertyRequest, rejectPropertyRequest,
  pendingCount, PROPERTY_REQUEST_STATUS,
} from "./property-requests.js";
import { fullAddress } from "./placeholders.js";
import { listCrd, addCrd, updateCrd, seedCrd, parsePropertyCsv, DEFAULT_CRD_TEAM } from "./directory.js";

// ===========================================================================
// Shared bits
// ===========================================================================

function statusBadge(r) {
  return badge(STATUS_LABEL[r.status] || r.status, STATUS_TONE[r.status] || "neutral");
}

function requestLink(r, navigate) {
  return h("a", {
    class: "req-link", href: "#/request:" + r.id,
    onClick: (e) => { e.preventDefault(); navigate("request:" + r.id); },
  }, r.ptaaId || r.id);
}

function overdueFlag(r) {
  if (isOverdue(parseDateInput(r.dueDate), r.status)) return badge("Overdue", "warn");
  if (isDueToday(parseDateInput(r.dueDate), r.status)) return badge("Due today", "warn");
  return null;
}

function describe(r) {
  return `${r.propertyName || "—"} ${r.unitNo || ""} · ${(r.owner || {}).name || "—"}`;
}

function requestRows(rows, navigate, { showAgent }) {
  return rows.map(r => [
    h("div", {}, requestLink(r, navigate), " ", overdueFlag(r)),
    ...(showAgent ? [h("span", { class: "email small" }, r.agentEmail || "—")] : []),
    (r.owner || {}).name || "—",
    r.propertyName || "—",
    // A unit number split across two lines reads as a different unit.
    h("span", { class: "nowrap" }, r.unitNo || "—"),
    statusBadge(r),
    r.currentAction === ACTOR.NONE ? h("span", { class: "muted" }, "—") : r.currentAction,
    r.dueDate ? fmtDate(parseDateInput(r.dueDate)) : h("span", { class: "muted" }, "—"),
    fmtDate(r.updatedAt),
  ]);
}

const QUEUE_HEADERS_ADMIN = ["PTAA", "Agent", "Owner", "Property", "Unit", "Status", "Current action", "Due", "Updated"];
const QUEUE_HEADERS_AGENT = ["PTAA", "Owner", "Property", "Unit", "Status", "Current action", "Due", "Updated"];

// ===========================================================================
// Admin — request queue (brief §8.2)
// ===========================================================================

export function requestQueueScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  let all = [];

  const filter = { text: "", status: "__open__", action: "", agent: "", property: "" };

  function apply() {
    const t = filter.text.trim().toLowerCase();
    return all.filter(r => {
      if (filter.status === "__open__" && !OPEN_STATUSES.includes(r.status)) return false;
      if (filter.status === "__closed__" && !CLOSED_STATUSES.includes(r.status)) return false;
      if (filter.status && !["__open__", "__closed__", "__all__"].includes(filter.status)
          && r.status !== filter.status) return false;
      if (filter.action && r.currentAction !== filter.action) return false;
      if (filter.agent && r.agentEmail !== filter.agent) return false;
      if (filter.property && r.propertyName !== filter.property) return false;
      if (!t) return true;
      return [r.ptaaId, (r.owner || {}).name, r.propertyName, r.unitNo, r.agentEmail,
              (r.owner || {}).nric, (r.owner || {}).phone]
        .some(v => String(v || "").toLowerCase().includes(t));
    });
  }

  const resultHost = h("div", {});

  function renderResults() {
    const rows = apply();
    mount(resultHost,
      h("p", { class: "muted small" }, `${rows.length} of ${all.length} requests.`),
      table(QUEUE_HEADERS_ADMIN, requestRows(rows, navigate, { showAgent: true }),
            "Nothing matches those filters."),
    );
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Requests"),
      h("p", { class: "screen-sub" },
        "Every PTAA request. “Current action” is who has to do something next — ",
        "that, not status, is what tells you whether it is waiting on you."),
      host);
    mount(host, loading());
    try {
      all = await listRequests({ mine: false });
      const agents = [...new Set(all.map(r => r.agentEmail).filter(Boolean))].sort();
      const props  = [...new Set(all.map(r => r.propertyName).filter(Boolean))].sort();

      mount(host,
        card("Filter",
          h("div", { class: "filter-row" },
            textInput({ id: "q", placeholder: "Search owner, unit, PTAA number, agent…",
                        onInput: (e) => { filter.text = e.target.value; renderResults(); } }),
            select({ id: "f-status", value: filter.status, options: [
                { value: "__open__", label: "Open requests" },
                { value: "__all__", label: "All statuses" },
                { value: "__closed__", label: "Completed / cancelled" },
                ...OPEN_STATUSES.concat(CLOSED_STATUSES).map(s => ({ value: s, label: STATUS_LABEL[s] })),
              ], onChange: (e) => { filter.status = e.target.value; renderResults(); } }),
            select({ id: "f-action", value: filter.action, options: [
                { value: "", label: "Any current action" },
                ...Object.values(ACTOR).map(a => ({ value: a, label: a })),
              ], onChange: (e) => { filter.action = e.target.value; renderResults(); } }),
            select({ id: "f-agent", value: filter.agent, options: [
                { value: "", label: "Any agent" },
                ...agents.map(a => ({ value: a, label: a })),
              ], onChange: (e) => { filter.agent = e.target.value; renderResults(); } }),
            select({ id: "f-property", value: filter.property, options: [
                { value: "", label: "Any property" },
                ...props.map(p => ({ value: p, label: p })),
              ], onChange: (e) => { filter.property = e.target.value; renderResults(); } }),
          ),
        ),
        card(null, resultHost),
      );
      renderResults();
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Agent — my requests (brief §8.3)
// ===========================================================================

const AGENT_GROUPS = [
  { title: "Needs you", test: (r) => isOpen(r) && r.currentAction === ACTOR.AGENT, tone: "warn" },
  { title: "New",                   test: (r) => r.status === STATUS.NEW },
  { title: "Under review",          test: (r) => r.status === STATUS.UNDER_REVIEW },
  { title: "Changes required",      test: (r) => r.status === STATUS.CHANGES_REQUIRED },
  { title: "PTAA OK",               test: (r) => r.status === STATUS.PTAA_OK },
  { title: "Ready for agent",       test: (r) => r.status === STATUS.READY_FOR_AGENT },
  { title: "Waiting for signature", test: (r) => r.status === STATUS.WAITING_FOR_SIGNATURE },
  { title: "Final check",           test: (r) => r.status === STATUS.FINAL_CHECK },
  { title: "On hold",               test: (r) => r.status === STATUS.ON_HOLD },
  { title: "Completed",             test: (r) => r.status === STATUS.COMPLETED },
  { title: "Cancelled",             test: (r) => r.status === STATUS.CANCELLED },
];

export function myRequestsScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "My requests"),
      h("div", { class: "actions" },
        button("+ New PTAA Request", { variant: "primary", onClick: () => navigate("new-request") }),
      ),
      host);
    mount(host, loading());
    try {
      const mine = await listRequests({ mine: true });
      if (!mine.length) {
        mount(host, card(null,
          h("p", { class: "empty" }, "You have not submitted any requests yet."),
          h("div", { class: "actions" },
            button("+ New PTAA Request", { variant: "primary", onClick: () => navigate("new-request") }))));
        return;
      }

      const needs = mine.filter(AGENT_GROUPS[0].test);
      const sections = AGENT_GROUPS.slice(1)
        .map(g => ({ ...g, rows: mine.filter(g.test) }))
        .filter(g => g.rows.length);

      mount(host,
        needs.length
          ? card("Waiting on you",
              table(QUEUE_HEADERS_AGENT, requestRows(needs, navigate, { showAgent: false })))
          : noticeBox("info", h("p", {}, "Nothing is waiting on you right now.")),
        ...sections.map(g => card(`${g.title} (${g.rows.length})`,
          table(QUEUE_HEADERS_AGENT, requestRows(g.rows, navigate, { showAgent: false })))),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Admin — properties registry
// ===========================================================================

export function propertiesScreen() {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  let props = [], asks = [], crd = [];

  // --- PIC (the Customer Relationship person looking after the condo) -------

  function picSelect(p) {
    const current = crd.find(c => c.nickname === String(p.picNickname || "").toUpperCase());
    return select({
      id: "pic-" + p.id, value: current ? current.id : (p.picNickname ? "__other__" : ""),
      options: [
        { value: "", label: "— no PIC —" },
        ...crd.map(c => ({ value: c.id, label: `${c.nickname} · ${c.phone || ""}` })),
        ...(!current && p.picNickname ? [{ value: "__other__", label: `${p.picNickname} (not on the CRD list)` }] : []),
      ],
      onChange: async (e) => {
        const c = crd.find(x => x.id === e.target.value);
        try {
          await updateProperty(p.id, c ? { picNickname: c.nickname, picMobile: c.phone || "" }
                                       : { picNickname: "", picMobile: "" });
          toast(`${p.name}: PIC ${c ? c.nickname : "cleared"}.`);
          await load();
        } catch (err) { toast(friendlyError(err), "error"); }
      },
    });
  }

  async function importProperties(file) {
    try {
      const rows = parsePropertyCsv(await file.text());
      if (!rows.length) { toast("No condos found in that file. The first row must be the column names.", "warn"); return; }
      let added = 0, updated = 0;
      const unknownPic = new Set();
      for (const r of rows) {
        const c = r.pic ? crd.find(x => x.nickname === r.pic.trim().toUpperCase()) : null;
        if (r.pic && !c) unknownPic.add(r.pic.trim());
        const pic = c ? { picNickname: c.nickname, picMobile: c.phone || "" }
                      : r.pic ? { picNickname: r.pic.trim().toUpperCase(), picMobile: r.picPhone || "" } : {};
        const have = props.find(p => String(p.name).toLowerCase() === r.name.toLowerCase());
        if (have) {
          const patch = { ...pic };
          if (r.address) patch.address = r.address;
          if (Object.keys(patch).length) { await updateProperty(have.id, patch); updated++; }
        } else {
          await createProperty({ name: r.name, address: r.address, picNickname: pic.picNickname || "", picMobile: pic.picMobile || "" });
          added++;
        }
      }
      window.alert(`Import finished.\n\n${added} condo${added === 1 ? "" : "s"} added, ${updated} updated.` +
        (unknownPic.size ? `\n\nNot on the CRD team list (kept as typed): ${[...unknownPic].join(", ")}.` : ""));
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function crdCard() {
    const nick = textInput({ id: "crd-nick", placeholder: "Nickname, e.g. AMELIE" });
    const phone = textInput({ id: "crd-phone", placeholder: "Mobile" });
    return card(`Customer Relationship team (${crd.filter(c => c.active !== false).length})`,
      h("p", { class: "muted small" },
        "The PIC for each condo is picked from this list; their nickname and number print in the agreement ",
        "as the Owner Group Admin."),
      crd.length
        ? table(["Nickname", "Mobile", ""], crd.map(c => [
            h("strong", {}, c.nickname),
            h("span", { class: "nowrap" }, c.phone || "—"),
            h("div", { class: "row-actions" },
              button("Edit", { variant: "quiet", onClick: async () => {
                const n = window.prompt("Nickname:", c.nickname); if (n === null) return;
                const m = window.prompt("Mobile:", c.phone || ""); if (m === null) return;
                try { await updateCrd(c.id, { nickname: n, phone: m }); await load(); }
                catch (err) { toast(friendlyError(err), "error"); }
              } }),
              button(c.active === false ? "Show" : "Hide", { variant: "quiet", onClick: async () => {
                await updateCrd(c.id, { active: c.active === false }); await load(); } }),
            ),
          ]))
        : h("div", {},
            h("p", { class: "empty" }, "Nobody on the list yet."),
            h("div", { class: "actions" }, button(`Add the ${DEFAULT_CRD_TEAM.length} from the CRD team list`, {
              variant: "primary", onClick: async () => {
                try { const n = await seedCrd(); toast(`${n} added.`); await load(); }
                catch (err) { toast(friendlyError(err), "error"); }
              } }))),
      h("div", { class: "add-user" }, nick, phone,
        button("Add", { variant: "quiet", onClick: async () => {
          try { await addCrd({ nickname: nick.value, phone: phone.value }); await load(); }
          catch (err) { toast(err.message || friendlyError(err), "error"); }
        } })),
    );
  }
  const draft = { name: "", address: "", picNickname: "", picMobile: "" };

  async function add() {
    try {
      await createProperty(draft);
      toast(`“${draft.name.trim()}” added.`);
      draft.name = ""; draft.address = ""; draft.picNickname = ""; draft.picMobile = "";
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  // --- Agents asking for a condo that is not on the list --------------------

  async function approve(ask) {
    const name = window.prompt(
      "Add this property as:\n\n" +
      "Correct the spelling if you need to — this is what goes on every document " +
      "and folder for this condo.", ask.name);
    if (name === null) return;
    if (!String(name).trim()) { toast("A name is needed.", "warn"); return; }

    const address = window.prompt(`Address for “${name.trim()}” (optional):`, ask.address || "");
    if (address === null) return;
    const picNickname = window.prompt(
      "Owner Group Admin nickname for this property (optional)\n\n" +
      "e.g. Keith — this prints in the agreement.", "");
    if (picNickname === null) return;
    const picMobile = picNickname.trim()
      ? window.prompt(`Mobile number for ${picNickname.trim()} (optional):`, "")
      : "";
    if (picMobile === null) return;

    try {
      await approvePropertyRequest(ask.id, { name, address, picNickname, picMobile });
      toast(`“${name.trim()}” added. ${ask.requestedBy} has been notified.`);
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function reject(ask) {
    const reason = window.prompt(
      `Decline the request for “${ask.name}”?\n\n` +
      "Say why — the agent sees this, so give them something they can act on\n" +
      "e.g. \"already on the list as M ASTRA\".", "");
    if (reason === null) return;
    if (!String(reason).trim()) { toast("A reason is needed — the agent will see it.", "warn"); return; }
    try {
      await rejectPropertyRequest(ask.id, reason);
      toast("Declined, and the agent has been told why.");
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function asksCard() {
    const pending = asks.filter(a => a.status === PROPERTY_REQUEST_STATUS.PENDING);
    const decided = asks.filter(a => a.status !== PROPERTY_REQUEST_STATUS.PENDING).slice(0, 10);

    return card(`Requests from agents (${pending.length} waiting)`,
      h("p", { class: "muted small" },
        "When an agent takes on a condo that is not on the list they ask here. ",
        "Approving is what adds the property — with the spelling you settle on, not theirs."),
      pending.length
        ? table(["Condo", "Address", "Note", "Asked by", ""],
            pending.map(a => [
              h("strong", {}, a.name),
              a.address || h("span", { class: "muted" }, "—"),
              a.note ? h("span", { class: "small" }, a.note) : h("span", { class: "muted" }, "—"),
              h("span", { class: "small" }, a.requestedBy, h("br"), fmtLogTime(a.requestedAt)),
              h("div", { class: "row-actions" },
                button("Add it", { variant: "primary", onClick: () => approve(a) }),
                button("Decline", { variant: "quiet-danger", onClick: () => reject(a) }),
              ),
            ]))
        : h("p", { class: "empty" }, "Nothing waiting."),
      decided.length
        ? h("details", { class: "fold" },
            h("summary", {}, `Recently decided (${decided.length})`),
            table(["Condo", "Outcome", "By", "When"],
              decided.map(a => [
                a.name,
                a.status === PROPERTY_REQUEST_STATUS.APPROVED
                  ? badge("Added", "ok")
                  : h("span", {}, badge("Declined", "warn"),
                      a.decisionNote ? h("span", { class: "muted small" }, " " + a.decisionNote) : null),
                a.decidedBy || "—",
                fmtLogTime(a.decidedAt),
              ])))
        : null,
    );
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Properties"),
      h("p", { class: "screen-sub" },
        "Agents pick from this list rather than typing a condo name. The name here becomes ",
        "the Drive folder and part of the filename, so one spelling per property matters."),
      host);
    mount(host, loading());
    try {
      [props, asks, crd] = await Promise.all([
        listProperties({ includeInactive: true }),
        soloMode ? Promise.resolve([]) : listPropertyRequests().catch(() => []),
        listCrd({ includeInactive: true }).catch(() => []),
      ]);
      const importIn = h("input", { type: "file", accept: ".csv,text/csv", class: "visually-hidden",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importProperties(f); } });

      // How the condo will read in the agreement, as it is typed.
      const printsAs = h("code", { class: "filename" });
      const paintPrintsAs = () => {
        printsAs.textContent = fullAddress({ unitNo: "B-38-12", propertyName: draft.name || "CONDO NAME",
                                             propertyAddress: draft.address || "full address" });
      };
      const nameInput = textInput({ id: "p-name", value: draft.name, placeholder: "M ASTRA",
        onInput: (e) => { draft.name = e.target.value; paintPrintsAs(); } });
      const addrInput = textInput({ id: "p-address", value: draft.address, placeholder: "Address, without unit or condo name",
        onInput: (e) => { draft.address = e.target.value; paintPrintsAs(); } });
      paintPrintsAs();
      const picInput = textInput({ id: "p-pic", value: draft.picNickname, placeholder: "Owner Group Admin, e.g. Keith",
        onInput: (e) => { draft.picNickname = e.target.value; } });
      const mobileInput = textInput({ id: "p-mobile", value: draft.picMobile, placeholder: "Their mobile",
        onInput: (e) => { draft.picMobile = e.target.value; } });

      mount(host,
        pendingCount(asks) ? asksCard() : null,

        card("Add a property",
          h("div", { class: "add-user" }, nameInput, addrInput,
            button("Add", { variant: "primary", onClick: add })),
          h("div", { class: "add-user" }, picInput, mobileInput),
          h("p", { class: "muted small" }, "In the PTAA (front page and Schedule 1 item 2) this prints as — with the unit from each PTAA:"),
          printsAs,
          h("p", { class: "muted small" },
            "Use the spelling that should appear in the document and the Drive folder. ",
            "The Owner Group Admin is the person named in the agreement for this condo — ",
            "one per property, so it does not have to be typed on every request."),
          h("p", { class: "muted small" },
            "Or import many at once: a CSV with the columns Property Name, Full Address and PIC ",
            "(the PIC's nickname from the CRD team list). Condos already listed get their address and PIC updated."),
          h("div", { class: "actions" }, importIn,
            button("Import CSV…", { variant: "quiet", onClick: () => importIn.click() })),
        ),

        card(`Properties (${props.length})`,
          h("p", { class: "muted small" },
            "“Prints as” is how the address reads in the agreement — the unit number (shown here as ",
            h("code", {}, "[unit]"), ") comes from each PTAA."),
          table(["Name", "Prints in the PTAA as", "PIC (Owner Group Admin)", "Status", ""],
            props.map(p => [
              p.name,
              p.address
                ? h("span", {}, fullAddress({ unitNo: "[unit]", propertyName: p.name, propertyAddress: p.address }))
                : h("span", { class: "muted" }, `[unit], ${p.name} — address missing, click “Address”`),
              crd.length ? picSelect(p)
              : p.picNickname
                ? h("span", {}, p.picNickname,
                    p.picMobile ? h("span", { class: "muted small" }, " · " + p.picMobile) : null)
                : h("span", { class: "muted" }, "—"),
              p.active === false ? badge("Hidden", "off") : badge("In use", "ok"),
              h("div", { class: "row-actions" },
                button("Rename", {
                  variant: "quiet",
                  title: "Change how the condo name is spelled",
                  onClick: async () => {
                    const name = window.prompt(
                      `New name for ${p.name}:\n\n` +
                      "Spell it exactly as it should print in the agreement — it is also the Drive folder name " +
                      "and part of the file names.", p.name || "");
                    if (name === null) return;
                    const clean = name.trim().replace(/\s+/g, " ");
                    if (!clean) { toast("A name is needed.", "warn"); return; }
                    if (clean === p.name) return;
                    const clash = props.find(x => x.id !== p.id && String(x.name || "").toLowerCase() === clean.toLowerCase());
                    if (clash) { toast(`“${clash.name}” is already on the list.`, "error"); return; }
                    try {
                      await updateProperty(p.id, { name: clean, nameLower: clean.toLowerCase() });
                      toast(`Renamed to ${clean}. PTAAs started from now on use the new name.`);
                      await load();
                    } catch (err) { toast(friendlyError(err), "error"); }
                  },
                }),
                button("Address", {
                  variant: "quiet",
                  title: "The condo's postal address, without the unit or the condo name",
                  onClick: async () => {
                    const addr = window.prompt(
                      `Full address of ${p.name}, without the unit or the condo name:\n\n` +
                      "e.g. Jalan Jernih 1, Taman Jernih, 58200 Kuala Lumpur", p.address || "");
                    if (addr === null) return;
                    try {
                      await updateProperty(p.id, { address: addr.trim().replace(/\s+/g, " ") });
                      toast("Address saved.");
                      await load();
                    } catch (err) { toast(friendlyError(err), "error"); }
                  },
                }),
                button("Owner Group Admin", {
                  variant: "quiet",
                  onClick: async () => {
                    const nick = window.prompt(
                      `Owner Group Admin for ${p.name}:\n\nThe nickname as it should print, e.g. Keith.`,
                      p.picNickname || "");
                    if (nick === null) return;
                    const mob = window.prompt(`Mobile number for ${nick.trim() || "them"}:`, p.picMobile || "");
                    if (mob === null) return;
                    try {
                      await updateProperty(p.id, { picNickname: nick.trim(), picMobile: mob.trim() });
                      toast("Updated.");
                      await load();
                    } catch (err) { toast(friendlyError(err), "error"); }
                  },
                }),
                button(p.active === false ? "Show to agents" : "Hide from agents", {
                  variant: "quiet",
                  onClick: async () => {
                    try {
                      await updateProperty(p.id, { active: p.active === false });
                      await load();
                    } catch (err) { toast(friendlyError(err), "error"); }
                  },
                }),
              ),
            ]),
            "No properties yet. Agents cannot submit a request until at least one exists."),
        ),

        crdCard(),

        soloMode || pendingCount(asks) ? null : asksCard(),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Dashboards (brief §8.1, §8.3)
// ===========================================================================

/** extraCards: array of zero-argument functions returning a node, appended below. */
export function adminDashboard(navigate, extraCards = []) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function load() {
    mount(root, h("h1", { class: "screen-title" }, "Admin dashboard"), host);
    mount(host, loading());
    try {
      const all = await listRequests({ mine: false });
      const open = all.filter(isOpen);
      const mine = open.filter(r => r.currentAction === ACTOR.ADMIN);
      const overdue = open.filter(r => isOverdue(parseDateInput(r.dueDate), r.status));
      const dueToday = open.filter(r => isDueToday(parseDateInput(r.dueDate), r.status));

      // Ordered as brief §8.1 asks: what needs me, most urgent first.
      const buckets = [
        { title: "Overdue", rows: overdue, tone: "warn" },
        { title: "Due today", rows: dueToday, tone: "warn" },
        { title: "New requests", rows: mine.filter(r => r.status === STATUS.NEW) },
        { title: "Awaiting my check", rows: mine.filter(r => r.status === STATUS.UNDER_REVIEW) },
        { title: "Confirmed, not yet released", rows: mine.filter(r => r.status === STATUS.PTAA_OK) },
        { title: "Awaiting final completion", rows: mine.filter(r => r.status === STATUS.FINAL_CHECK) },
      ].filter(b => b.rows.length);

      const waitingOnOthers = open.filter(r => r.currentAction !== ACTOR.ADMIN);

      mount(host,
        h("div", { class: "stats" },
          stat("Open requests", open.length),
          stat("Waiting on me", mine.length, mine.length ? "warn" : "ok"),
          stat("Waiting on others", waitingOnOthers.length),
          stat("Overdue", overdue.length, overdue.length ? "warn" : "ok"),
        ),

        buckets.length
          ? h("div", {}, buckets.map(b => card(`${b.title} (${b.rows.length})`,
              table(QUEUE_HEADERS_ADMIN, requestRows(b.rows, navigate, { showAgent: true })))))
          : card("Needs my attention",
              h("p", { class: "empty" }, all.length
                ? "Nothing is waiting on you."
                : "No requests have been submitted yet.")),

        waitingOnOthers.length
          ? card(`Waiting on someone else (${waitingOnOthers.length})`,
              table(QUEUE_HEADERS_ADMIN, requestRows(waitingOnOthers, navigate, { showAgent: true })))
          : null,

        card("Go to",
          h("div", { class: "actions" },
            button("All requests", { onClick: () => navigate("requests") }),
            button("Properties", { variant: "quiet", onClick: () => navigate("properties") }),
            button("Users", { variant: "quiet", onClick: () => navigate("users") }),
            button("Activity log", { variant: "quiet", onClick: () => navigate("activity") }),
          ),
        ),

        ...extraCards.map(fn => fn()),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

export function agentDashboard(navigate, extraCards = []) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function load() {
    mount(root, h("h1", { class: "screen-title" }, "My dashboard"), host);
    mount(host, loading());
    try {
      const mine = await listRequests({ mine: true });
      const open = mine.filter(isOpen);
      const needsMe = open.filter(r => r.currentAction === ACTOR.AGENT);

      mount(host,
        h("div", { class: "stats" },
          stat("Open requests", open.length),
          stat("Waiting on you", needsMe.length, needsMe.length ? "warn" : "ok"),
          stat("Completed", mine.filter(r => r.status === STATUS.COMPLETED).length),
        ),
        needsMe.length
          ? card(`Waiting on you (${needsMe.length})`,
              table(QUEUE_HEADERS_AGENT, requestRows(needsMe, navigate, { showAgent: false })))
          : noticeBox("info", h("p", {}, "Nothing is waiting on you right now.")),
        card("Start something",
          h("div", { class: "actions" },
            button("+ New PTAA Request", { variant: "primary", onClick: () => navigate("new-request") }),
            button("My requests", { variant: "quiet", onClick: () => navigate("requests") }),
          ),
        ),
        ...extraCards.map(fn => fn()),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}
