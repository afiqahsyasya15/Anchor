// ---------------------------------------------------------------------------
// screens.js — sign-in, refusal, agent profile, user administration, the
// account-wide activity log, and the dashboard shells.
//
// The request screens live in screens-request.js; the queue, property registry
// and dashboards in screens-queue.js.
// ---------------------------------------------------------------------------

import {
  h, mount, db, company,
  doc, getDoc, setDoc, updateDoc, collection, getDocs, addDoc,
  query, orderBy, limit, serverTimestamp,
  emailKey, isValidEmail, fmtLogTime, fmtDate,
  PROFILE_FIELDS, missingProfileFields, isProfileComplete,
  validateNric, validatePhone, validateFullName, validateNickname,
  logActivity, friendlyError,
} from "./core.js";

import { adminDashboard, agentDashboard } from "./screens-queue.js";
import { mySignatureCard } from "./screens-signatures.js";

import {
  session, PHASE, signIn, signOutNow, dismissDenial, isAdmin,
  refreshRecord, profileComplete,
} from "./auth.js";

import {
  card, button, badge, field, liveField, textInput, select, table, stat,
  loading, errorBox, noticeBox, toast, confirmAction, copyButton,
} from "./ui.js";

// ===========================================================================
// Setup screen — shown when config.js still has the placeholder values.
// ===========================================================================

export function setupScreen() {
  return h("div", { class: "centred" },
    card("Configuration needed",
      h("p", {},
        "This app has not been connected to a Firebase project yet. Open ",
        h("code", {}, "config.js"),
        " and replace the ", h("code", {}, "PASTE_…"), " placeholders with the values from ",
        "Firebase console → Project settings → Your apps → Web app.",
      ),
      h("p", { class: "muted" }, "README.md walks through the whole setup, start to finish, in nine steps."),
    ),
  );
}

// ===========================================================================
// Sign in
// ===========================================================================

export function signInScreen() {
  const status = h("div", { class: "signin-status" });

  const go = async () => {
    mount(status, loading("Opening Google sign-in…"));
    try {
      await signIn();
    } catch (err) {
      mount(status, errorBox(friendlyError(err)));
    }
  };

  return h("div", { class: "centred" },
    h("div", { class: "signin" },
      company.logoUrl
        ? h("img", { class: "signin-logo", src: company.logoUrl, alt: company.name })
        : h("div", { class: "signin-wordmark" }, company.name),
      h("h1", { class: "signin-title" }, company.systemName),
      h("p", { class: "signin-sub" },
        "Internal use only. Sign in with the Google account your administrator has approved."),
      button("Sign in with Google", { variant: "primary", onClick: go }),
      status,
      h("p", { class: "signin-foot" },
        "This sign-in reads your name and email address only. It does not request access to your Google Drive, Gmail or files."),
    ),
  );
}

// ===========================================================================
// Refused
// ===========================================================================

export function deniedScreen() {
  const d = session.denied || {};
  const email = d.email || "(unknown)";

  const bodies = {
    "not-listed": [
      h("p", {}, "This account is not on the approved list."),
      h("div", { class: "denied-email" },
        h("span", { class: "muted small" }, "Signed in to Google as"),
        h("code", {}, email),
        copyButton(email, "Copy address"),
      ),
      h("p", {}, "Send that address to your administrator exactly as shown above and ask them to add it."),
      h("p", { class: "muted small" },
        "If you have more than one Google account, you may have signed in with the wrong one — ",
        "use “Try another account” below."),
    ],
    "deactivated": [
      h("p", {}, "Your access to this system has been switched off."),
      h("div", { class: "denied-email" }, h("code", {}, email)),
      h("p", {}, "Contact your administrator if this is unexpected."),
    ],
    "bad-role": [
      h("p", {}, "Your account is on the approved list but its role is not set correctly, so the system does not know what you are allowed to do."),
      h("pre", { class: "detail" }, d.detail || ""),
      h("p", {}, "An administrator needs to fix this in the Firebase console."),
    ],
    "rules": [
      h("p", {}, "The database refused to answer, so your access could not be checked."),
      h("p", {}, "This is a setup problem rather than an account problem. The security rules in the Firebase console are not the ones in ", h("code", {}, "firestore.rules"), "."),
      h("p", { class: "muted small" },
        "Firebase console → Firestore Database → Rules → paste the contents of firestore.rules → Publish. ",
        "That is step 4 in README.md."),
      h("div", { class: "denied-email" }, h("code", {}, email)),
    ],
    "no-email": [
      h("p", {}, "That Google account did not return an email address, so it cannot be matched against the approved list."),
    ],
    "error": [
      h("p", {}, "Something went wrong while checking your access."),
      h("pre", { class: "detail" }, d.detail || ""),
    ],
  };

  return h("div", { class: "centred" },
    h("div", { class: "denied" },
      h("div", { class: "denied-mark" }, "Access refused"),
      ...(bodies[d.reason] || bodies.error),
      h("div", { class: "denied-actions" },
        button("Try another account", { variant: "primary", onClick: () => dismissDenial() }),
      ),
      company.supportContact
        ? h("p", { class: "signin-foot" }, "Administrator: ", h("code", {}, company.supportContact))
        : null,
    ),
  );
}

