// ---------------------------------------------------------------------------
// screens-invoice.js — the invoice card on a PTAA (solo workflow, step 2).
//
// Pre-filled from the PTAA and the quotation: bill-to (owner, condo, unit),
// the next invoice number, today's date, every quotation item with quantity
// above zero (same item in several rooms added together, smart lock as FOC),
// and the grand total. Everything stays editable before the Excel file is made,
// and again in Excel afterwards.
// ---------------------------------------------------------------------------

import { h, mount, friendlyError } from "./core.js";
import { card, button, badge, textInput, textarea, dateInput, noticeBox, toast, confirmAction, table, choose } from "./ui.js";
import { toDateInput, parseDateInput, fmtMoney, amountsDiffer } from "./model.js";
import { buildInvoiceItems, sumOfEntries } from "./quotation.js";
import {
  generateInvoiceXlsx, fetchInvoiceTemplate, invoiceFilename, toMoney, parseInvoiceNo,
} from "./invoice.js";
import { takeInvoiceNo, peekNextInvoiceNo } from "./directory.js";
import {
  saveInvoiceData, saveInvoiceFile, loadInvoiceFile, acknowledgeCostDifference, setRenovationCost,
} from "./requests.js";

const nilOr = (n) => n === null || n === undefined || n === "" ? "NIL" : fmtMoney(n);

/**
 * When the PTAA's renovation cost and the invoice total differ, ask the admin
 * which is right: change the renovation cost to the invoice total, or keep
 * both and confirm the difference is intended. Asked once per pair of
 * amounts — a confirmed difference is not asked about again.
 * @returns "same" | "changed" | "acknowledged" | null (cancelled)
 */
export async function resolveCostDifference(req, invoiceTotal) {
  const reno = (req.financial || {}).renovationCost;
  if (!amountsDiffer(reno, invoiceTotal)) return "same";
  const ack = req.invoice && req.invoice.costAck;
  const sameReno = ack && ((ack.renovationCost ?? null) === (reno === "" || reno == null ? null : Number(reno)));
  if (ack && sameReno && Number(ack.invoiceTotal) === Number(invoiceTotal)) return "acknowledged";

  const pick = await choose({
    title: "Renovation cost and invoice total are different",
    message: h("div", {},
      h("p", {}, "Renovation cost on the PTAA: ", h("strong", {}, nilOr(reno))),
      h("p", {}, "Invoice total: ", h("strong", {}, fmtMoney(invoiceTotal))),
      h("p", { class: "muted small" }, "The agreement prints the renovation cost; the invoice prints its own total.")),
    options: [
      { key: "change", variant: "primary", label: `Change the renovation cost to ${fmtMoney(invoiceTotal)}`,
        note: "The PTAA is updated. If it is already drafted, redraft it so the agreement shows the new amount." },
      { key: "ack", label: "Keep both — I confirm they are different",
        note: "Recorded with your name, and not asked again unless either amount changes." },
    ],
  });
  if (pick === "change") {
    await setRenovationCost(req.id, invoiceTotal);
    toast(req.workingDoc ? "Renovation cost updated — redraft the PTAA so the agreement shows it." : "Renovation cost updated.");
    return "changed";
  }
  if (pick === "ack") {
    await acknowledgeCostDifference(req.id, { renovationCost: reno, invoiceTotal });
    toast("Confirmed — the difference is recorded.");
    return "acknowledged";
  }
  return null;
}
import { loadDocxLibs, downloadBlob } from "./docx.js";

export function defaultBillTo(req) {
  const owner = String(((req || {}).owner || {}).name || "").toUpperCase();
  const where = [req.propertyName, req.unitNo].filter(Boolean).join(" ").toUpperCase();
  return [owner, where].filter(Boolean).join("\n");
}

