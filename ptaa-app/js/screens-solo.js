// ---------------------------------------------------------------------------
// screens-solo.js — screens for running the app on your own (config.js →
// workflow.solo): the dashboard, the PTAA list, the Sales Agent list and the
// settings.
// ---------------------------------------------------------------------------

import { h, mount, fmtDate, friendlyError, toDate } from "./core.js";
import { session, profileComplete } from "./auth.js";
import {
  card, button, badge, stat, table, textInput, textarea, select, loading, errorBox, noticeBox, toast, confirmAction,
} from "./ui.js";
import { STATUS, soloStage, SOLO_STAGES, tenancyMissing, costClash, fmtMoney } from "./model.js";
import { listMyDrafts } from "./drafts.js";
import { listRequests, listProperties } from "./requests.js";
import { listTemplates, SHARED_TEMPLATE_ID } from "./templates.js";
import { templateCard } from "./screens-templates.js";
import { resolveCostDifference } from "./screens-invoice.js";
import {
  listAgents, addAgent, updateAgent, setAgentActive, importAgents, normaliseAgent,
  getSettings, saveSettings, driveFolderIdFrom, destinationOf, monthFolderName, getInvoiceCounter, setLastInvoiceNo, peekNextInvoiceNo,
} from "./directory.js";
import { testDriveFolder, driveAdvice, driveToken } from "./drive.js";

function link(r, navigate) {
  return h("a", { class: "req-link", href: "#/request:" + r.id,
    onClick: (e) => { e.preventDefault(); navigate("request:" + r.id); } }, r.ptaaId || r.id);
}

function rows(list, navigate) {
  return list.map(r => {
    const st = soloStage(r);
    return [
      link(r, navigate),
      (r.owner || {}).name || "—",
      r.propertyName || "—",
      h("span", { class: "nowrap" }, r.unitNo || "—"),
      (r.agentSnapshot || {}).nickname || "—",
      h("span", {}, badge(st.label, st.tone), costClash(r) ? [" ", badge("Cost ≠ invoice", "warn")] : null),
      (r.invoice || {}).invoiceNo || h("span", { class: "muted" }, "—"),
      fmtDate(r.updatedAt),
    ];
  });
}
const HEADERS = ["PTAA", "Owner", "Condo", "Unit", "Agent", "Stage", "Invoice", "Updated"];

// ===========================================================================
// Dashboard
// ===========================================================================

