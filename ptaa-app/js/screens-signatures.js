// ---------------------------------------------------------------------------
// screens-signatures.js — uploading signature images and keeping them.
//
// Two audiences share one component:
//   • every user, on their own profile — their own signature
//   • admins, on the Signatures screen — the company ones, including the
//     Director's, plus a read-only view of everybody else's
//
// Brief §10 is unchanged by any of this. Storing an image does not sign
// anything: it is placed into a document only when an admin picks it on the
// request and confirms, and who placed which is written to the history.
// ---------------------------------------------------------------------------

import { h, mount, fmtLogTime, friendlyError } from "./core.js";
import { session, isAdmin } from "./auth.js";
import {
  card, button, badge, table, textInput,
  loading, errorBox, noticeBox, toast, confirmAction,
} from "./ui.js";
import {
  listSignatures, getSignatureMeta, saveSignature, loadSignatureBytes, deleteSignature,
  prepareSignature, sharedKey, userKey, setDirectorSignature, MAX_SIGNATURE_BYTES,
} from "./signatures.js";
import { fmtBytes } from "./images.js";

const HOW_TO =
  "A photo of a signature on white paper works, but a PNG with a transparent " +
  "background is much better — otherwise Word prints a white box over the line " +
  "it sits on. Crop it close to the signature; it is placed 2 cm tall.";

// ---------------------------------------------------------------------------
// One signature: preview, replace, remove
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 *  - key       the signature id, e.g. "user:someone@example.com"
 *  - label     what to call it when saving
 *  - title     card heading
 *  - intro     a line of explanation
 *  - canEdit   whether this viewer may upload or remove it
 *  - onChange  called after a successful save or delete
 */
