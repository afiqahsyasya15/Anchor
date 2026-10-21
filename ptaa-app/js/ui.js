// ---------------------------------------------------------------------------
// ui.js — the small set of building blocks every screen is made from.
// Kept deliberately plain: dense, scannable, colour only where it carries
// meaning (brief §1).
// ---------------------------------------------------------------------------

import { h } from "./core.js";

export function card(title, ...body) {
  return h("section", { class: "card" },
    title ? h("h2", { class: "card-title" }, title) : null,
    h("div", { class: "card-body" }, body),
  );
}

export function button(label, opts = {}) {
  const { variant = "default", onClick, disabled = false, type = "button", title } = opts;
  return h("button", {
    class: `btn btn-${variant}`, type, disabled, title,
    onClick: onClick || null,
  }, label);
}

export function badge(text, tone = "neutral") {
  return h("span", { class: `badge badge-${tone}` }, text);
}

export function field({ label, hint, error, warning, input, id }) {
  return h("div", { class: `field${error ? " field-error" : ""}` },
    h("label", { class: "field-label", for: id }, label),
    input,
    error   ? h("p", { class: "field-msg err"  }, error)   : null,
    warning && !error ? h("p", { class: "field-msg warn" }, warning) : null,
    hint && !error && !warning ? h("p", { class: "field-msg hint" }, hint) : null,
  );
}

/**
 * A field whose input element is created ONCE and never replaced.
 *
 * Re-rendering a form on every keystroke destroys the focused input and throws
 * away the caret position, which makes the form unusable for real typing. So
 * validation updates only the message line and the field's error state, never
 * the input itself.
 *
 * Returns { node, input, set(kind, text), reset() } — kind is "hint" | "err" | "warn".
 */
export function liveField({ id, label, hint = "", input, wide = false }) {
  const msg = h("p", { class: "field-msg hint" }, hint);
  const node = h("div", { class: "field" + (wide ? " field-wide" : "") },
    h("label", { class: "field-label", for: id }, label),
    input,
    msg,
  );
  return {
    node, input,
    set(kind, text) {
      msg.className = "field-msg " + (kind || "hint");
      msg.textContent = text || "";
      node.classList.toggle("field-error", kind === "err");
    },
    reset() { this.set("hint", hint); },
  };
}

export function textInput({ id, value = "", placeholder = "", onInput, autocomplete = "off", maxlength }) {
  return h("input", {
    class: "input", type: "text", id, name: id, placeholder, autocomplete,
    maxlength: maxlength || null,
    value,
    onInput: onInput || null,
  });
}

export function textarea({ id, value = "", placeholder = "", rows = 3, onInput, maxlength }) {
  return h("textarea", {
    class: "input textarea", id, name: id, placeholder, rows,
    maxlength: maxlength || null,
    onInput: onInput || null,
  }, value);
}

export function dateInput({ id, value = "", onInput, min, max }) {
  return h("input", {
    class: "input", type: "date", id, name: id, value,
    min: min || null, max: max || null,
    onInput: onInput || null,
  });
}

export function select({ id, value, options, onChange, disabled = false }) {
  const node = h("select", { class: "input select", id, name: id, disabled, onChange: onChange || null });
  for (const o of options) {
    const opt = h("option", { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    node.append(opt);
  }
  return node;
}

export function table(headers, rows, emptyMessage = "Nothing to show.") {
  if (!rows.length) return h("p", { class: "empty" }, emptyMessage);
  return h("div", { class: "table-wrap" },
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, headers.map(x => h("th", {}, x)))),
      h("tbody", {}, rows.map(cells =>
        h("tr", {}, cells.map(c => h("td", {}, c instanceof Node ? c : String(c ?? "—"))))
      )),
    ),
  );
}

export function stat(label, value, tone = "neutral") {
  return h("div", { class: `stat stat-${tone}` },
    h("div", { class: "stat-value" }, String(value)),
    h("div", { class: "stat-label" }, label),
  );
}

export function loading(text = "Loading…") {
  return h("div", { class: "loading" }, h("span", { class: "spinner spinner-sm" }), text);
}

export function errorBox(message, retry) {
  return h("div", { class: "notice notice-error" },
    h("p", {}, message),
    retry ? button("Retry", { variant: "quiet", onClick: retry }) : null,
  );
}

export function noticeBox(kind, ...body) {
  return h("div", { class: `notice notice-${kind}` }, body);
}

// --- Transient messages -----------------------------------------------------

let toastHost = null;
export function toast(message, kind = "ok") {
  if (!toastHost) {
    toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: `toast toast-${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), 5200);
}

// --- Confirmation -----------------------------------------------------------
// Uses window.confirm deliberately: one dependency-free, unmissable modal for
// the small number of destructive actions in phase 1.
export function confirmAction(message) {
  return window.confirm(message);
}

export function copyButton(text, label = "Copy") {
  return button(label, {
    variant: "quiet",
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied: " + text);
      } catch {
        toast("Could not copy automatically — select the text and copy it manually.", "warn");
      }
    },
  });
}

/**
 * A small dialog with several named choices — for questions that are not a
 * plain yes/no. Resolves to the chosen option's key, or null when closed.
 *   choose({ title, message, options: [{ key, label, variant, note }] })
 */
export function choose({ title, message, options }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (key) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
      resolve(key);
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const buttons = options.map(o => h("div", { class: "choice" },
      button(o.label, { variant: o.variant || "default", onClick: () => close(o.key) }),
      o.note ? h("p", { class: "muted small" }, o.note) : null));
    const box = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("h3", { class: "modal-title" }, title),
      typeof message === "string" ? h("p", {}, message) : message,
      h("div", { class: "modal-choices" }, buttons),
      h("div", { class: "actions" }, button("Cancel", { variant: "quiet", onClick: () => close(null) })));
    const backdrop = h("div", { class: "modal-backdrop",
      onClick: (e) => { if (e.target === backdrop) close(null); } }, box);
    document.body.append(backdrop);
    document.addEventListener("keydown", onKey);
    const first = box.querySelector("button");
    if (first) first.focus({ preventScroll: true });
  });
}
