// ---------------------------------------------------------------------------
// screens-templates.js — the one PTAA Word template, used for every condo.
//
// A template is accepted only if every placeholder in §5.2 is present. When one
// is missing the upload is refused and the message names exactly which — that
// single check is what stops most silent document-generation failures.
// ---------------------------------------------------------------------------

import { h, mount, fmtLogTime, friendlyError } from "./core.js";
import { session } from "./auth.js";
import {
  card, button, badge, table, loading, errorBox, noticeBox, toast, confirmAction,
} from "./ui.js";
import { listProperties } from "./requests.js";
import {
  listTemplates, getTemplateMeta, saveTemplate, loadTemplateBytes, deleteTemplate, SHARED_TEMPLATE_ID,
} from "./templates.js";
import { inspectTemplate, downloadBlob, readFileAsArrayBuffer } from "./docx.js";
import {
  GROUPS, fieldsByGroup, REQUIRED_TAGS, LOOP_TAG, describeFailure,
} from "./placeholders.js";

function fmtKB(n) { return (Number(n || 0) / 1024).toFixed(0) + " KB"; }

// ---------------------------------------------------------------------------

const SHARED = { id: SHARED_TEMPLATE_ID, name: "All condos" };

/**
 * The template card — upload, check, replace, download. Used on its own page
 * and inside Settings.
 */