/** A fresh invoice draft for a PTAA, before anything has been saved. */
export function invoiceDraftFor(req, settings) {
  const saved = req.invoice;
  if (saved && Array.isArray(saved.items)) {
    return {
      invoiceNo: saved.invoiceNo || "",
      date: saved.date || toDateInput(new Date()),
      billTo: saved.billTo || defaultBillTo(req),
      remark: saved.remark || "",
      items: saved.items.map(i => ({ description: i.description, qty: i.qty })),
      total: saved.total ?? "",
      pay1: saved.pay1 ?? settings.payment1, pay2: saved.pay2 ?? settings.payment2, pay3: saved.pay3 ?? settings.payment3,
      pay4: saved.pay4 ?? 0,
    };
  }
  const q = req.quotation;
  return {
    invoiceNo: "",
    date: toDateInput(new Date()),
    billTo: defaultBillTo(req),
    remark: "",
    items: q ? buildInvoiceItems(q.entries, { focItems: settings.focItems })
                .map(i => ({ description: i.description, qty: i.qty }))
             : [],
    total: q && q.grandTotal ? q.grandTotal
         : ((req.financial || {}).renovationCost ?? ""),
    pay1: settings.payment1, pay2: settings.payment2, pay3: settings.payment3, pay4: 0,
  };
}

/**
 * @param {object} p  { req, settings, onSaved }  onSaved reloads the page
 */
