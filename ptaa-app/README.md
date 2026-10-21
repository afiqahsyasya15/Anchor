# Anchor — PTAA Workflow System

## Solo mode (how it is set up now)

`config.js` → `workflow.solo = true`. One person — the admin — does everything,
and only the admin's own Google account can sign in. Nobody else is registered.
The full team workflow is still in the code; set `solo: false` to switch back.

**The flow, one PTAA at a time**

1. **New PTAA** — owner, condo, unit, tenancy, fees, utilities, special terms;
   pick the **Sales Agent** from the list; attach the owner's I/C (front, back)
   and the **quotation PDF**. The quotation's items and grand total are read
   automatically (the renovation cost is filled from the grand total).
2. **Draft** — *Draft the PTAA (Word)* fills the condo's template.
   *Make the invoice (Excel)* fills the office's invoice with: owner, condo and
   unit; the next invoice number (BLKINV-YYMM + running number, carrying on from
   the last one used); today's date; every quotation item with quantity above
   zero — the same item in several rooms becomes one line with the quantities
   added, and the smart lock and gateway are FOC at the end; the grand total and
   the 1st/2nd/3rd payments. Every line can be edited before the file is made.
3. **Edit, save and print** in Word and Excel.
4. **Upload the confirmed files** — the final .docx and .xlsx (or *Use the draft
   as final* if nothing changed).
5. **File to Google Drive** — both files go into the Drive folder chosen under
   **Settings**, in a sub-folder per condo (an existing one is reused). The PTAA
   is marked *Filed* only if both uploads succeed. Filing again replaces the
   earlier copies; it never duplicates or overwrites someone else's file.

**Lists the admin keeps**

- **Agents** — the Sales Agents to pick from. Full name, I/C and mobile print in
  the "Witnessed by" block. This is a list, not accounts: no email is
  registered and nobody listed can sign in. Import a CSV (Full Name, Nickname,
  NRIC No, Email Address, Contact No); anyone already listed, and repeated rows,
  are skipped.
- **Condos** — name, full address, and the **PIC** picked from the Customer
  Relationship team list (their nickname and mobile print as the Owner Group
  Admin). Import a CSV (Property Name, Full Address, PIC).
- **Templates** — one Word template per condo, as before.
- **Settings** — the Drive folder, the last invoice number used, whether the
  running number restarts each month, default payments, and which items are
  always FOC.

**Deploying:** upload the contents of the `deploy` folder (index.html,
config.js, styles.css, js/, vendor/, assets/) as a new deployment. After
changing the rules, publish `firestore.rules` again (Firestore → Rules).

---

Every phase of the build order in `PTAA-System-Brief.md` §15 **except phase 12**,
the AI cross-check, which was dropped deliberately: it would send every request
and its document to a language model on each check — a daily running cost — for
advisory flagging the admin already does by eye during the final checklist. The
dashboard lists it as *Skipped* rather than quietly omitting it, and it can be
added later if that trade changes.

