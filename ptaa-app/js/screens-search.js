// ---------------------------------------------------------------------------
// screens-search.js — global search and reporting (brief §8.4, phase 13).
//
// Searching happens in the browser over the whole request list rather than as a
// Firestore query, for two reasons. Firestore cannot do substring or
// multi-field text matching at all without a separate search product, and the
// two questions the brief actually asks for — "I remember the owner but not the
// number", "I remember the condo and unit but not the owner" — are exactly the
// partial-recall queries Firestore is worst at. At this team's volume the whole
// collection is a few hundred documents, so it is fetched once and filtered
// instantly on every keystroke.
//
// Agent isolation is not weakened by this: listRequests({ mine: true }) is what
// an agent gets, and the security rules refuse a collection query from an agent
// that is not scoped to their own address. An agent searching only ever searches
// their own requests, on the server's insistence rather than this file's.
// ---------------------------------------------------------------------------

import { h, mount, fmtDate, fmtLogTime, friendlyError } from "./core.js";
import { session, isAdmin } from "./auth.js";
import {
  card, button, badge, stat, table, textInput, loading, errorBox, noticeBox,
} from "./ui.js";
import {
  STATUS_LABEL, STATUS_TONE, ACTOR, searchRequests, buildReport, isOverdue,
  parseDateInput,
} from "./model.js";
import { listRequests } from "./requests.js";

/** Where the header box parks the query, so a reload keeps the results. */
export const searchRoute = (q) => "search" + (q ? ":" + encodeURIComponent(q) : "");

// ---------------------------------------------------------------------------
// The box in the header — reachable from every screen, as §8.4 asks
// ---------------------------------------------------------------------------