// ===========================================================================
// Agent profile (brief §6)
// ===========================================================================

/**
 * @param {object} opts
 *  - forced:      true when the agent cannot proceed without completing it
 *  - targetEmail: an admin editing someone else's profile (optional)
 *  - onDone:      callback after a successful save
 */
export function profileScreen(opts = {}) {
  const { forced = false, targetEmail = null, onDone = null } = opts;
  const editingOther = !!targetEmail && targetEmail !== session.email;
  const email = targetEmail || session.email;

  const root = h("div", { class: "screen" });
  const formHost = h("div", {});

  const draft = { fullName: "", nric: "", phone: "", nickname: "" };
  const results = {};
  let baseRecord = null;
  let saving = false;

  const HINTS = {
    fullName: "As it should appear in the agreement, e.g. CHAN SIEW SIN",
    nric:     "12 digits, e.g. 000908-14-0426",
    phone:    "Malaysian mobile, e.g. 019-400 9082",
    nickname: "The short name used in the contact list, e.g. Suzanne",
  };

  // Built once. refresh() updates messages and the preview — never the inputs,
  // because replacing a focused input mid-typing loses the caret.
  const fields = {};
  const pv = {};
  let saveBtn = null, bannerHost = null, errorHost = null;

  function validateAll() {
    for (const f of PROFILE_FIELDS) results[f.key] = f.validate(draft[f.key]);
    return PROFILE_FIELDS.every(f => results[f.key].ok);
  }

  function refresh() {
    const allOk = validateAll();

    for (const f of PROFILE_FIELDS) {
      const r = results[f.key];
      const touched = String(draft[f.key] || "").trim().length > 0;
      if (!touched) fields[f.key].reset();
      else if (!r.ok) fields[f.key].set("err", r.error);
      else if (r.warning) fields[f.key].set("warn", r.warning);
      else fields[f.key].set("hint", HINTS[f.key]);
    }

    pv.fullName.textContent = results.fullName.ok ? results.fullName.value : "—";
    pv.nric.textContent     = results.nric.ok     ? results.nric.value     : "—";
    pv.phone.textContent    = results.phone.ok    ? results.phone.value    : "—";
    pv.phone2.textContent   = results.phone.ok    ? results.phone.value    : "—";
    pv.nickname.textContent = results.nickname.ok ? results.nickname.value : "—";

    saveBtn.disabled = saving || !allOk;
    saveBtn.textContent = saving ? "Saving…" : "Save profile";

    if (forced) {
      mount(bannerHost, allOk
        ? noticeBox("info",
            h("p", {}, "All four fields are filled in. Click ", h("strong", {}, "Save profile"), " to continue."))
        : noticeBox("warn",
            h("p", {}, "Your Sales Agent profile is incomplete."),
            h("p", { class: "small" },
              "Still needed: ",
              PROFILE_FIELDS.filter(f => !results[f.key].ok).map(f => f.label).join(", "),
              ". You cannot submit a PTAA request until all four are correct.")));
    }
  }

  function buildForm() {
    for (const f of PROFILE_FIELDS) {
      fields[f.key] = liveField({
        id: "pf-" + f.key,
        label: f.label,
        hint: HINTS[f.key],
        input: textInput({
          id: "pf-" + f.key,
          value: draft[f.key],
          onInput: (e) => { draft[f.key] = e.target.value; refresh(); },
        }),
      });
    }

    pv.fullName = h("dd", {}, "—");
    pv.nric     = h("dd", {}, "—");
    pv.phone    = h("dd", {}, "—");
    pv.phone2   = h("span", {}, "—");
    pv.nickname = h("span", {}, "—");

    const preview = h("div", { class: "preview" },
      h("h3", {}, "How this appears in every PTAA you generate"),
      h("div", { class: "preview-block" },
        h("div", { class: "preview-label" }, "Witnessed by"),
        h("dl", { class: "preview-dl" },
          h("dt", {}, "Full Name:"), pv.fullName,
          h("dt", {}, "NRIC:"),      pv.nric,
          h("dt", {}, "Mobile:"),    pv.phone,
        ),
      ),
      h("div", { class: "preview-block" },
        h("div", { class: "preview-label" }, "Tenancy Administrator contact"),
        h("p", { class: "preview-line" }, "(2) ", pv.nickname, " (Sales Agent) - ", pv.phone2),
      ),
      h("p", { class: "muted small" },
        "You never type these into a PTAA. They are filled in automatically from this profile."),
    );

    const save = async () => {
      if (saving || !validateAll()) return;
      saving = true; mount(errorHost); refresh();
      try {
        const prevVersion = Number((baseRecord && baseRecord.profile && baseRecord.profile.version) || 0);
        const version = prevVersion + 1;
        const profile = {
          fullName: results.fullName.value,
          nric:     results.nric.value,
          phone:    results.phone.value,
          nickname: results.nickname.value,
          version,
          updatedAt: serverTimestamp(),
          updatedBy: session.email,
        };

        await updateDoc(doc(db, "users", email), { profile, profileComplete: true });

        // Immutable snapshot. Brief §6 / rule #4: a profile edit must never
        // alter a PTAA that was already prepared, so every version is kept and
        // each PTAA will record the version it used.
        await setDoc(doc(db, "users", email, "profileVersions", String(version)), {
          ...profile, savedAt: serverTimestamp(), savedBy: session.email,
        });

        await logActivity({
          action: prevVersion === 0 ? "profile.created" : "profile.updated",
          summary: editingOther
            ? `Admin updated the Sales Agent profile for ${email} (version ${version}).`
            : `${prevVersion === 0 ? "Completed" : "Updated"} Sales Agent profile (version ${version}).`,
          targetType: "user", targetId: email,
          detail: { version, editedByAdmin: editingOther },
        });

        toast("Profile saved.");
        if (!editingOther) await refreshRecord();
        if (onDone) onDone();
      } catch (err) {
        const msg = friendlyError(err);
        mount(errorHost, errorBox(msg));
        toast(msg, "error");
      } finally {
        saving = false; refresh();
      }
    };

    saveBtn    = button("Save profile", { variant: "primary", onClick: save });
    bannerHost = h("div", {});
    errorHost  = h("div", {});

    mount(formHost,
      h("div", { class: "profile-grid" },
        h("div", {},
          editingOther
            ? noticeBox("warn",
                h("p", {}, "You are editing the profile of ", h("code", {}, email), ", not your own. ",
                  "This change is recorded in the activity log."))
            : null,
          bannerHost,
          ...PROFILE_FIELDS.map(f => fields[f.key].node),
          errorHost,
          h("div", { class: "actions" },
            saveBtn,
            !forced && !editingOther ? button("Reset", { variant: "quiet", onClick: () => load() }) : null,
          ),
          baseRecord && baseRecord.profile && baseRecord.profile.version
            ? h("p", { class: "muted small" },
                `Version ${baseRecord.profile.version}, last saved ${fmtLogTime(baseRecord.profile.updatedAt)}. `,
                "Earlier versions are kept so that PTAAs already prepared are never changed by an edit here.")
            : null,
        ),
        preview,
      ),
      // Held back while the profile is still being forced — one thing at a time.
      forced ? null : mySignatureCard(email, baseRecord && baseRecord.profile),
    );
    refresh();
  }

  async function load() {
    mount(root, h("h1", { class: "screen-title" }, editingOther ? "Edit Sales Agent profile" : "My profile"), formHost);
    mount(formHost, loading());
    try {
      const snap = await getDoc(doc(db, "users", email));
      baseRecord = snap.exists() ? snap.data() : {};
      const p = baseRecord.profile || {};
      draft.fullName = p.fullName || "";
      draft.nric     = p.nric     || "";
      draft.phone    = p.phone    || "";
      draft.nickname = p.nickname || "";
      buildForm();
    } catch (err) {
      mount(formHost, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Admin — users
// ===========================================================================

export function usersScreen(navigate) {
  const root = h("div", { class: "screen" });
  const listHost = h("div", {});
  let users = [];

  const newUser = { email: "", role: "agent" };

  function activeAdminCount() {
    return users.filter(u => u.role === "admin" && u.active === true).length;
  }

  async function addUser() {
    const addr = emailKey(newUser.email);
    if (!isValidEmail(addr)) { toast("That does not look like an email address.", "error"); return; }
    if (users.some(u => u.id === addr)) { toast("That address is already on the list.", "warn"); return; }
    try {
      await setDoc(doc(db, "users", addr), {
        email: addr,
        role: newUser.role,
        active: true,
        invitedBy: session.email,
        invitedAt: serverTimestamp(),
      });
      await logActivity({
        action: "user.invited",
        summary: `Added ${addr} to the approved list as ${newUser.role}.`,
        targetType: "user", targetId: addr, detail: { role: newUser.role },
      });
      toast(`${addr} added.`);
      newUser.email = "";
      await load();
    } catch (err) { toast(friendlyError(err), "error"); }
  }

  async function setRole(u, role) {
    if (u.id === session.email) { toast("You cannot change your own role.", "warn"); return; }
    if (u.role === "admin" && role === "agent" && activeAdminCount() <= 1) {
      toast("This is the only active administrator. Promote someone else first.", "error"); return;
    }
    if (!confirmAction(`Change ${u.id} from ${u.role} to ${role}?`)) return;
    try {
      await updateDoc(doc(db, "users", u.id), { role });
      await logActivity({
        action: "user.role_changed",
        summary: `Changed the role of ${u.id} from ${u.role} to ${role}.`,
        targetType: "user", targetId: u.id, detail: { from: u.role, to: role },
      });
      toast("Role updated."); await load();
    } catch (err) { toast(friendlyError(err), "error"); }
  }

  async function setActive(u, active) {
    if (u.id === session.email) { toast("You cannot switch off your own access.", "warn"); return; }
    if (!active && u.role === "admin" && activeAdminCount() <= 1) {
      toast("This is the only active administrator. Promote someone else first.", "error"); return;
    }
    const verb = active ? "Reactivate" : "Switch off access for";
    if (!confirmAction(`${verb} ${u.id}?`)) return;
    try {
      await updateDoc(doc(db, "users", u.id), { active });
      await logActivity({
        action: active ? "user.reactivated" : "user.deactivated",
        summary: `${active ? "Reactivated" : "Switched off"} access for ${u.id}.`,
        targetType: "user", targetId: u.id,
      });
      toast(active ? "Access restored." : "Access switched off."); await load();
    } catch (err) { toast(friendlyError(err), "error"); }
  }

  function renderList() {
    const rows = users.map(u => {
      const complete = isProfileComplete(u.profile);
      const neverIn  = !u.firstLoginAt;
      return [
        h("div", {},
          h("code", { class: "email" }, u.id),
          u.id === session.email ? badge("you", "info") : null,
        ),
        (u.profile && u.profile.fullName) || u.googleDisplayName || h("span", { class: "muted" }, "—"),
        badge(u.role === "admin" ? "Admin" : "Sales Agent", u.role === "admin" ? "info" : "neutral"),
        u.active === true ? badge("Active", "ok") : badge("Off", "off"),
        u.role === "agent"
          ? (complete ? badge("Complete", "ok") : badge("Incomplete", "warn"))
          : (complete ? badge("Complete", "ok") : h("span", { class: "muted" }, "—")),
        neverIn ? h("span", { class: "muted" }, "never") : fmtDate(u.lastLoginAt),
        h("div", { class: "row-actions" },
          button(u.role === "admin" ? "Make agent" : "Make admin", {
            variant: "quiet", disabled: u.id === session.email,
            onClick: () => setRole(u, u.role === "admin" ? "agent" : "admin"),
          }),
          button(u.active === true ? "Switch off" : "Reactivate", {
            variant: u.active === true ? "quiet-danger" : "quiet",
            disabled: u.id === session.email,
            onClick: () => setActive(u, u.active !== true),
          }),
          button("Profile", {
            variant: "quiet",
            onClick: () => navigate("profile-of:" + u.id),
          }),
        ),
      ];
    });

    mount(listHost,
      card("Add an approved account",
        h("p", { class: "muted small" },
          "Enter the Google address exactly as Google reports it. Gmail treats ",
          h("code", {}, "a.b@gmail.com"), " and ", h("code", {}, "ab@gmail.com"),
          " as the same account but this list does not — if someone is refused, ",
          "the refusal screen shows them the exact address to send you."),
        h("div", { class: "add-user" },
          textInput({
            id: "new-email", value: newUser.email, placeholder: "name@gmail.com",
            onInput: (e) => { newUser.email = e.target.value; },
          }),
          select({
            id: "new-role", value: newUser.role,
            options: [{ value: "agent", label: "Sales Agent" }, { value: "admin", label: "Admin" }],
            onChange: (e) => { newUser.role = e.target.value; },
          }),
          button("Add", { variant: "primary", onClick: addUser }),
        ),
      ),
      card(`Approved accounts (${users.length})`,
        table(
          ["Email", "Name", "Role", "Access", "Profile", "Last sign-in", ""],
          rows,
          "No accounts yet.",
        ),
      ),
    );
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Users"),
      h("p", { class: "screen-sub" },
        "Access is controlled by this list. An address that is not here is refused at sign-in ",
        "and can read nothing, even by calling the database directly."),
      listHost);
    mount(listHost, loading());
    try {
      const snap = await getDocs(query(collection(db, "users"), orderBy("email")));
      users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderList();
    } catch (err) {
      // orderBy('email') fails on documents created without an email field
      // (e.g. the first admin, bootstrapped by hand). Fall back to an
      // unordered read so the screen still works.
      try {
        const snap = await getDocs(collection(db, "users"));
        users = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                         .sort((a, b) => a.id.localeCompare(b.id));
        renderList();
      } catch (err2) {
        mount(listHost, errorBox(friendlyError(err2), load));
      }
    }
  }

  load();
  return root;
}

// ===========================================================================
// Admin — activity log (brief §14.1)
// ===========================================================================

export function activityScreen() {
  const root = h("div", { class: "screen" });
  const host = h("div", {});

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Activity log"),
      h("p", { class: "screen-sub" },
        "Append-only. Nothing here can be edited or deleted from this application ",
        "by any user, administrator included."),
      host);
    mount(host, loading());
    try {
      const snap = await getDocs(query(collection(db, "activity"), orderBy("at", "desc"), limit(200)));
      const entries = snap.docs.map(d => d.data());
      if (!entries.length) { mount(host, card(null, h("p", { class: "empty" }, "No activity recorded yet."))); return; }
      mount(host, card(null,
        h("ol", { class: "log" },
          entries.map(e => h("li", { class: "log-row" },
            h("span", { class: "log-time" }, fmtLogTime(e.at)),
            h("span", { class: "log-actor" }, e.actorEmail || "—"),
            h("span", { class: "log-text" }, e.summary || e.action || ""),
          )),
        ),
        h("p", { class: "muted small" }, `Showing the most recent ${entries.length} entries.`),
      ));
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

// ===========================================================================
// Dashboards
// ===========================================================================

const PHASE_STATUS = [
  ["1",  "Google sign-in, approved list, roles, agent profiles", true],
  ["2",  "New PTAA Request submission", true],
  ["3",  "Admin dashboard and request queue", true],
  ["4",  "Template registry, upload, placeholder validation", true],
  ["5",  "Document generation from the .docx template", true],
  ["6",  "Status workflow (state machine)", true],
  ["7",  "In-app notifications", true],
  ["8",  "Owner change requests", true],
  ["9",  "Signature tracking", true],
  ["10", "Final checklist", true],
  ["11", "Google Drive upload and completion", true],
  ["12", "AI cross-check", "skipped"],
  ["13", "Global search and reporting", true],
];

export function buildStatusCard() {
  return card("Build status",
    h("p", { class: "muted small" },
      "Every phase in the build order is live except the AI cross-check, which was ",
      "dropped on purpose — this shows the real state rather than placeholder data."),
    h("ul", { class: "phases" },
      PHASE_STATUS.map(([n, label, done]) => h("li", { class: done === true ? "phase done" : "phase" },
        h("span", { class: "phase-n" }, n),
        h("span", { class: "phase-label" }, label),
        done === true ? badge("Live", "ok")
          : done === "skipped" ? badge("Skipped", "neutral")
          : badge("Not built", "off"),
      )),
    ),
    h("p", { class: "muted small" },
      "Phase 12 would send every request and its document to a language model on each ",
      "check, which is a daily running cost for advisory flagging the admin already does ",
      "by eye during the final checklist. It can be added later if that trade changes."),
  );
}

/** Accounts-side warnings, shown under the admin's request buckets. */
export function accountsAttentionCard(navigate) {
  const host = h("div", {});
  const node = card("Accounts", host);
  (async () => {
    mount(host, loading());
    try {
      const snap = await getDocs(collection(db, "users"));
      const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const active = users.filter(u => u.active === true);
      const agents = active.filter(u => u.role === "agent");
      const incomplete = agents.filter(u => !isProfileComplete(u.profile));
      const neverIn = active.filter(u => !u.firstLoginAt);

      const items = [];
      if (incomplete.length) items.push(h("li", {},
        `${incomplete.length} agent${incomplete.length > 1 ? "s have" : " has"} an incomplete profile `,
        `(${incomplete.map(u => u.id).join(", ")}) — they cannot submit a PTAA request until it is filled in.`));
      if (neverIn.length) items.push(h("li", {},
        `${neverIn.length} approved account${neverIn.length > 1 ? "s have" : " has"} never signed in `,
        `(${neverIn.map(u => u.id).join(", ")}).`));

      mount(host,
        h("p", { class: "muted small" },
          `${active.length} active account${active.length === 1 ? "" : "s"}: `,
          `${agents.length} Sales Agent${agents.length === 1 ? "" : "s"}, `,
          `${active.length - agents.length} admin${active.length - agents.length === 1 ? "" : "s"}.`),
        items.length
          ? h("ul", { class: "bullets" }, items)
          : h("p", { class: "empty" }, "Nothing outstanding on the accounts side."),
        h("div", { class: "actions" },
          button("Manage users", { variant: "quiet", onClick: () => navigate("users") })),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err)));
    }
  })();
  return node;
}

/** The agent's own profile status, shown on their dashboard. */
export function profileCard(navigate) {
  const done = profileComplete();
  const missing = missingProfileFields(session.record && session.record.profile);
  const p = (session.record && session.record.profile) || {};
  return card("Your Sales Agent profile",
    done
      ? h("div", {},
          h("p", {}, badge("Complete", "ok"), " Your details are filled into every PTAA you request."),
          h("dl", { class: "preview-dl" },
            h("dt", {}, "Full Name:"), h("dd", {}, p.fullName),
            h("dt", {}, "NRIC:"),      h("dd", {}, p.nric),
            h("dt", {}, "Mobile:"),    h("dd", {}, p.phone),
            h("dt", {}, "Nickname:"),  h("dd", {}, p.nickname),
          ),
        )
      : h("div", {},
          h("p", {}, badge("Incomplete", "warn"), " Missing: ", missing.join(", ")),
          h("p", {}, "You cannot submit a PTAA request until this is filled in."),
        ),
    h("div", { class: "actions" },
      button(done ? "Edit profile" : "Complete profile", {
        variant: done ? "default" : "primary", onClick: () => navigate("profile"),
      }),
    ),
  );
}

export function dashboardScreen(navigate) {
  return isAdmin()
    ? adminDashboard(navigate, [() => accountsAttentionCard(navigate), buildStatusCard])
    : agentDashboard(navigate, [() => profileCard(navigate), buildStatusCard]);
}


// ===========================================================================
// Not built yet — used by the greyed-out nav entries
// ===========================================================================

export function notBuiltScreen(title, phaseNote) {
  return h("div", { class: "screen" },
    h("h1", { class: "screen-title" }, title),
    card(null,
      h("p", {}, "This is not built yet."),
      h("p", { class: "muted" }, phaseNote),
      h("p", { class: "muted small" },
        "It is shown here so the shape of the finished system is visible. ",
        "Nothing on this screen is simulated."),
    ),
  );
}