export function signaturePanel({ key, label, title, intro, canEdit = true, onChange = null }) {
  const root = h("div", {});
  let meta = null, busy = false;

  const fileInput = h("input", {
    type: "file", accept: "image/png,image/*", class: "visually-hidden",
    onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) upload(f); },
  });
  // Phones offer the camera as well, so a signature can be photographed on the spot.
  const cameraInput = h("input", {
    type: "file", accept: "image/*", capture: "environment", class: "visually-hidden",
    onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) upload(f); },
  });

  async function upload(file) {
    if (busy) return;
    busy = true; render();
    try {
      const prepared = await prepareSignature(file);
      await saveSignature(key, {
        label, bytes: prepared.bytes, width: prepared.width, height: prepared.height,
        name: prepared.name, isDirector: meta ? !!meta.isDirector : false,
      });
      toast(prepared.warning
        ? "Saved, but see the note about transparency."
        : "Signature saved.");
      if (prepared.warning) toast(prepared.warning, "warn");
      if (onChange) await onChange();
      await load();
    } catch (err) {
      toast(err.message || friendlyError(err), "error");
    } finally { busy = false; render(); }
  }

  async function remove() {
    if (!confirmAction(
      `Remove the signature “${meta.label || key}”?\n\n` +
      `Documents already generated keep the image that was placed in them. ` +
      `Only future documents are affected.`)) return;
    busy = true; render();
    try {
      await deleteSignature(key, meta.label);
      toast("Removed.");
      if (onChange) await onChange();
      await load();
    } catch (err) { toast(friendlyError(err), "error"); }
    finally { busy = false; render(); }
  }

  function render() {
    const preview = meta
      ? h("div", { class: "sig-preview-shell sig-preview-large" },
          h("img", { class: "sig-preview", alt: meta.label || "Signature", src: meta.previewUrl || "" }))
      : h("p", { class: "empty" }, "No signature uploaded.");

    mount(root,
      card(title,
        intro ? h("p", { class: "muted small" }, intro) : null,
        preview,
        meta
          ? h("dl", { class: "detail-dl" },
              h("dt", {}, "File"),     h("dd", {}, meta.fileName || "—"),
              h("dt", {}, "Size"),     h("dd", {}, `${meta.width}×${meta.height} px, ${fmtBytes(meta.bytes)}`),
              h("dt", {}, "Uploaded"), h("dd", {}, `${fmtLogTime(meta.uploadedAt)} by ${meta.uploadedBy || "—"}`),
            )
          : null,
        canEdit
          ? h("div", { class: "actions" },
              fileInput, cameraInput,
              button(busy ? "Working…" : (meta ? "Replace image" : "Upload image"),
                { variant: meta ? "default" : "primary", disabled: busy, onClick: () => fileInput.click() }),
              button("Take a photo", { variant: "quiet", disabled: busy, onClick: () => cameraInput.click() }),
              meta ? button("Remove", { variant: "quiet-danger", disabled: busy, onClick: remove }) : null,
            )
          : h("p", { class: "muted small" }, "Only the owner of this signature, or an admin, can change it."),
        canEdit ? h("p", { class: "muted small" }, HOW_TO) : null,
        canEdit
          ? h("p", { class: "muted small" },
              `Up to ${fmtBytes(MAX_SIGNATURE_BYTES)}; anything larger is shrunk automatically.`)
          : null,
      ),
    );
  }

  async function load() {
    mount(root, loading());
    try {
      // Fetched by key rather than by listing, because listing the whole
      // collection is an admin-only right — see firestore.rules.
      meta = await getSignatureMeta(key);
      if (meta) {
        const bytes = await loadSignatureBytes(key).catch(() => null);
        meta.previewUrl = bytes
          ? URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
          : "";
      }
      render();
    } catch (err) {
      mount(root, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}

/** The card that goes on a person's own profile. */
export function mySignatureCard(email, profile = null) {
  const mine = email === session.email;
  const own = (session.record && session.record.profile) || {};
  // Labelled with whoever it belongs to — not with whoever is looking at it,
  // which is what an admin editing someone else's profile would otherwise get.
  const label = (profile && profile.fullName) || (mine && own.fullName) || email;
  return signaturePanel({
    key: userKey(email),
    label,
    title: mine ? "My signature" : `Signature for ${email}`,
    intro: mine
      ? "Optional. If you upload one, an admin can place it on the documents you are " +
        "named on instead of printing and signing by hand. Nothing is placed without " +
        "an admin choosing it on the request first."
      : "An admin can place this on documents this person is named on.",
    canEdit: mine || isAdmin(),
  });
}

// ---------------------------------------------------------------------------
// Admin — the whole library
// ---------------------------------------------------------------------------

export function signaturesScreen() {
  const root = h("div", { class: "screen" });
  const host = h("div", {});
  let items = [];
  const draft = { label: "" };

  async function addShared(file, label) {
    try {
      const prepared = await prepareSignature(file);
      const key = sharedKey(label);
      await saveSignature(key, {
        label: label.trim(), bytes: prepared.bytes,
        width: prepared.width, height: prepared.height, name: prepared.name,
      });
      if (prepared.warning) toast(prepared.warning, "warn");
      toast(`“${label.trim()}” saved.`);
      draft.label = "";
      await load();
    } catch (err) { toast(err.message || friendlyError(err), "error"); }
  }

  async function markDirector(item) {
    if (!confirmAction(
      `Make “${item.label || item.id}” the Director's signature?\n\n` +
      `It becomes the one offered first in the Director slot on every request. ` +
      `Any signature currently marked as the Director's loses that mark.`)) return;
    try {
      await setDirectorSignature(item.id);
      toast("Updated.");
      await load();
    } catch (err) { toast(friendlyError(err), "error"); }
  }

  async function removeOne(item) {
    if (!confirmAction(
      `Remove “${item.label || item.id}”?\n\n` +
      `Documents already generated keep the image that was placed in them.`)) return;
    try {
      await deleteSignature(item.id, item.label);
      toast("Removed.");
      await load();
    } catch (err) { toast(friendlyError(err), "error"); }
  }

  async function load() {
    mount(root,
      h("h1", { class: "screen-title" }, "Signatures"),
      h("p", { class: "screen-sub" },
        "The company signature images, and everyone's own. Storing one signs nothing: ",
        "an admin picks which images go into a document on the request itself, and that ",
        "choice is written to the request history."),
      host);
    mount(host, loading());

    try {
      items = await listSignatures();
      const shared = items.filter(s => s.kind !== "user");
      const users  = items.filter(s => s.kind === "user");

      const labelInput = textInput({
        id: "sig-label", value: draft.label, placeholder: "e.g. Director Benjamin",
        onInput: (e) => { draft.label = e.target.value; },
      });
      const sharedFile = h("input", {
        type: "file", accept: "image/png,image/*", class: "visually-hidden",
        onChange: (e) => {
          const f = e.target.files[0]; e.target.value = "";
          if (!f) return;
          if (!draft.label.trim()) { toast("Give it a name first — that is what admins pick from.", "warn"); return; }
          addShared(f, draft.label);
        },
      });

      // previews are fetched lazily so the list itself stays quick
      const withPreview = (item) => {
        const img = h("img", { class: "sig-preview", alt: "" });
        const shell = h("div", { class: "sig-preview-shell" }, img);
        loadSignatureBytes(item.id)
          .then(bytes => {
            if (bytes) img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
          })
          .catch(() => mount(shell, h("span", { class: "muted small" }, "unavailable")));
        return shell;
      };

      mount(host,
        card("Add a company signature",
          h("div", { class: "add-user" },
            labelInput,
            sharedFile,
            button("Choose image", { variant: "primary", onClick: () => sharedFile.click() }),
          ),
          h("p", { class: "muted small" },
            "Name it the way you would say it out loud — “Director Benjamin”, not a file name. ",
            HOW_TO),
        ),

        card(`Company signatures (${shared.length})`,
          shared.length
            ? table(["", "Name", "Marked as", "Uploaded", ""],
                shared.map(s => [
                  withPreview(s),
                  h("strong", {}, s.label || s.id),
                  s.isDirector ? badge("Director", "info") : h("span", { class: "muted" }, "—"),
                  h("span", { class: "small" }, fmtLogTime(s.uploadedAt), h("br"),
                    h("span", { class: "muted" }, s.uploadedBy || "")),
                  h("div", { class: "row-actions" },
                    s.isDirector ? null : button("Mark as Director's", { variant: "quiet", onClick: () => markDirector(s) }),
                    button("Remove", { variant: "quiet-danger", onClick: () => removeOne(s) }),
                  ),
                ]))
            : noticeBox("warn",
                h("p", {}, "No company signature has been uploaded yet."),
                h("p", { class: "small" },
                  "Until one is here, the Director slot on every request is empty and documents ",
                  "generate with a blank signature line — which is fine if they are signed on paper.")),
        ),

        card(`Personal signatures (${users.length})`,
          h("p", { class: "muted small" },
            "Uploaded by each person on their own profile. You can remove one, but not replace it — ",
            "that stays with whoever it belongs to."),
          users.length
            ? table(["", "Person", "Uploaded", ""],
                users.map(s => [
                  withPreview(s),
                  h("div", {},
                    h("strong", {}, s.label || s.ownerEmail),
                    h("p", { class: "muted small" }, s.ownerEmail || "")),
                  h("span", { class: "small" }, fmtLogTime(s.uploadedAt)),
                  button("Remove", { variant: "quiet-danger", onClick: () => removeOne(s) }),
                ]))
            : h("p", { class: "empty" }, "Nobody has uploaded one yet."),
        ),
      );
    } catch (err) {
      mount(host, errorBox(friendlyError(err), load));
    }
  }

  load();
  return root;
}