export function globalSearchBox(navigate) {
  const input = textInput({
    id: "global-search",
    placeholder: "Search owner, condo, unit, PTAA number…",
  });
  input.setAttribute("type", "search");
  input.setAttribute("aria-label", "Search all PTAA requests");
  input.classList.add("search-input");

  const go = () => {
    const q = input.value.trim();
    if (q) navigate(searchRoute(q));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

  return h("form", {
    class: "search-box",
    onSubmit: (e) => { e.preventDefault(); go(); },
  }, input);
}

// ---------------------------------------------------------------------------
// The search screen
// ---------------------------------------------------------------------------

export function searchScreen(initialQuery, navigate) {
  const root = h("div", { class: "screen" });
  const resultHost = h("div", {});
  let rows = null;                 // null until loaded — the fetch happens once
  let query = initialQuery || "";

  const input = textInput({
    id: "search-q", value: query,
    placeholder: "Owner name, condo, unit, PTAA number, agent, filename…",
    onInput: (e) => { query = e.target.value; renderResults(); },
  });
  input.setAttribute("type", "search");
  input.classList.add("search-input", "search-input-lg");

  function resultRow(r) {
    return [
      h("div", {},
        button(r.ptaaId, { variant: "link", onClick: () => navigate("request:" + r.ptaaId) }),
        isOverdue(parseDateInput(r.dueDate), r.status)
          ? h("span", {}, " ", badge("Overdue", "warn")) : null),
      (r.owner || {}).name || "—",
      h("span", {}, r.propertyName || "—", " ", h("span", { class: "nowrap" }, r.unitNo || "")),
      badge(STATUS_LABEL[r.status] || r.status, STATUS_TONE[r.status] || "neutral"),
      r.currentAction === ACTOR.NONE ? h("span", { class: "muted" }, "—") : r.currentAction,
      isAdmin() ? h("span", { class: "email small" }, r.agentEmail || "—") : null,
      (r.drive && r.drive.webViewLink)
        ? h("a", { href: r.drive.webViewLink, target: "_blank", rel: "noopener" }, "Drive")
        : h("span", { class: "muted" }, "—"),
      fmtDate(r.updatedAt),
    ].filter(c => c !== null);
  }

  function renderResults() {
    if (rows === null) { mount(resultHost, loading("Loading requests…")); return; }

    const q = query.trim();
    if (!q) {
      mount(resultHost,
        card("Search",
          h("p", { class: "muted" },
            "Type any part of what you remember. Every word has to appear somewhere on the ",
            "request, so more words narrow it rather than widening it."),
          h("ul", { class: "bullets small muted" },
            h("li", {}, h("code", {}, "loy hui"), " — the owner, when the PTAA number is long forgotten"),
            h("li", {}, h("code", {}, "astra 18-09"), " — the condo and unit, when the owner is"),
            h("li", {}, h("code", {}, "00042"), " — the PTAA number itself"),
            h("li", {}, h("code", {}, "suzanne"), " — everything one agent is working on"),
          ),
          h("p", { class: "muted small" },
            `Searching ${rows.length} request${rows.length === 1 ? "" : "s"}`,
            isAdmin() ? "." : " — your own; an agent never sees another agent's work."),
        ));
      return;
    }

    const hits = searchRequests(rows, q);
    const headers = ["PTAA", "Owner", "Property", "Status", "Current action",
                     ...(isAdmin() ? ["Agent"] : []), "Drive", "Updated"];

    mount(resultHost,
      card(`${hits.length} result${hits.length === 1 ? "" : "s"} for “${q}”`,
        hits.length
          ? table(headers, hits.map(resultRow))
          : h("div", {},
              h("p", { class: "empty" }, "Nothing matches all of those words."),
              h("p", { class: "muted small" },
                "Every word has to appear somewhere on the request. Try fewer words, or check ",
                "the spelling of the condo — it must match the property list exactly."),
            ),
      ));
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Search"),
      h("p", { class: "screen-sub" },
        "Across owner, condo, unit, agent, PTAA number, status, filename and Drive link."),
      card(null, h("div", { class: "search-row" }, input)),
      resultHost);

    // The input is rebuilt by mount(), so put the caret back where it was.
    input.focus();
    input.setSelectionRange(query.length, query.length);

    renderResults();
    try {
      rows = await listRequests({ mine: !isAdmin() });
      renderResults();
    } catch (err) {
      mount(resultHost, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function reportScreen(navigate) {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  function bar(rowsIn, total) {
    return h("ul", { class: "bar-list" }, rowsIn.map(([label, n]) =>
      h("li", { class: "bar-row" },
        h("span", { class: "bar-label" }, String(label)),
        h("span", { class: "bar-track" },
          h("span", { class: "bar-fill", style: `width:${total ? (n / total) * 100 : 0}%` })),
        h("span", { class: "bar-n" }, String(n)),
      )));
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Reporting"),
      h("p", { class: "screen-sub" },
        "Where the open work is sitting, and how long finished PTAAs actually took."),
      host);
    mount(host, loading());

    try {
      const rows = await listRequests({ mine: false });
      const rep = buildReport(rows);

      mount(host,
        h("div", { class: "stats" },
          stat("Open", String(rep.open)),
          stat("With the admin", String(rep.withAdmin), rep.withAdmin ? "warn" : "neutral"),
          stat("With an agent", String(rep.withAgent)),
          stat("Completed this month", String(rep.completedThisMonth), "ok"),
        ),

        card("How long a PTAA takes",
          rep.medianDaysToComplete === null
            ? h("p", { class: "empty" }, "Nothing has been completed yet, so there is nothing to measure.")
            : h("div", {},
                h("dl", { class: "detail-dl" },
                  h("dt", {}, "Median"),  h("dd", {}, `${rep.medianDaysToComplete} days`),
                  h("dt", {}, "Fastest"), h("dd", {}, `${rep.fastest} days`),
                  h("dt", {}, "Slowest"), h("dd", {}, `${rep.slowest} days`),
                  h("dt", {}, "Completed"), h("dd", {}, `${rep.completed} in total`),
                ),
                h("p", { class: "muted small" },
                  "Measured from submission to the Drive upload — the whole round trip, ",
                  "not just the time an admin had it."),
              )),

        card("Open work by status", rep.byStatus.length
          ? bar(rep.byStatus, rep.open)
          : h("p", { class: "empty" }, "Nothing open.")),

        card("Open work by agent", rep.byAgent.length
          ? bar(rep.byAgent, rep.open)
          : h("p", { class: "empty" }, "Nothing open.")),

        card("Every request by property", rep.byProperty.length
          ? bar(rep.byProperty, rep.total)
          : h("p", { class: "empty" }, "No requests yet.")),

        rep.completedWithoutDriveLink
          ? noticeBox("error",
              h("p", {}, h("strong", {},
                `${rep.completedWithoutDriveLink} completed PTAA(s) have no Drive link.`)),
              h("p", { class: "small" },
                "This should not be possible — completing uploads first and only then sets the ",
                "status, and the database rules refuse the change without a Drive file id. ",
                "If you are seeing this, something wrote to the database outside the app."))
          : null,

        card("Totals",
          h("dl", { class: "detail-dl" },
            h("dt", {}, "All requests"), h("dd", {}, String(rep.total)),
            h("dt", {}, "Open"),        h("dd", {}, String(rep.open)),
            h("dt", {}, "Completed"),   h("dd", {}, String(rep.completed)),
            h("dt", {}, "Cancelled"),   h("dd", {}, String(rep.cancelled)),
          )),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}