export function invoiceCard({ req, settings, onSaved }) {
  const draft = invoiceDraftFor(req, settings);
  const file = req.invoice && req.invoice.file;
  const quote = req.quotation;
  let busy = false;

  const nextHint = h("span", { class: "muted small" });
  if (!draft.invoiceNo) {
    peekNextInvoiceNo(settings).then(n => { nextHint.textContent = `Next number: ${n}`; }).catch(() => {});
  }

  const noInput = textInput({ id: "inv-no", value: draft.invoiceNo,
    placeholder: "Taken automatically when you make the invoice",
    onInput: (e) => { draft.invoiceNo = e.target.value.trim().toUpperCase(); } });
  const dateEl = dateInput({ id: "inv-date", value: draft.date, onInput: (e) => { draft.date = e.target.value; } });
  const billEl = textarea({ id: "inv-bill", value: draft.billTo, rows: 2,
    onInput: (e) => { draft.billTo = e.target.value; } });
  const remarkEl = textInput({ id: "inv-remark", value: draft.remark, placeholder: "Optional",
    onInput: (e) => { draft.remark = e.target.value; } });

  const money = (key, id) => textInput({ id, value: draft[key] === "" ? "" : String(draft[key]),
    onInput: (e) => { draft[key] = e.target.value; renderBalance(); } });
  const totalEl = money("total", "inv-total");
  const p1 = money("pay1", "inv-p1"), p2 = money("pay2", "inv-p2"), p3 = money("pay3", "inv-p3");
  const p4 = money("pay4", "inv-p4");
  const balanceEl = h("strong", {});
  const fullNote = h("p", { class: "muted small" });
  const balanceOf = () => Math.round((toMoney(draft.total) - toMoney(draft.pay1) - toMoney(draft.pay2)
                                      - toMoney(draft.pay3) - toMoney(draft.pay4)) * 100) / 100;
  // Paid in full means no debt, so no Blank Finance: payment term 8 (the
  // Blank Finance fee) is left out of the invoice and term 9 becomes 8.
  const paidInFull = () => toMoney(draft.total) > 0 && balanceOf() <= 0;
  function renderBalance() {
    balanceEl.textContent = fmtMoney(balanceOf());
    fullNote.textContent = balanceOf() < 0
      ? `The payments add up to ${fmtMoney(-balanceOf())} more than the total — check the amounts.`
      : paidInFull()
      ? "Paid in full — no Blank Finance, so payment term 8 (the Blank Finance fee) is left out and term 9 becomes 8."
      : "A balance remains, so the Blank Finance terms (8 and 9) stay in.";
  }
  renderBalance();

  // --- items -------------------------------------------------------------
  const itemsHost = h("div", { class: "inv-items" });
  function renderItems() {
    mount(itemsHost,
      draft.items.length
        ? draft.items.map((it, i) => h("div", { class: "inv-row" },
            h("span", { class: "inv-n" }, String(i + 1)),
            (() => {
              const ta = textarea({ id: `inv-d${i}`, value: it.description,
                rows: Math.min(5, Math.max(1, String(it.description).split("\n").length)),
                onInput: (e) => { it.description = e.target.value; } });
              return ta;
            })(),
            textInput({ id: `inv-q${i}`, value: String(it.qty),
              onInput: (e) => {
                const v = e.target.value.trim();
                it.qty = /^\d+$/.test(v) ? Number(v) : v.toUpperCase();
              } }),
            h("div", { class: "row-actions" },
              button("↑", { variant: "quiet", title: "Move up", disabled: i === 0,
                onClick: () => { draft.items.splice(i - 1, 0, draft.items.splice(i, 1)[0]); renderItems(); } }),
              button("↓", { variant: "quiet", title: "Move down", disabled: i === draft.items.length - 1,
                onClick: () => { draft.items.splice(i + 1, 0, draft.items.splice(i, 1)[0]); renderItems(); } }),
              button("Remove", { variant: "quiet-danger",
                onClick: () => { draft.items.splice(i, 1); renderItems(); } }),
            ),
          ))
        : h("p", { class: "empty" },
            quote ? "No items with a quantity above zero were found in the quotation."
                  : "No items yet. Attach the quotation as a PDF and they are read in automatically, or add them here."),
      h("div", { class: "actions" },
        button("+ Add item", { variant: "quiet", onClick: () => {
          draft.items.push({ description: "", qty: 1 }); renderItems();
          const tas = itemsHost.querySelectorAll("textarea"); if (tas.length) tas[tas.length - 1].focus();
        } }),
        quote ? button("Re-read items from the quotation", { variant: "quiet", onClick: () => {
          if (draft.items.length && !confirmAction("Replace the items above with the ones read from the quotation?")) return;
          draft.items = buildInvoiceItems(quote.entries, { focItems: settings.focItems })
            .map(i => ({ description: i.description, qty: i.qty }));
          if (quote.grandTotal) { draft.total = quote.grandTotal; totalEl.value = String(quote.grandTotal); renderBalance(); }
          renderItems();
        } }) : null,
      ),
    );
  }
  renderItems();

  function cleanedItems() {
    return draft.items
      .map(i => ({ description: String(i.description || "").replace(/\r/g, "").trim(),
                   qty: i.qty === "" ? 0 : i.qty }))
      .filter(i => i.description);
  }

  async function save({ quiet = false } = {}) {
    if (draft.invoiceNo && !parseInvoiceNo(draft.invoiceNo)) {
      throw new Error("The invoice number should look like BLKINV-2609034.");
    }
    await saveInvoiceData(req.id, { ...draft, items: cleanedItems(),
      total: toMoney(draft.total), pay1: toMoney(draft.pay1), pay2: toMoney(draft.pay2), pay3: toMoney(draft.pay3),
      pay4: toMoney(draft.pay4) });
    if (!quiet) toast("Invoice details saved.");
  }

  async function make() {
    if (busy) return;
    const items = cleanedItems();
    if (!items.length) { toast("Add at least one item first.", "warn"); return; }
    if (!(toMoney(draft.total) > 0) &&
        !confirmAction("The total is RM0.00. Make the invoice anyway?")) return;
    try {
      const answer = await resolveCostDifference(req, toMoney(draft.total));
      if (!answer) return;                        // cancelled: nothing made
      if (answer === "changed") req.financial = { ...(req.financial || {}), renovationCost: toMoney(draft.total) };
    } catch (err) { toast(err.message || friendlyError(err), "error"); return; }
    if (file && file.confirmed && !confirmAction(
      "A confirmed invoice has already been uploaded for this PTAA.\n\n" +
      "Making a new draft replaces it, and you will need to upload the confirmed one again. Continue?")) return;

    busy = true; makeBtn.disabled = true; makeBtn.textContent = "Making the invoice…";
    try {
      if (!draft.invoiceNo) {
        draft.invoiceNo = await takeInvoiceNo({ resetMonthly: !!settings.resetInvoiceMonthly });
        noInput.value = draft.invoiceNo;
      } else if (!req.invoice || req.invoice.invoiceNo !== draft.invoiceNo) {
        // Typed by hand: record it so the counter carries on after it.
        await takeInvoiceNo({ typed: draft.invoiceNo });
      }
      await save({ quiet: true });

      const [{ PizZip }, template] = await Promise.all([loadDocxLibs(), fetchInvoiceTemplate()]);
      const blob = generateInvoiceXlsx(template, {
        billTo: draft.billTo, invoiceNo: draft.invoiceNo,
        date: parseDateInput(draft.date) || new Date(), remark: draft.remark,
        items, total: toMoney(draft.total),
        pay1: toMoney(draft.pay1), pay2: toMoney(draft.pay2), pay3: toMoney(draft.pay3),
        pay4: toMoney(draft.pay4), fullPayment: paidInFull(),
      }, PizZip);
      const name = invoiceFilename({ propertyName: req.propertyName, unitNo: req.unitNo });
      downloadBlob(blob, name);
      await saveInvoiceFile(req.id, { fileName: name, bytes: new Uint8Array(await blob.arrayBuffer()),
                                      source: "generated", confirmed: false });
      toast(`Invoice ${draft.invoiceNo} made and downloaded.`);
      await onSaved();
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally {
      busy = false; makeBtn.disabled = false; makeBtn.textContent = file ? "Remake the invoice" : "Make the invoice (Excel)";
    }
  }

  const makeBtn = button(file ? "Remake the invoice" : "Make the invoice (Excel)", {
    variant: file ? "default" : "primary", onClick: make });

  const quoteSummary = quote
    ? (() => {
        const sum = sumOfEntries(quote.entries);
        const gt = quote.grandTotal;
        return h("p", { class: "muted small" },
          `Read from ${quote.fileName || "the quotation"}: ${quote.entries.filter(e => e.qty > 0).length} priced lines`,
          gt ? `, grand total ${fmtMoney(gt)}` : "", ".",
          gt && Math.abs(sum - gt) > 1
            ? ` The lines add up to ${fmtMoney(sum)} — the difference is usually the Blank Finance fee or a discount, ` +
              "which the grand total already includes."
            : "");
      })()
    : null;

  return card("Invoice",
    quoteSummary,
    h("div", { class: "form-grid" },
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-no" }, "Invoice no."), noInput, nextHint),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-date" }, "Date"), dateEl),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-bill" }, "Bill to"), billEl),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-remark" }, "Remark"), remarkEl),
    ),
    h("div", { class: "inv-head" }, h("span", {}, "No."), h("span", {}, "Description — first line prints in bold"),
      h("span", {}, "Qty"), h("span", {})),
    itemsHost,
    h("div", { class: "form-grid inv-money" },
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-total" }, "Total (RM)"), totalEl),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-p1" }, "1st payment (RM)"), p1),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-p2" }, "2nd payment (RM)"), p2),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-p3" }, "3rd payment (RM)"), p3),
      h("div", { class: "field" }, h("label", { class: "field-label", for: "inv-p4" }, "4th payment (RM)"), p4,
        h("span", { class: "muted small" }, "Leave 0 for none — the row only appears when used.")),
    ),
    h("p", {}, "Balance: ", balanceEl),
    fullNote,
    file
      ? h("dl", { class: "detail-dl" },
          h("dt", {}, "Current file"), h("dd", {}, file.fileName),
          h("dt", {}, "State"), h("dd", {}, file.confirmed ? badge("Confirmed", "ok") : badge("Draft", "warn")))
      : null,
    h("div", { class: "actions" },
      makeBtn,
      button("Save details", { variant: "quiet", onClick: async () => {
        try {
          const answer = await resolveCostDifference(req, toMoney(draft.total));
          if (!answer) return;
          await save(); await onSaved();
        } catch (err) { toast(err.message || friendlyError(err), "error"); }
      } }),
      file ? button("Download", { variant: "quiet", onClick: () => downloadInvoice(req) }) : null,
    ),
  );
}

export async function downloadInvoice(req) {
  try {
    const f = await loadInvoiceFile(req.id);
    if (!f) { toast("No invoice stored yet.", "warn"); return; }
    downloadBlob(new Blob([f.bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), f.meta.fileName);
  } catch (err) { toast(err.message || friendlyError(err), "error"); }
}