export function templateCard() {
  const box = h("div", {});
  const host = h("div", {});
  const reportHost = h("div", {});
  let pending = null;     // { file, buffer, result, bytes }
  let meta = null, legacy = [];

  async function inspect(file) {
    mount(reportHost, loading("Reading the template…"));
    try {
      const { result, bytes } = await inspectTemplate(file);
      const buffer = await readFileAsArrayBuffer(file);
      pending = { file, buffer, result, bytes };
      renderReport();
    } catch (err) {
      pending = null;
      mount(reportHost, errorBox(err.message || friendlyError(err)));
    }
  }

  function renderReport() {
    const { result, file, bytes } = pending;
    const header = h("p", {}, h("strong", {}, file.name), " · ", fmtKB(bytes));

    if (!result.ok) {
      mount(reportHost, noticeBox("error",
        header,
        h("p", {}, h("strong", {}, "Template refused — it cannot be used yet.")),
        h("pre", { class: "detail" }, describeFailure(result)),
        h("p", { class: "small" },
          "Fix it in Word — the placeholder must be typed exactly, in one go — then upload it again. ",
          "Nothing has been saved."),
        h("div", { class: "actions" },
          button("Discard", { variant: "quiet", onClick: () => { pending = null; mount(reportHost); } })),
      ));
      return;
    }

    mount(reportHost, noticeBox("info",
      header,
      h("p", {}, "Checked: all ", h("strong", {}, String(REQUIRED_TAGS.length)), " required placeholders are present."),
      result.unknown.length
        ? h("p", { class: "small" }, "Placeholders the app does not fill, which will be left blank: ",
            result.unknown.map(t => `{{${t}}}`).join(", "), ". Check these are not typos.")
        : null,
      saveRow(result),
    ));
  }

  function saveRow(result) {
    const progress = h("span", { class: "muted small" });
    const saveBtn = button("Use this template for every condo", { variant: "primary" });
    const discardBtn = button("Discard", { variant: "quiet", onClick: () => { pending = null; mount(reportHost); } });
    let saving = false;
    saveBtn.addEventListener("click", async () => {
      if (saving) return;
      saving = true;
      saveBtn.disabled = discardBtn.disabled = true;
      progress.textContent = "Preparing…";
      try {
        await saveTemplate(SHARED.id, {
          propertyName: SHARED.name, fileName: pending.file.name, buffer: pending.buffer,
          found: result.found, loops: result.loops,
        }, (done, total) => {
          progress.textContent = done === 0 ? `Uploading in ${total} part${total > 1 ? "s" : ""}…` : `Uploaded part ${done} of ${total}.`;
        });
        toast("Template saved — every condo now uses it.");
        pending = null;
        mount(reportHost);
        await load();
      } catch (err) {
        progress.textContent = "";
        toast(err.message || friendlyError(err), "error");
      } finally {
        saving = false;
        saveBtn.disabled = discardBtn.disabled = false;
      }
    });
    return h("div", { class: "actions" }, saveBtn, discardBtn, progress);
  }

  async function download(id, name) {
    try {
      const m = id === SHARED.id ? meta : legacy.find(t => t.id === id);
      const bytes = await loadTemplateBytes(id);
      if (!bytes) { toast("Nothing stored.", "warn"); return; }
      downloadBlob(new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }), (m && m.fileName) || `${name}.docx`);
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function removeLegacy(t) {
    if (!confirmAction(`Remove the old template for ${t.propertyName || t.id}? The shared template is used instead.`)) return;
    try { await deleteTemplate(t.id, t.propertyName); toast("Removed."); await load(); }
    catch (err) { toast(friendlyError(err), "error"); }
  }

  async function load() {
    mount(host, loading());
    try {
      const all = await listTemplates();
      meta = all.find(t => t.id === SHARED.id) || null;
      legacy = all.filter(t => t.id !== SHARED.id);
      const input = h("input", { type: "file", accept: ".docx", class: "visually-hidden",
        onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) inspect(f); } });
      mount(host,
        meta
          ? h("dl", { class: "detail-dl" },
              h("dt", {}, "Template"), h("dd", {}, badge("In use", "ok"), " ", h("code", { class: "small" }, meta.fileName)),
              h("dt", {}, "Version"), h("dd", {}, `v${meta.version || 1} · ${fmtKB(meta.bytes)}`),
              h("dt", {}, "Uploaded"), h("dd", {}, `${fmtLogTime(meta.uploadedAt)} by ${meta.uploadedBy || "—"}`))
          : noticeBox("warn", h("p", {}, h("strong", {}, "No template yet. "),
              legacy.length
                ? `Until one is uploaded, the old per-condo templates are used (${legacy.map(t => t.propertyName || t.id).join(", ")}).`
                : "No PTAA can be drafted until one is uploaded.")),
        h("div", { class: "actions" }, input,
          button(meta ? "Replace…" : "Upload the template…", { variant: meta ? "quiet" : "primary", onClick: () => input.click() }),
          meta ? button("Download", { variant: "quiet", onClick: () => download(SHARED.id, "PTAA template") }) : null),
        reportHost,
        meta && legacy.length
          ? h("div", {},
              h("p", { class: "muted small" }, "Old per-condo templates — no longer used, safe to remove:"),
              table(["Condo", "File", ""], legacy.map(t => [
                t.propertyName || t.id, h("code", { class: "small" }, t.fileName || "—"),
                h("div", { class: "row-actions" },
                  button("Download", { variant: "quiet", onClick: () => download(t.id, t.propertyName || t.id) }),
                  button("Remove", { variant: "quiet-danger", onClick: () => removeLegacy(t) })),
              ])))
          : null,
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  mount(box, card("PTAA Word template — used for every condo",
    h("p", { class: "muted small" },
      "One Word file for all condos. The condo's name and address are filled in from the Condos list — ",
      h("code", {}, "{{property_full_address}}"), " prints the unit, the condo name and its address, e.g. ",
      "“B-38-12, SUNWAY JERNIH, Jalan …”. A new condo only needs adding to the Condos list."),
    host));
  load();
  return box;
}

export function templatesScreen() {
  const root = h("div", { class: "screen" });
  mount(root,
    h("h1", { class: "screen-title" }, "PTAA template"),
    templateCard(),
    requirementsCard());
  return root;
}

function requirementsCard() {
  return card("What a template must contain",
    h("p", { class: "muted small" },
      "Fields are found by name, never by page number or by searching for sample text — ",
      "page numbers move the moment a clause changes length."),
    h("div", { class: "actions" },
      h("a", { class: "btn btn-default",
               href: new URL("../reference/PTAA-PLACEHOLDER-REFERENCE.docx", import.meta.url).href,
               download: "PTAA-PLACEHOLDER-REFERENCE.docx" },
        "Download the placeholder reference (.docx)"),
    ),
    h("p", { class: "muted small" },
      "That file is a cheat-sheet to open beside your real template in Word. It is not a PTAA."),
    h("div", { class: "placeholder-groups" },
      GROUPS.map(group => {
        const fields = fieldsByGroup(group);
        if (!fields.length) return null;
        return h("div", { class: "ph-group" },
          h("h4", {}, group),
          h("ul", {}, fields.map(f => h("li", {},
            h("code", {}, `{{${f.tag}}}`),
            f.required ? null : h("span", { class: "muted small" }, " optional"),
            f.note ? h("p", { class: "muted small" }, f.note) : null,
          ))),
        );
      }),
      h("div", { class: "ph-group" },
        h("h4", {}, "Special terms"),
        h("ul", {},
          h("li", {}, h("code", {}, `{{#${LOOP_TAG}}}`)),
          h("li", {}, h("code", {}, "{{.}}")),
          h("li", {}, h("code", {}, `{{/${LOOP_TAG}}}`)),
        ),
        h("p", { class: "muted small" },
          "Three lines, in this order. The middle one repeats once per term."),
      ),
    ),
  );
}