**A PTAA is marked Completed only after the Google Drive upload succeeds.** The
upload runs first; the status, the Drive link and the completion stamp are one
write that happens afterwards. If the upload fails, none of it happens and the
request is untouched at Final check (brief §11.2, rule #6). The database rules
refuse the move to Completed unless the same write carries a Drive file id, so
it cannot be bypassed by calling the API directly either.

Built the same way as the BLANKCO quote builder: a plain single-page app,
Firebase for auth and data, no build step, deployed as static files.

---

## What works today

**Accounts (phase 1)**

- **Sign in with Google** — identity scopes only (`openid`, `email`, `profile`).
  No Drive scope is requested anywhere in this codebase (brief §4.2).
- **Approved-account list** — an address that is not on the list is refused with
  a clear message that shows them the exact address to send you. Not a silent
  empty dashboard.
- **Roles** — Admin and Sales Agent, enforced by the Firestore security rules,
  not by hiding buttons.
- **User management** — add an address, change a role, switch access off and
  back on. Guards prevent an admin locking themselves out or removing the last
  remaining admin.
- **Sales Agent profile** — Full Name, I/C, Phone, Nickname, with Malaysian I/C
  and mobile validation, and a live preview of exactly how the values land in
  the *Witnessed by* block and the *Tenancy Administrator contact* line.
  Every save is versioned, so a later edit can never alter a PTAA that was
  already prepared (brief §6, rule #4).

**Requests (phases 2 and 3)**

- **Property registry** — admins keep the list of condos; agents pick from it
  rather than typing. One spelling per property, because that name becomes the
  Drive folder and part of the filename. A differently-cased duplicate is refused.
  Each property also carries its **Owner Group Admin** (nickname and mobile),
  because that differs by condo and should not be retyped on every request.
- **Agents can ask for a condo to be added.** On the New Request form, *"Condo
  not on the list?"* sends the admin a request with the name, address and a note.
  Approving it is what creates the property — with the spelling the admin
  settles on, not the agent's — and the agent is notified either way.
- **New PTAA Request** — owner (including bank name and account number for the
  rent-payment clause), property and size, tenancy, the administration fee as a
  **percentage of gross monthly rental**, utilities, and a variable-length list
  of special terms. The agent's own details are filled in automatically and
  **snapshotted onto the request**, so a later profile edit cannot change a PTAA
  that already exists.
- **Utilities are a picker, not a typed list.** Schedule items 11, 12 and 13
  move between three parties depending on what the Owner chose: they pay, we
  advance it and recover it from the rental, or the Tenant pays. Three quick-set
  buttons move electricity, water and internet together; cleaning and
  air-conditioning are set separately; anything else can be added by name. A
  **Whole Unit Rental puts Cleaning Services on the Tenant** by default, because
  the tenant has the whole unit. A live preview shows exactly how the three
  schedule rows will read before anything is generated.
- **The filename is previewed while you type** —
  `PTAA (ONE EQUINE C-01-03) YEN POH WE.docx`. A wrong unit or owner
  name is visible immediately, not in phase 5.
- **Expiry is worked out from the term** — a 36-month tenancy from 1 Sep 2026
  expires 31 Aug 2029, not 1 Sep. Month-ends are clamped. It can be overridden.
- **Supporting files — three named slots**, not a gallery: the Owner's I/C
  front, the I/C back, and the renovation quotation. Each has a fixed place in
  the finished agreement, which is why they are labelled rather than piled up:
  the I/C goes onto its own page before Appendix A, the quotation into Appendix
  A. Camera or album on a phone; a quotation may be a photo **or a PDF**, and a
  PDF is rendered to one image per page in the browser at the moment it is
  attached, so what is stored is exactly what goes into the document.
- **Admin queue and dashboard** — ordered by *who has the ball*, not by status,
  because "is this waiting on me?" is the question being asked. Filter by
  status, agent, property and current action; search owner, unit, PTAA number.
- **Agents see only their own requests**, enforced in the security rules.

**Templates and documents (phases 4 and 5)**

- **One .docx template per condo.** Upload it under **Templates**; onboarding a
  new property needs no code change and no redeploy.
- **The upload is checked and refused if anything is missing**, naming exactly
  which placeholders — grouped the way the brief groups them. That single check
  is what stops most silent document-generation failures.
- **Word splitting a placeholder across runs does not matter.** Every run in a
  paragraph is joined before the check, so a placeholder broken up by a
  spell-check pass is still found. Headers and footers are scanned too.
- **Fields are filled by name, never by position** (§5.1, rule #3). No page
  number, no paragraph index, no searching for sample text.
- **Generation fills the real .docx in place** — formatting, tables, spacing and
  page numbering are the template's own; nothing is rebuilt as HTML.
- **The filename is generated, never typed**:
  `PTAA (ONE EQUINE C-01-03) YEN POH WE.docx`.
- **Manual edits are respected.** Download, edit in Word, upload it back; the
  request records that it was hand-edited, and regenerating then asks first and
  spells out what would be lost (§5.4, criterion #17). Only the current document
  is kept — no V1/V2/V3.
- **A property with no template cannot generate**, and the message names the
  property.
- **Signature images, placed deliberately.** Company signatures (the Director's,
  marked as such) live under **Signatures**; anyone can upload their own on their
  profile. On a request, an admin picks which image goes in each slot, sees a
  preview, and confirms — then the PNG is embedded into the real .docx, about
  2 cm tall, with transparency intact. Who placed which is written to the
  request's history. A slot with nothing chosen prints as an empty line, ready
  to sign on paper; the marker is never left behind in the finished agreement.
  Nothing is ever applied automatically (§10).
- **The admin who generates is recorded.** Their name, I/C and mobile fill the
  second *Witnessed by* block, so an admin whose own profile is incomplete
  cannot generate — the app says why rather than producing a document with a
  blank witness.

**Workflow, notifications and sign-off (phases 6 to 10)**

- All ten statuses and the exact transition table from brief §7.2, enforced
  **server-side** as well as in the UI.
- `PTAA OK` is a resting state — releasing to the agent is a separate,
  deliberate click (brief §7.3).
- `On hold` remembers the status it came from, with a reason; Resume returns it
  there exactly.
- **Nothing can be marked Completed**, at any status, by anyone. Rule #6 says a
  PTAA is not completed without a passed checklist and a successful Drive
  upload; neither exists yet, so neither does the transition.
- **Append-only history**, per request and account-wide.
- **In-app notifications** (phase 7) for each of the six moments §14.2 lists,
  each linked to its PTAA, with an unread count in the header. In-app only —
  the brief says not to build a fake email path, so there isn't one.
- **Owner change requests** (phase 8) — once a PTAA is released, the agent sends
  it back with a plain description of what the Owner wants. No supporting
  document required. It stays visible on the request until the admin has dealt
  with it and marks PTAA OK again.
- **Completion and Drive filing** (phase 11) — the last step is a transaction,
  not a status change. The document is uploaded into its property folder under
  the existing PTAA root, the Drive id and link are stored, the completion is
  stamped and the agent is notified — in that order, with a failed upload
  meaning none of it happened. Folders are found by name and reused, never
  duplicated; a file belonging to a different PTAA is never overwritten. See
  **Connecting Google Drive** below for the one-time setup.
- **Global search** (phase 13) — one box in the header, on every screen, across
  owner, condo, unit, agent, PTAA number, status, filename and Drive link. Every
  word typed has to appear somewhere, so more words narrow rather than widen,
  and results are ranked so an owner-name match beats an address that happens to
  contain the same word.
- **Reporting** (phase 13) — where open work is sitting, who has the ball, and
  how long completed PTAAs actually took from submission to filing.
- **Signature tracking** (phase 9) — each signatory tracked separately with its
  own status and dates, because not every PTAA needs the same people. The
  overall state is derived: *"Waiting for Witness."* Who has the ball moves to
  whichever signatory is holding things up, not always the Director.
- **Final checklist** (phase 10) — the eleven confirmations from §11.1. Items
  the system can answer for itself are blocked rather than taken on trust: you
  cannot tick "Final Word document exists" when there is no document, or
  "Required signatures completed" while one is outstanding. Editing the request
  data clears the whole checklist, because a confirmation about information that
  has since changed is not a confirmation.

---

## Updating an existing installation

If you already have an earlier version running, three things need doing:

1. **Re-publish the security rules.** Firestore Database → **Rules** → paste
   the whole of the new `firestore.rules` → Publish. Do this every time — the
   rules gain a collection with almost every phase, and an out-of-date copy
   refuses the new features rather than failing loudly. This version adds the
   `FINAL_CHECK → COMPLETED` transition, which is allowed only when the same
   write carries a Drive file id.
2. **Add at least one property.** Sign in as an admin → **Properties** → add
   your condos, with the Owner Group Admin for each. Agents cannot submit a
   request until one exists, and the app tells them so rather than failing
   silently.
3. **Prepare and upload a template per condo.** See the next section — this is
   the part that needs work in Word, not in the app.
4. **Fill in your own admin profile**, under **My profile**. The admin who
   generates a document is named in its second *Witnessed by* block, so
   generation is blocked until yours is complete.
5. **Upload the Director's signature** under **Signatures**, and mark it as the
   Director's. Optional — without it, documents generate with empty signature
   lines, which is correct if they are signed on paper.

Nothing else changes: same Firebase project, same `config.js`, same accounts.

**If you are updating from a version before the real D TERRA template landed:**
the placeholder set changed to match that template. `{{unit_no}}` is now
`{{property_unit_number}}`, `{{generated_date}}` is now `{{today_date}}`, and the
term and the fee are each **two** placeholders — the words and the digits, e.g.
`{{initial_term_months}}` → *Thirty-six* alongside
`{{initial_term_months_numberic}}` → *36*. The administration fee is a
percentage, not a Ringgit amount. Re-upload each template; the check will name
anything that needs changing. (The `numberic` misspelling is deliberate — it is
what the real templates say, and the correctly-spelled `_numeric` is filled too,
so either works.)

---

## Preparing your PTAA templates

This is the one step the app cannot do for you, and brief §0.1 lists it as a
prerequisite. Each condo's Word file needs placeholders put into it.

1. In the app: **Templates → Download the placeholder reference (.docx)**. Open
   it in Word beside the real template. It is a cheat-sheet, not a PTAA.
2. In the real template, replace the sample text with the placeholder — e.g. in
   the *Witnessed by* block, `CHAN SIEW SIN` becomes `{{agent_full_name}}`, and
   the contact line `(2) Suzanne (Sales Agent) - 019-400 9082` becomes
   `(2) {{agent_nickname}} (Sales Agent) - {{agent_mobile}}`.
3. For the supporting files the agent uploads, put the placeholder alone on the
   line where the picture should sit: `{{ic_front}}` and `{{ic_back}}` on the
   I/C page, `{{quotation}}` in Appendix A. A quotation that arrives as a PDF
   becomes one full page per sheet; when nothing is attached, no page is added.
4. For the utilities, schedule rows 11, 12 and 13 are one placeholder each —
   `{{utilities_owner}}`, `{{utilities_advanced}}`, `{{utilities_tenant}}`. Each
   prints whatever was assigned to that party on the request, one item per line,
   or the word *None*.
5. For special terms, if the template has a special-terms section, put these on
   three consecutive lines: `{{#special_terms}}`, then `{{.}}`, then
   `{{/special_terms}}`. The middle line repeats once per term, so the number of
   terms can vary. Templates without such a section are fine as they are.
6. For signatures, put `{{sig_director}}`, `{{sig_agent}}` or `{{sig_admin}}`
   alone on the blank line above the relevant signature line. Leave that blank
   paragraph where it is — the image is placed about 2 cm tall, so a line with no
   room pushes the block onto the next page.
7. Save as `.docx` and upload it against the property. If anything is missing the
   upload is refused and tells you precisely what to add.

Type or paste each placeholder in one go. Two braces each side, lower case, no
spaces inside. A missing brace is the most common mistake and the upload will
catch it.

---

## Setup

Nine steps. Takes about twenty minutes the first time.

> **Finding things in the Firebase console.** Google keeps rearranging the left
> sidebar — recent versions group everything under collapsed headings like
> *Databases & Storage*, *Security* and *Hosting & Serverless*, so the product
> you want may not be visible at all.
>
> **Ignore the sidebar and use "Search for products" at the top of it.** Type
> `Authentication` or `Firestore` and open the result. That works whatever the
> current layout is. Wherever a step below names a product in bold, search for
> it rather than hunting through the categories.

### 1. Create a Firebase project

[console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
Google Analytics is not needed — turn it off.

Note which Google account the console greets you as. Owning the project and
using the app are separate things — step 6 needs the address you will actually
*sign into the PTAA app* with, which may not be this one.

### 2. Turn on Google sign-in

Search **Authentication** → **Get started** → **Sign-in method** → **Google** →
enable → set a support email → **Save**.

(In the grouped sidebar this lives under *Security*.)

### 3. Create the database

Search **Firestore Database** → **Create database** → choose a location near you
(`asia-southeast1` is Singapore) → start in **production mode**.

Production mode denies everything until step 4. That is what you want.

(In the grouped sidebar this lives under *Databases & Storage*.)

### 4. Publish the security rules

**Firestore Database** → the **Rules** tab at the top → replace everything in the
editor with the contents of `firestore.rules` from this folder → **Publish**.

Do not skip this. Until the rules are published, nothing in the app can read or
write anything, and every screen will show a permission error.

### 5. Register the web app and copy its config

**Settings** (the gear) → **General** → then **scroll to the bottom** of that
page. "Your apps" is a section at the foot of the General page, not an entry in
the Settings menu — that catches everyone.

If no app is registered yet you will see platform icons. Click the `</>` (web)
one → give it a nickname → **Register app**. Skip "Also set up Firebase
Hosting"; the app is going on Cloudflare Pages.

Firebase shows a `firebaseConfig = { … }` snippet. Copy each value into the
matching `PASTE_…` slot in **`config.js`**. While you are in there, set
`company.name` and `company.supportContact`.

### 6. Create the first admin by hand

The rules only let an admin add accounts — so the first one has to be created
directly in the console, which bypasses the rules.

**Firestore Database** → the **Data** tab → **Start collection**

- Collection ID: `users`
- Document ID: **the Google address you will sign into the app with, all
  lowercase** — e.g. `irfankimie321@gmail.com`. Not necessarily the account that
  owns the Firebase project.

Add exactly these three fields:

| Field    | Type      | Value                          |
|----------|-----------|--------------------------------|
| `email`  | string    | the same address, lowercase    |
| `role`   | string    | `admin`                        |
| `active` | boolean   | `true`                         |

Spelling matters: `admin` in lowercase, `active` as a real boolean and not the
text `"true"`. If either is wrong the app tells you so at sign-in instead of
failing silently.

### 7. Try it locally

Google sign-in will not work if you just double-click `index.html` — the page
has to be served over `http://`. Open a terminal in this folder and run one of:

```
py -m http.server 5173        # Windows, if Python is installed
python -m http.server 5173    # Windows, alternative
npx serve -l 5173             # if you have Node.js instead
```

Open <http://localhost:5173>. Firebase authorises `localhost` by default, so
sign-in works straight away — no extra configuration.

If you have neither Python nor Node.js, skip this step and go straight to
Cloudflare Pages in step 8; the deployed site works the same way.

### 8. Deploy to Cloudflare Pages

[dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
**Create** → **Pages** → **Upload assets** → drag this folder in → **Deploy**.

No build command, no framework preset — these are static files.

You can delete the `tests/` folder before uploading; it is only used for
development and is not part of the app.

### 9. Authorise the deployed address

Back in Firebase: search **Authentication** → the **Settings** tab →
**Authorized domains** → **Add domain** → your Pages address
(e.g. `ptaa-workflow.pages.dev`), and any custom domain you attach later.

Miss this and sign-in fails on the live site with
*"This web address is not in the Authorized domains list"* — which the app tells
you in those words.

---

## Adding everyone else

Once you are signed in as the first admin, **Users** → add each address and pick
a role. New accounts are active Sales Agents by default.

**One Gmail trap worth knowing.** Google treats `a.b@gmail.com` and
`ab@gmail.com` as the same mailbox; this list does not. The address on the list
has to match what Google actually reports for that account. If someone is
refused, the refusal screen shows them the exact address with a copy button —
have them send you that, verbatim.

### What a Sales Agent does (solo mode)

With `workflow.solo` still on, agents sign in to a small version of the app:

- **New PTAA** — owner, unit, utilities, the I/C photos and the quotation (its
  items are read for the invoice). No tenancy period and no special terms: the
  admin sets those. **Save draft** keeps a half-filled form under
  *My PTAAs → Drafts* (no PTAA number is used until it is submitted).
- **My PTAAs** — what they submitted, its status (Submitted → Being prepared →
  Ready to download) and, at the end, **Download PDF**.
- They never see the Word file, the invoice, signatures, the checklist or the
  history. The database rules enforce this, not just the screens.

The admin sees new submissions on the dashboard (*New from Sales Agents*), sets
the tenancy period (the expiry date fills itself in), drafts and files as
before, and in step **7 · Finished PDF for the Sales Agent** sends the PDF —
the complete one from step 6, or an uploaded copy such as the signed one.

After updating, publish the new `firestore.rules` (Firebase console →
Firestore → Rules → paste → Publish): it adds `drafts` and `finalChunks` and
makes the Word and Excel files admin-only.

---

## Verifying the permission rules

Brief acceptance criterion #9: *an agent calling the API directly for another
agent's data gets an authorisation error, not data.* The tests in this folder
cannot check that, because the rules run on Google's servers, not in the browser.
`firestore.rules` has not been executed against the real rules engine — verify
it once, on your project, before trusting it:

**The console does the first check for you.** The Rules editor validates syntax
as you paste and refuses to publish rules it cannot parse, so if **Publish**
succeeds in step 4, the file parsed. Next to the editor, **Rules Playground**
simulates a single read or write as a given signed-in address — a good two
minutes to spend confirming that a non-approved address cannot read `users`.

Then, two ways to check the running system:

**By hand, in two minutes.** Sign in as a Sales Agent, open the browser console
and run:

```js
const { getFirestore, getDocs, collection } =
  await import("https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js");
await getDocs(collection(getFirestore(), "users"));
```

It must fail with `permission-denied`. If it returns documents, the rules were
not published — go back to step 4.

**With the emulator**, if you want it automated later:

```
npm install -g firebase-tools
firebase emulators:start --only firestore
```

then write rule tests with `@firebase/rules-unit-testing`. Worth doing before
phase 2 adds the `requests` collection, where the agent-isolation rule actually
starts protecting real data.

---

## If something goes wrong

The app names the cause on screen wherever it can. The three you are most
likely to hit while setting up:

| What you see | What it means |
|---|---|
| *A product named in these steps is nowhere in the sidebar* | The console groups products under collapsed categories. Use **Search for products** at the top of the sidebar instead. |
| *There is no "Your apps" in the Settings menu* | It is a section at the bottom of the **General** settings page, not a menu entry. Open General and scroll down. |
| *"The security rules in the Firebase console are not the ones in firestore.rules"* | Step 4 was skipped, or the paste did not save. Re-publish the rules. |
| *"This web address is not in the Authorized domains list"* | Step 9. Add the Pages address in Firebase → Authentication → Settings. |
| *"This account is not on the approved list"* for the first admin | The document ID in `users` does not exactly match the address Google returns — usually a capital letter, a stray space, or Gmail dots. The screen shows the exact address; copy it and rename the document. |

One rarer case: the rules require `email_verified` on the Google token. Every
normal Google account has it. If sign-in succeeds but every screen reports a
permission error even though the rules are published, that line in
`firestore.rules → signedIn()` is the one to check.

---

## Running the tests

**Validation and the state machine** — no browser, nothing to install:

```
node --test tests/*.test.mjs
```

174 tests: Malaysian I/C and mobile formats, the transition table, tenancy date
arithmetic, the filename pattern, request validation, the utilities rules
(including cleaning falling to the tenant on a WUR), the fee as a percentage,
signature summaries, the checklist and its blockers, the template placeholder
check, the by-name field mapping, the signature-image embedding down to the
relationship ids and the content type, and global search — including that adding
a word narrows the result rather than widening it, and that an owner-name match
outranks an address that happens to contain the same word. Some round-trip a
real .docx and skip themselves unless `npm install pizzip docxtemplater` has
been run.

**Eleven of those tests are the security boundary** and are worth knowing about.
`functions/api/drive/upload.js` holds the refresh token for the company Google
account, so anything that can talk it into an upload can write into the company
archive. `tests/drive-auth.test.mjs` mints real RS256 tokens with `node:crypto`
and checks the endpoint refuses a tampered payload, a token signed with a
different key, one for another Firebase project, an expired one, an unknown key
id, and the classic `alg: none` forgery — and that the public key it extracts
from an X.509 certificate is byte-identical to OpenSSL's answer for both 2048-
and 4096-bit keys. That last one caught a real bug: the first version used fixed
byte offsets to find the key and would have failed on the first upload.

**Solo workflow end to end** — a real quotation PDF and a real condo template
through to filing in a fake Drive:

```
QUOTE_PDF=quotation.pdf TEMPLATE_DOCX=template.docx AGENTS_CSV=agents.csv \
  node tests/browser/run-solo.mjs
```

**Two static checks**, which need nothing installed and run in a second:

```
node tests/check-imports.mjs        every named import resolves
node tests/check-undeclared.mjs     nothing uses a name it never imported
```

The second one earned its place: a screen called `table(...)` in a file that had
not imported it, which showed up only as a blank page.

**The whole of phase 1 end to end** — the real application code with an
in-memory stand-in for Firebase, so it needs no project and no credentials:

```
npm install playwright && npx playwright install chromium
python3 -m http.server 8123        # in another shell, from this folder
node tests/browser/run.mjs
```

330 checks covering the allowlist gate, the profile gate, profile versioning,
the users screen and its guards, request submission end to end (including an
image attachment), agent isolation, the admin queue and dashboard, every
transition in the state machine, hold-and-resume, cancellation, the fact that
nothing can be marked Completed, template upload and refusal, and document
generation — it downloads the produced .docx and checks the filled values, the
words-and-digits pairs, the utilities rows, the signature images actually
embedded in the package, the repeating block and the surviving table — plus
notifications, Owner change requests, signature tracking, the final checklist,
an agent asking for a new condo and an admin approving or declining it, the
signature library, an admin with no profile being refused a document, global
search and its agent isolation, the reporting view, and the whole completion
path — with the most important case being that **a failed Drive upload leaves
the request completely untouched**: still at Final check, no Drive record, no
completion stamp, and no "it's done" notification to the agent.

The Pages Function is not running under test, so `/api/drive/upload` is
intercepted and answered by hand. That is deliberate: these tests are about what
the app does with each answer Drive can give.

It also writes ten screenshots into the project folder, which is a quick way to
see the whole app without setting anything up.

---

## Data model

```
users/{email}                       ← document ID is the lowercased Google address
  email, role: "admin"|"agent", active: bool
  invitedBy, invitedAt
  uid, googleDisplayName, photoURL, firstLoginAt, lastLoginAt
  profileComplete: bool
  profile: { fullName, nric, phone, nickname, version, updatedAt, updatedBy }

users/{email}/profileVersions/{n}   ← immutable snapshot of each saved profile
  fullName, nric, phone, nickname, version, savedAt, savedBy

properties/{autoId}
  name, nameLower, address, active, createdBy, createdAt
  picNickname, picMobile           ← the Owner Group Admin, schedule item 4a

propertyRequests/{autoId}          ← an agent asking for a condo to be added
  name, address, note, status: "PENDING"|"APPROVED"|"REJECTED"
  requestedBy, requestedAt
  decidedBy, decidedAt, decisionNote, propertyId

signatures/{key}                   ← key is "shared:<slug>" or "user:<email>"
  key, kind: "shared"|"user", ownerEmail, label, fileName
  bytes, chunkCount, width, height, isDirector
  uploadedBy, uploadedAt
signatures/{key}/chunks/{n}
  data                             ← base64 slice of the PNG

templates/{propertyId}              ← document ID is the property's ID: one each
  propertyId, propertyName, fileName, bytes, chunkCount
  placeholders: [ … ], loops: [ … ], version, uploadedBy, uploadedAt
templates/{propertyId}/chunks/{n}
  data                              ← base64 slice of the .docx

counters/requests
  next                              ← the next PTAA number, bumped in a transaction

requests/{PTAA-00001}               ← document ID *is* the PTAA number
  ptaaId, type, status, currentAction
  previousStatus, holdReason, holdNote, cancelReason
  agentEmail                        ← the rules key agent isolation on this
  agentSnapshot: { email, fullName, nric, phone, nickname, profileVersion }
  adminSnapshot: { email, fullName, nric, phone, nickname, profileVersion } | null
                                    ← who generated the document; the witness block
  owner: { name, nric, address, phone, email, bankName, accountNumber }
  propertyId, propertyName, propertyAddress, unitNo, ptaaType, propertySize
  tenancy: { initialTermMonths, commencementDate, expiryDate }
  financial: { monthlyAdminFeePercent, renovationCost }
  utilities: { <key>: { label, party: "owner"|"advanced"|"tenant"|"none", standard } }
  specialTerms: [ … ], notes
  attachmentCount, dueDate, revision, manuallyEdited
  workingDoc: { fileName, bytes, chunkCount, source, savedAt, savedBy }
  signatories: { director|witness|owner|agent: { status, requestedAt, signedAt, … } }
  finalChecklist: { <item key>: { checked, at, by } }
  openChangeRequest: { text, at, by } | null
  drive: { fileId, fileName, webViewLink, folderId, folderName,
           uploadedAt, uploadedBy, replaced } | null   ← written only on completion
  completedAt, completedBy
  createdAt, createdBy, updatedAt, lastActionBy

requests/{id}/attachments/{autoId}  ← supporting images, NOT permanent record
  kind, name, dataUrl, bytes, width, height, addedBy, addedAt

requests/{id}/docChunks/{n}         ← the current Word document, base64 slices
  data

notifications/{autoId}              ← in-app only; no email is ever sent
  forEmail, requestId, ptaaLabel, text, event
  createdAt, createdBy, readAt

requests/{id}/activity/{autoId}     ← append-only, per request
  at, actorEmail, actorRole, action, summary, detail

activity/{autoId}                   ← append-only, account-wide
  at, actorEmail, actorRole, action, summary, targetType, targetId, detail
```

**No Firestore indexes to create.** Queries deliberately never combine a
`where` with an `orderBy` on a different field, because that needs a composite
index built by hand in the console. Sorting and filtering happen in the browser
instead, which is cheaper than that setup step at this team's volume. Phase 13
revisits it when global search arrives.

The document ID being the email is deliberate: it is the one thing the security
rules can compare against `request.auth.token.email` without an extra lookup.
`js/validate.js → emailKey()` and `firestore.rules → myEmail()` must always do
the same transformation — today, lowercase and trim, nothing more.

`profileVersions` exists now, before it is needed, because phase 5 will stamp
the version used onto each generated PTAA. That is what makes rule #4 —
*profile edits never alter existing PTAAs* — structural rather than a promise.

---

## Files

```
index.html            entry point
config.js             ← the only file you edit
functions/            Cloudflare Pages Functions — the ONLY server-side code
  api/drive/upload.js   holds the Drive refresh token; see "Connecting Google Drive"
styles.css
firestore.rules       ← paste into the Firebase console (step 4)
start-local.bat       double-click to preview locally on Windows
serve.mjs             the tiny server start-local.bat runs
vendor/               PizZip and docxtemplater, shipped with the app
reference/            the placeholder cheat-sheet admins download
js/
  app.js              shell, navigation, routing
  auth.js             sign-in and the allowlist gate
  core.js             Firebase wiring, DOM helper, activity log
  validate.js         I/C, mobile, name validation (no Firebase import)
  model.js            the state machine, filename, dates, request validation
  requests.js         Firestore access for properties, requests, attachments
  images.js           camera/album capture and client-side downscaling
  screens.js          sign-in, refusal, profile, users, activity log
  screens-request.js  the New PTAA Request form and the request detail
  screens-queue.js    the queue, the property registry, the dashboards
  screens-templates.js  the template registry and its validation report
  screens-signatures.js the signature library and the profile upload panel
  screens-search.js   global search and the reporting view
  drive.js            the browser half of the Drive upload
  placeholders.js     the required placeholder set, parser and field mapping
  numberwords.js      36 → "Thirty-six", 10 → "Ten Per centum", 1 → "01st"
  docx.js             reading, checking and filling a .docx
  docximage.js        putting a signature PNG into the .docx package
  signatures.js       storing and choosing signature images
  property-requests.js  an agent asking for a condo to be added
  templates.js        Firestore storage for the per-condo templates
  chunks.js           storing a binary file across Firestore documents
  notifications.js    in-app notifications
  screens-notifications.js  the notifications screen and the header count
  ui.js               buttons, cards, tables, badges, live-validating fields
tests/                not needed in the deployed site
```

`js/model.js` and `firestore.rules` both encode the §7.2 transition table.
**Change one and you must change the other**, or the server will refuse a move
the UI offers. `tests/model.test.mjs` covers the client half.

`functions/` is the only server-side code in the project. Everything else is
static files. It exists because a refresh token cannot live in a browser.

Routing is hash-based (`#/users`) so every URL survives a refresh on static
hosting with no redirect rules.

---

## Is it safe that my Firebase keys are in `config.js`?

Yes. A Firebase web config identifies the project; it does not grant access to
it. Anyone can read those values from any Firebase site, including BLANKCO's.
What stops someone using them is `firestore.rules` — which is why step 4 is the
one step that must not be skipped, and why the rules file is worth reading
before phase 2 adds real PTAA data.

There is one consequence to know about: Firebase Authentication will create an
account record for anyone who completes a Google sign-in, even if they are then
refused by the allowlist. Those records appear under **Authentication → Users**
and can read nothing at all. You can delete them if the list gets untidy.

---

## What is deliberately not built

Per brief §15 — *do not build a mock version that pretends the integrations
work*. The dashboard lists all thirteen phases with their real status, and no
invented PTAA data appears anywhere. **No template is shipped with the app** —
the reference file under `reference/` is a placeholder cheat-sheet and says on
its first line that it is not a PTAA.

Also not built, on purpose:

- **The AI cross-check (phase 12).** Dropped on Irfan's call, and the reasoning
  is sound: it would send every request and its document to a language model on
  every check, as a standing daily cost, to produce advisory flags an admin
  already forms by eye while working through the eleven-item checklist. The
  dashboard shows it as *Skipped* rather than hiding it.
- **Marking Completed as an ordinary status change.** `FINAL_CHECK → COMPLETED`
  is deliberately absent from the transition table in `js/model.js`, so it can
  never be rendered as a plain button — pressing one would mark a PTAA completed
  without uploading anything. Completion is the transaction in
  `requests.js → completeRequest`, and `firestore.rules` allows the move only
  when the same write carries a Drive file id.
- **Email notifications.** Brief §14.2 says not to build a fake email path, so
  notifications are in-app only and the screen says so.
- **Applying a signature without being asked.** Signature images are now placed
  into the `.docx` (see `js/docximage.js`), but only after an admin has chosen
  each one on the request and confirmed a dialog naming them. Nothing is applied
  automatically, and who applied which is written to the request history. §10
  is intact; only the manual round-trip through Word is gone.
- **Deleting a user or a request.** Switch access off, or cancel the request.
  The rules deny deletion outright so history is never erased.

---

## Why supporting images live in Firestore, not Cloud Storage

Since September 2024, provisioning a Cloud Storage bucket requires the Blaze
(pay-as-you-go) plan, and this project is on Spark. So `js/images.js` shrinks
each photo in the browser — progressively, until it fits under 600 KB — and
stores it as one Firestore document per image.

That has a side benefit for brief §12: "not retained permanently" becomes a
document delete, with nothing left behind in a bucket. **Delete all supporting
images** on the request detail does exactly that, and logs it.

The trade-off is honest: this is not what you would do at scale. If the project
moves to Blaze later, swapping to Cloud Storage touches `js/images.js` and the
attachment helpers in `js/requests.js`, and nothing else.

---

## Brand and colour

The palette is The Blank Company's: primary `#FCFF00`, secondary `#000000`,
tertiary `#0055FF`, neutral `#1A1A1A`. Typefaces are Sora for headings, Hanken
Grotesk for body and JetBrains Mono for labels.

**One rule governs all of it.** Brand yellow measures **1.08:1 against white** —
invisible — and **19.4:1 against black**. So in this app yellow is a *surface*
that always carries black on it, exactly the way the logo works. It is never
text, never a hairline, never a border on a light background.

That is why the brand lives in the chrome rather than the content:

| Where yellow appears | Why it works there |
|---|---|
| The header bar and the active nav underline | Yellow on black, 17.8:1 |
| The primary button | Black text on yellow, 19.4:1 |
| The "Current action" badge, when it is yours | Black on yellow; the one question the app exists to answer |
| The generated filename | Diluted to `--brand-tint`, 16.7:1 under the body ink |
| The band across the sign-in card | Pure decoration, carries no text |

Everything that has to be *legible as text* uses the brand tertiary instead:
links, focus rings and quiet actions are `#0043CC` (7.9:1). The ground is a warm
off-white — a cool grey next to yellow makes the yellow look dirty — and the
body ink is `#1A1A1A` rather than pure black, which is easier over a working day.

Two consequences worth keeping if you edit `styles.css`:

- **The warning colour is burnt orange, not amber.** An amber warning sitting
  next to a yellow brand reads as brand, not as a warning.
- **The focus ring is blue, not yellow.** A focus ring nobody can see is not a
  focus ring. It flips to yellow inside the black header, where yellow wins.

Every text/background pair in the palette clears WCAG AA; most clear AAA.

The three webfonts load from Google Fonts, and **every rule names a system
fallback after them** — if a corporate proxy blocks `fonts.googleapis.com` the
app looks plainer and works identically. Nothing depends on the webfont. If you
would rather not depend on that host at all, download the four families' woff2
files into `vendor/fonts/`, add `@font-face` rules at the top of `styles.css`,
and delete the `<link>` tags from `index.html` — the same reasoning that put
PizZip and docxtemplater in `vendor/`.

---

## Connecting Google Drive

Files are uploaded **straight from the browser, as the signed-in admin**. The
first time you file in a session, Google shows a pop-up asking to let the site
use your Drive; the permission lasts about an hour and is kept only in that
browser tab. No server, secret or refresh token is involved, so this works on
the plain static site (Cloudflare Workers or Pages, either).

(This replaced an earlier design built around a Pages Function in `functions/`
holding a company refresh token. That folder is no longer used and does not
need deploying.)

### Once

1. **Turn on the Google Drive API** for the Firebase project:
   <https://console.cloud.google.com/apis/library/drive.googleapis.com?project=ptaa-60427>
   → **Enable**.
2. **OAuth consent screen** (<https://console.cloud.google.com/apis/credentials/consent?project=ptaa-60427>).
   If *Publishing status* is **Testing**, add your own Gmail under **Test users**.
   Google will show "Google hasn't verified this app" the first time — that is
   expected for your own internal app: *Advanced → Go to … (unsafe)* → allow.
3. In the app, **Settings → Google Drive**: paste the folder's link from the
   browser's address bar → **Save and test**. It shows the folder's name when it
   can reach it.

### If it fails

| What you see | What to do |
|---|---|
| "The Google Drive API is switched off" | Step 1 above. |
| "Your browser blocked Google's pop-up" | Allow pop-ups for the site, press again. |
| "That Google Drive folder cannot be found" | Check the link under Settings, and that your Google account can open the folder. |
| "…already exists … and was not put there by this app" | A same-named file is in the condo folder already. Rename or move it in Drive, then file again. Nothing was overwritten. |

In every case the PTAA stays unfiled, with nothing half-done.

---

## How a signature image gets into the Word file

docxtemplater's image module is a paid add-on, so `js/docximage.js` does the
five steps itself, on the rendered package:

1. the template renders `{{sig_director}}` as a marker, `[[ANCHORSIG:sig_director]]`
2. the PNG is written to `word/media/`
3. a relationship is added to `word/_rels/document.xml.rels`
4. `[Content_Types].xml` gains a `Default` for the `png` extension — Word refuses
   the file without it
5. the whole `<w:r>` run holding the marker is replaced by a `<w:drawing>`
   pointing at that relationship, so the marker's own formatting goes with it

Any marker with no image supplied is stripped, so an unfilled slot prints as an
empty signature line rather than leaking `[[ANCHORSIG:…]]` into an agreement.
`tests/signature.test.mjs` covers each step, including the ids being unique and
the content type being declared.

Signatures are stored as PNGs — a JPEG has no transparent background and prints
as a white box over the line it sits on, so an upload that is not a PNG is
converted and the person is told why. They are placed 2 cm tall, capped at 5 cm
wide.

---

## Two things this changes from the build brief

**Firebase instead of Supabase.** The brief recommends Supabase (§2) and flags
that free Postgres projects pause after inactivity. Firestore has no idle-pause,
which removes that specific risk. What it costs: row-level security becomes
security *rules* — a language you write and test rather than SQL policies. The
rules file is commented throughout for that reason. Firebase's free Spark plan
has no cost ceiling to breach because it simply stops serving when a daily quota
is used up; check the current numbers on Firebase's pricing page, since they
change.

**"No backend" only holds to phase 6.** BLANKCO needs no server because it
prints to PDF. Two parts of the PTAA scope cannot work that way:

- **Document generation (phase 5).** Brief §2 rules out generating the PTAA as
  HTML — it has to be placeholder-filling into the real per-condo `.docx` so the
  formatting, tables and page numbering survive. `docxtemplater` has a browser
  build, so this may still be possible client-side. Worth prototyping early:
  §15 moved template handling to phase 4 precisely so this surfaces in week two.
- **Drive upload (phase 11).** Brief §4.2 requires a refresh token for the one
  designated company account, held server-side. A browser cannot hold that
  secret. This needs one small function — a Cloudflare Worker alongside the
  Pages site would do it, and stays on the free tier.

Neither blocks phases 1–4. Both are decisions to make before phase 5, along
with the §4.3 Drive authorisation choice that is still open.