export function soloDashboard(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function setupCard() {
    const [props, templates, agents, settings, counter] = await Promise.all([
      listProperties().catch(() => []), listTemplates().catch(() => []), listAgents().catch(() => []),
      getSettings().catch(() => ({})), getInvoiceCounter().catch(() => ({})),
    ]);
    const items = [
      { done: profileComplete(), text: "Your own profile (full name, I/C, mobile) — you are the witness on every PTAA", to: "profile" },
      { done: props.length > 0, text: `Condos on the list (${props.length})`, to: "properties" },
      { done: templates.some(t => t.id === SHARED_TEMPLATE_ID), text: "The PTAA Word template (one for every condo)", to: "settings" },
      { done: props.length > 0 && props.every(p => String(p.address || "").trim()), text: "Every condo has its full address", to: "properties" },
      { done: agents.length > 0, text: `Sales Agents on the list (${agents.length})`, to: "agents" },
      { done: !!(settings.ptaaFolderId && settings.invoiceRootId), text: "Google Drive folders chosen (PTAAs and invoices)", to: "settings" },
      { done: !!counter.last, text: counter.last ? `Invoice numbering continues after ${counter.last}` : "Last invoice number used", to: "settings" },
    ];
    if (items.every(i => i.done)) return null;
    return card("Setting up",
      h("ul", { class: "checklist" }, items.map(i => h("li", { class: "check-row" + (i.done ? " done" : "") },
        h("span", { class: "tick" }, i.done ? "✓" : "○"),
        h("span", {}, i.text, " "),
        i.done ? null : button("Open", { variant: "link", onClick: () => navigate(i.to) })))),
    );
  }

  async function load() {
    mount(root, h("div", { class: "detail-head" },
      h("h1", { class: "screen-title" }, "PTAAs"),
      h("div", { class: "actions" }, button("+ New PTAA", { variant: "primary", onClick: () => navigate("new-request") }))),
      host);
    mount(host, loading());
    try {
      const [all, drafts] = await Promise.all([listRequests({ mine: false }), listMyDrafts().catch(() => [])]);
      const open = all.filter(r => ![STATUS.COMPLETED, STATUS.CANCELLED].includes(r.status));
      // Submitted by a Sales Agent and not started yet.
      const fresh = open.filter(r => r.createdBy && r.createdBy !== session.email && !r.workingDoc && !(r.invoice && r.invoice.file));
      const ready = open.filter(r => soloStage(r) === SOLO_STAGES.READY);
      const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const filed = all.filter(r => r.status === STATUS.COMPLETED);
      const filedMonth = filed.filter(r => { const d = toDate(r.completedAt); return d && d >= monthStart; });
      const setup = await setupCard();

      const clashes = all.map(r => ({ r, c: costClash(r) })).filter(x => x.c);
      mount(host,
        setup,
        clashes.length
          ? card(`Renovation cost and invoice don't match (${clashes.length})`,
              h("p", { class: "muted small" },
                "The agreement prints the renovation cost from the PTAA's details; the invoice has its own total. ",
                "Fix whichever is wrong — Edit details on the PTAA, or the invoice — then redraft."),
              table(["PTAA", "Owner", "Condo / unit", "Renovation cost (PTAA)", "Invoice total", "Difference", ""],
                clashes.map(({ r, c }) => [
                  link(r, navigate), (r.owner || {}).name || "—", `${r.propertyName || "—"} ${r.unitNo || ""}`,
                  c.renovationCost === null ? "NIL" : fmtMoney(c.renovationCost),
                  fmtMoney(c.invoiceTotal),
                  c.difference === null ? "—" : h("strong", {}, (c.difference > 0 ? "+" : "") + fmtMoney(c.difference)),
                  button("Sort it out…", { variant: "quiet", onClick: async () => {
                    try { if (await resolveCostDifference(r, c.invoiceTotal)) await load(); }
                    catch (err) { toast(friendlyError(err), "error"); }
                  } }),
                ])))
          : null,
        fresh.length
          ? card(`New from Sales Agents (${fresh.length})`,
              h("p", { class: "muted small" }, "Submitted and waiting for you. Set the tenancy period, then draft the PTAA."),
              table(["PTAA", "Owner", "Condo", "Unit", "Agent", "Tenancy", "Submitted"], fresh.map(r => [
                link(r, navigate), (r.owner || {}).name || "—", r.propertyName || "—",
                h("span", { class: "nowrap" }, r.unitNo || "—"),
                (r.agentSnapshot || {}).nickname || r.agentEmail || "—",
                tenancyMissing(r).length ? badge("Not set", "warn") : badge("Set", "ok"),
                fmtDate(r.createdAt),
              ])))
          : null,
        drafts.length
          ? card(`My drafts (${drafts.length})`,
              table(["Draft", "Last saved"], drafts.map(d => [
                h("a", { class: "req-link", href: "#/new-request:" + d.id,
                  onClick: (e) => { e.preventDefault(); navigate("new-request:" + d.id); } }, d.title || "Untitled draft"),
                fmtDate(d.updatedAt),
              ])))
          : null,
        h("div", { class: "stats" },
          stat("In progress", open.length),
          stat("Ready to file", ready.length, ready.length ? "warn" : "ok"),
          stat("Filed this month", filedMonth.length, "ok"),
          stat("Filed in total", filed.length),
        ),
        card(`In progress (${open.length})`,
          table(HEADERS, rows(open, navigate), all.length ? "Nothing in progress." : "No PTAAs yet — start one with “New PTAA”.")),
        filed.length
          ? card("Recently filed", table(HEADERS, rows(filed.slice(0, 10), navigate)),
              h("div", { class: "actions" }, button("All PTAAs", { variant: "quiet", onClick: () => navigate("requests") })))
          : null,
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}

// ===========================================================================
// All PTAAs
// ===========================================================================

export function soloListScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  const resultHost = h("div", {});
  let all = [];
  const filter = { text: "", stage: "__open__" };

  function apply() {
    const t = filter.text.trim().toLowerCase();
    return all.filter(r => {
      const st = soloStage(r);
      if (filter.stage === "__open__" && [SOLO_STAGES.FILED, SOLO_STAGES.CANCELLED].includes(st)) return false;
      if (!["__open__", "__all__"].includes(filter.stage) && st.key !== filter.stage) return false;
      if (!t) return true;
      return [r.ptaaId, (r.owner || {}).name, r.propertyName, r.unitNo, (r.agentSnapshot || {}).nickname,
              (r.agentSnapshot || {}).fullName, (r.invoice || {}).invoiceNo, (r.owner || {}).nric]
        .some(v => String(v || "").toLowerCase().includes(t));
    });
  }
  function renderResults() {
    const list = apply();
    mount(resultHost,
      h("p", { class: "muted small" }, `${list.length} of ${all.length}.`),
      table(HEADERS, rows(list, navigate), "Nothing matches."));
  }

  async function load() {
    mount(root, h("div", { class: "detail-head" },
      h("h1", { class: "screen-title" }, "All PTAAs"),
      h("div", { class: "actions" }, button("+ New PTAA", { variant: "primary", onClick: () => navigate("new-request") }))),
      host);
    mount(host, loading());
    try {
      all = await listRequests({ mine: false });
      mount(host,
        card(null, h("div", { class: "filters" },
          textInput({ id: "f-text", placeholder: "Owner, condo, unit, agent, PTAA or invoice number…",
            onInput: (e) => { filter.text = e.target.value; renderResults(); } }),
          select({ id: "f-stage", value: filter.stage, options: [
            { value: "__open__", label: "In progress" },
            { value: "__all__", label: "All" },
            ...Object.values(SOLO_STAGES).map(s => ({ value: s.key, label: s.label })),
          ], onChange: (e) => { filter.stage = e.target.value; renderResults(); } }),
        )),
        resultHost);
      renderResults();
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}

// ===========================================================================
// Sales Agents (a list to pick from — not sign-in accounts)
// ===========================================================================

export function agentsScreen() {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  let agents = [];
  let showHidden = false;
  const draft = { fullName: "", nickname: "", nric: "", phone: "", email: "" };

  async function doImport(file) {
    try {
      const text = await file.text();
      const plan = await importAgents(text);
      const lines = [`${plan.toAdd.length} added.`];
      if (plan.already.length) lines.push(`${plan.already.length} already on the list, skipped.`);
      if (plan.duplicates.length) {
        lines.push(`${plan.duplicates.length} duplicate row${plan.duplicates.length === 1 ? "" : "s"} in the file, skipped: ` +
          plan.duplicates.map(d => `${d.value.nickname || d.value.fullName} (same as ${d.of.nickname || d.of.fullName})`).join(", ") + ".");
      }
      window.alert("Import finished.\n\n" + lines.join("\n"));
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  function editAgent(a) {
    const ask = (label, v) => window.prompt(label, v || "");
    const fullName = ask(`Full name for ${a.nickname || a.fullName}:`, a.fullName); if (fullName === null) return;
    const nickname = ask("Nickname:", a.nickname); if (nickname === null) return;
    const nric = ask("I/C number:", a.nric); if (nric === null) return;
    const phone = ask("Mobile number:", a.phone); if (phone === null) return;
    const email = ask("Email (optional — kept on file only, not a sign-in):", a.email); if (email === null) return;
    updateAgent(a.id, { fullName, nickname, nric, phone, email })
      .then(() => { toast("Saved."); return load(); })
      .catch(err => toast(err.message || friendlyError(err), "error"));
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Sales Agents"),
      h("p", { class: "screen-sub" },
        "The agents you pick from when starting a PTAA. Their full name, I/C and mobile go into the ",
        "“Witnessed by” block. This is only a list — nobody here can sign in, and no email is registered."),
      host);
    mount(host, loading());
    try {
      agents = await listAgents({ includeInactive: true });
      const visible = agents.filter(a => showHidden || a.active !== false);
      const incomplete = agents.filter(a => a.active !== false && normaliseAgent(a).problems.length);

      const input = (key, ph) => textInput({ id: "ag-" + key, value: draft[key], placeholder: ph,
        onInput: (e) => { draft[key] = e.target.value; } });
      const fileIn = h("input", { type: "file", accept: ".csv,text/csv", class: "visually-hidden",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) doImport(f); } });

      mount(host,
        incomplete.length
          ? noticeBox("warn",
              h("p", {}, h("strong", {}, `${incomplete.length} agent${incomplete.length === 1 ? " needs" : "s need"} details before their PTAAs print correctly:`)),
              h("ul", { class: "bullets" }, incomplete.map(a =>
                h("li", {}, `${a.nickname || a.fullName} — ${normaliseAgent(a).problems.join(", ")}`))))
          : null,
        card("Add an agent",
          h("div", { class: "add-user" }, input("fullName", "Full name, e.g. TAN CHIN EU"), input("nickname", "Nickname, e.g. Paul")),
          h("div", { class: "add-user" }, input("nric", "I/C, e.g. 850924-14-6503"), input("phone", "Mobile, e.g. 016-303 0477")),
          h("div", { class: "add-user" }, input("email", "Email (optional, not a sign-in)"),
            button("Add", { variant: "primary", onClick: async () => {
              try {
                await addAgent(draft);
                toast(`${draft.nickname || draft.fullName} added.`);
                for (const k of Object.keys(draft)) draft[k] = "";
                await load();
              } catch (err) { toast(err.message || friendlyError(err), "error"); }
            } })),
          h("p", { class: "muted small" },
            "Or import a list: a CSV with the columns Full Name, Nickname, NRIC No, Email Address, Contact No. ",
            "Anyone already on the list (same I/C, or same name when there is no I/C) is skipped, and so are ",
            "repeated rows in the file."),
          h("div", { class: "actions" }, fileIn, button("Import CSV…", { variant: "quiet", onClick: () => fileIn.click() })),
        ),
        card(`Agents (${agents.filter(a => a.active !== false).length})`,
          h("label", { class: "inline-check" },
            (() => { const c = h("input", { type: "checkbox" }); c.checked = showHidden;
                     c.addEventListener("change", () => { showHidden = c.checked; load(); }); return c; })(),
            " Show hidden"),
          table(["Nickname", "Full name", "I/C", "Mobile", "Email (not a sign-in)", ""],
            visible.map(a => {
              const probs = normaliseAgent(a).problems;
              return [
                h("strong", {}, a.nickname || "—"),
                a.fullName || h("span", { class: "muted" }, "—"),
                a.nric || h("span", { class: "muted" }, "—"),
                h("span", { class: "nowrap" }, a.phone || "—"),
                h("span", { class: "small" }, a.email || "—"),
                h("div", { class: "row-actions" },
                  probs.length ? badge("Incomplete", "warn") : null,
                  a.active === false ? badge("Hidden", "off") : null,
                  button("Edit", { variant: "quiet", onClick: () => editAgent(a) }),
                  button(a.active === false ? "Show" : "Hide", { variant: "quiet",
                    onClick: async () => { await setAgentActive(a.id, a.active === false); await load(); } }),
                ),
              ];
            }),
            "No agents yet. Add them above or import the list."),
        ),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}

// ===========================================================================
// Settings
// ===========================================================================

export function settingsScreen() {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  const template = templateCard();       // loads itself; kept across reloads

  async function load() {
    mount(root, h("h1", { class: "screen-title" }, "Settings"), template, host);
    mount(host, loading());
    try {
      const [s, counter] = await Promise.all([getSettings(), getInvoiceCounter()]);
      const next = await peekNextInvoiceNo(s).catch(() => "");

      // --- Drive: one card per destination ---
      function folderCard(kind) {
        const isInv = kind === "invoice";
        const idKey = isInv ? "invoiceRootId" : "ptaaFolderId";
        const nameKey = isInv ? "invoiceRootName" : "ptaaFolderName";
        const subKey = isInv ? "invoiceSubfolder" : "ptaaSubfolder";
        const cur = destinationOf(s, kind);
        const input = textInput({ id: `set-${kind}-folder`,
          value: cur.id ? `https://drive.google.com/drive/folders/${cur.id}` : "",
          placeholder: "https://drive.google.com/drive/folders/…" });
        const sub = h("input", { type: "checkbox", id: `set-${kind}-sub` }); sub.checked = cur.subfolder;
        const monthBox = h("input", { type: "checkbox", id: "set-inv-month" }); monthBox.checked = !!cur.monthFolders;
        const sheetBox = h("input", { type: "checkbox", id: "set-inv-sheet" }); sheetBox.checked = s.invoiceAsGoogleSheet !== false;
        const patternIn = textInput({ id: "set-inv-pattern", value: cur.monthPattern || "MMM YY INV" });
        const example = h("code", {}, monthFolderName(cur.monthPattern, new Date()));
        patternIn.addEventListener("input", () => { example.textContent = monthFolderName(patternIn.value, new Date()); });
        const msg = h("div", {});

        async function save() {
          const id = driveFolderIdFrom(input.value);
          if (input.value.trim() && !id) throw new Error("That does not look like a Google Drive folder link.");
          const patch = { [idKey]: id, [nameKey]: id === cur.id ? cur.name : "", [subKey]: sub.checked };
          if (isInv) { patch.invoiceMonthFolders = monthBox.checked; patch.invoiceMonthPattern = patternIn.value.trim() || "MMM YY INV";
                       patch.invoiceAsGoogleSheet = sheetBox.checked; }
          await saveSettings(patch);
          return id;
        }
        const testBtn = button("Save and test", { variant: "primary" });
        testBtn.addEventListener("click", async () => {
          try {
            const token = await driveToken();      // first, so the pop-up is not blocked
            await save();
            const folder = await testDriveFolder(null, token, kind);
            await saveSettings({ [nameKey]: folder.name });
            mount(msg, noticeBox("info", h("p", {}, "Connected. ", isInv ? "Invoices" : "PTAAs",
              " will be filed into ", h("strong", {}, folder.name), ".")));
          } catch (err) {
            mount(msg, noticeBox("error", h("p", {}, err.message || friendlyError(err)),
              err.code ? h("p", { class: "small" }, driveAdvice(err.code)) : null));
          }
        });

        return card(isInv ? "Google Drive — invoices (Excel)" : "Google Drive — PTAAs (Word)",
          h("p", { class: "muted small" }, isInv
            ? "The MAIN invoice folder. Each invoice goes into its month's folder inside it, picked from the invoice date — " +
              "an existing month folder is used, a missing one is created. Nothing to change when a new month starts."
            : "Where the confirmed PTAA agreements are filed."),
          h("div", { class: "field field-wide" },
            h("label", { class: "field-label", for: `set-${kind}-folder` }, isInv ? "Main invoice folder link" : "Folder link"), input),
          isInv ? h("label", { class: "inline-check", for: "set-inv-month" }, monthBox, " One sub-folder per month") : null,
          isInv ? h("div", { class: "field" },
            h("label", { class: "field-label", for: "set-inv-pattern" }, "Month folder name (MMM = SEP, YY = 26)"),
            patternIn, h("p", { class: "field-msg hint" }, "This month: ", example)) : null,
          isInv ? h("label", { class: "inline-check", for: "set-inv-sheet" }, sheetBox,
            " Save as a Google Sheet (named like “SUNWAY JERNIH B-38-12 INVOICE”)") : null,
          h("label", { class: "inline-check", for: `set-${kind}-sub` }, sub,
            isInv ? " Also one sub-folder per condo inside the month" : " One sub-folder per condo inside it"),
          cur.name ? h("p", { class: "small" }, "Current folder: ", h("strong", {}, cur.name)) : null,
          h("div", { class: "actions" }, testBtn,
            button("Save only", { variant: "quiet", onClick: () => save().then(() => { toast("Saved."); load(); })
              .catch(e => toast(e.message || friendlyError(e), "error")) })),
          msg,
        );
      }

      // --- Invoice numbering ---
      const lastIn = textInput({ id: "set-last", value: counter.last || "", placeholder: "BLKINV-2609033" });
      const monthly = h("input", { type: "checkbox", id: "set-monthly" }); monthly.checked = !!s.resetInvoiceMonthly;

      // --- Invoice defaults ---
      const money = (id, v) => textInput({ id, value: String(v ?? "") });
      const p1 = money("set-p1", s.payment1), p2 = money("set-p2", s.payment2), p3 = money("set-p3", s.payment3);
      const foc = textarea({ id: "set-foc", rows: 3, value: (s.focItems || []).join("\n") });

      mount(host,
        folderCard("ptaa"),
        folderCard("invoice"),
        h("p", { class: "muted small" },
          "“Test” asks Google, in a pop-up, for permission to use your Drive from this site. It is asked again ",
          "at most once an hour while you work."),
        card("Invoice numbering",
          h("p", { class: "muted small" },
            "Invoices are numbered BLKINV- + year + month + a running number, e.g. BLKINV-2609033. ",
            "Type the last number you used and the app carries on from it."),
          h("div", { class: "form-grid" },
            h("div", { class: "field" }, h("label", { class: "field-label", for: "set-last" }, "Last invoice number used"), lastIn),
            h("div", { class: "field" }, h("span", { class: "field-label" }, "Next number"), h("p", {}, h("code", {}, next || "—"))),
          ),
          h("label", { class: "inline-check", for: "set-monthly" }, monthly,
            " Start the running number again at 001 each month"),
          h("div", { class: "actions" }, button("Save numbering", { variant: "primary", onClick: async () => {
            try {
              if (lastIn.value.trim() && lastIn.value.trim().toUpperCase() !== (counter.last || "")) {
                await setLastInvoiceNo(lastIn.value.trim().toUpperCase());
              }
              await saveSettings({ resetInvoiceMonthly: monthly.checked });
              toast("Saved."); await load();
            } catch (err) { toast(err.message || friendlyError(err), "error"); }
          } })),
        ),
        card("Invoice defaults",
          h("p", { class: "muted small" }, "Filled into every new invoice; change them per invoice when needed."),
          h("div", { class: "form-grid" },
            h("div", { class: "field" }, h("label", { class: "field-label", for: "set-p1" }, "1st payment (RM)"), p1),
            h("div", { class: "field" }, h("label", { class: "field-label", for: "set-p2" }, "2nd payment (RM)"), p2),
            h("div", { class: "field" }, h("label", { class: "field-label", for: "set-p3" }, "3rd payment (RM)"), p3),
          ),
          h("div", { class: "field field-wide" },
            h("label", { class: "field-label", for: "set-foc" }, "Always shown as FOC (one item per line — matched on the first line of the item)"), foc),
          h("div", { class: "actions" }, button("Save defaults", { variant: "primary", onClick: async () => {
            const num = (el) => Number(String(el.value).replace(/[^\d.]/g, "")) || 0;
            try {
              await saveSettings({ payment1: num(p1), payment2: num(p2), payment3: num(p3),
                focItems: foc.value.split("\n").map(x => x.trim()).filter(Boolean) });
              toast("Saved."); await load();
            } catch (err) { toast(err.message || friendlyError(err), "error"); }
          } })),
        ),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}
