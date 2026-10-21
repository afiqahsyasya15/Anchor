// ---------------------------------------------------------------------------
// screens-agent.js — what a Sales Agent sees in the solo workflow: their
// drafts, the PTAAs they submitted, and the finished PDF of each.
// ---------------------------------------------------------------------------

import { h, mount, fmtDate, fmtLogTime, friendlyError } from "./core.js";
import { card, button, badge, table, loading, errorBox, toast, confirmAction } from "./ui.js";
import { agentStage, AGENT_STAGES } from "./model.js";
import { listRequests, loadFinalPdf } from "./requests.js";
import { listMyDrafts, deleteDraft } from "./drafts.js";
import { downloadBlob } from "./docx.js";

export async function downloadFinalPdf(r) {
  try {
    toast("Downloading…");
    const fp = await loadFinalPdf(r.id);
    if (!fp) { toast("The PDF is not ready yet.", "warn"); return; }
    downloadBlob(new Blob([fp.bytes], { type: "application/pdf" }), fp.meta.fileName || `${r.ptaaId}.pdf`);
  } catch (err) { toast(err.message || friendlyError(err), "error"); }
}

export function agentHome(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  const open = (r) => h("a", { class: "req-link", href: "#/request:" + r.id,
    onClick: (e) => { e.preventDefault(); navigate("request:" + r.id); } }, r.ptaaId || r.id);

  function draftsCard(drafts) {
    if (!drafts.length) return null;
    return card(`Drafts (${drafts.length})`,
      h("p", { class: "muted small" }, "Saved but not submitted — the admin does not see these yet."),
      table(["Draft", "Last saved", ""], drafts.map(d => [
        h("a", { class: "req-link", href: "#/new-request:" + d.id,
          onClick: (e) => { e.preventDefault(); navigate("new-request:" + d.id); } }, d.title || "Untitled draft"),
        fmtLogTime(d.updatedAt),
        h("div", { class: "row-actions" },
          button("Continue", { variant: "quiet", onClick: () => navigate("new-request:" + d.id) }),
          button("Delete", { variant: "quiet-danger", onClick: async () => {
            if (!confirmAction(`Delete the draft “${d.title || "Untitled draft"}”? This cannot be undone.`)) return;
            try { await deleteDraft(d.id); toast("Draft deleted."); load(); }
            catch (err) { toast(friendlyError(err), "error"); }
          } })),
      ])));
  }

  function rows(list) {
    return list.map(r => {
      const st = agentStage(r);
      return [
        open(r),
        (r.owner || {}).name || "—",
        `${r.propertyName || "—"} ${r.unitNo || ""}`,
        badge(st.label, st.tone),
        fmtDate(r.updatedAt),
        st === AGENT_STAGES.READY
          ? button("Download PDF", { variant: "primary", onClick: () => downloadFinalPdf(r) })
          : h("span", { class: "muted small" }, "—"),
      ];
    });
  }

  async function load() {
    mount(root,
      h("div", { class: "detail-head" },
        h("h1", { class: "screen-title" }, "My PTAAs"),
        h("div", { class: "actions" }, button("+ New PTAA", { variant: "primary", onClick: () => navigate("new-request") }))),
      h("p", { class: "screen-sub" },
        "Submit a PTAA with the owner's details, I/C and the quotation. The admin prepares the agreement ",
        "and sends you the finished PDF to download here."),
      host);
    mount(host, loading());
    try {
      const [drafts, mine] = await Promise.all([
        listMyDrafts().catch(() => []),
        listRequests({ mine: true }),
      ]);
      const ready = mine.filter(r => agentStage(r) === AGENT_STAGES.READY);
      const active = mine.filter(r => ![AGENT_STAGES.READY, AGENT_STAGES.CANCELLED].includes(agentStage(r)));
      const cancelled = mine.filter(r => agentStage(r) === AGENT_STAGES.CANCELLED);
      const headers = ["PTAA", "Owner", "Condo / unit", "Status", "Updated", ""];
      mount(host,
        draftsCard(drafts),
        card(`With the admin (${active.length})`,
          table(headers, rows(active), mine.length ? "Nothing waiting." : "Nothing submitted yet — start with “New PTAA”.")),
        card(`Ready to download (${ready.length})`,
          table(headers, rows(ready), "No finished PDFs yet.")),
        cancelled.length ? card(`Cancelled (${cancelled.length})`, table(headers, rows(cancelled))) : null,
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }
  load();
  return root;
}
