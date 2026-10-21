// ---------------------------------------------------------------------------
// PTAA Workflow System — configuration
//
// This is the ONLY file you need to edit to get the app running.
//
// Everything in here ships to the browser and is publicly readable. That is
// normal and correct for a Firebase web app — these values identify your
// project, they do not authorise access to it. Access is controlled entirely
// by the Firestore security rules in firestore.rules.
// See README.md → "Is it safe that my Firebase keys are in the page?"
// ---------------------------------------------------------------------------

// From Firebase console → Settings → General → Your apps (Firebase project
// "ptaa-60427", registered 28 Aug 2026).
export const firebaseConfig = {
  apiKey:            "AIzaSyByRfZ2qr8UgxhyysWqR3Pg0DHpd_3liFY",
  authDomain:        "ptaa-60427.firebaseapp.com",
  projectId:         "ptaa-60427",
  storageBucket:     "ptaa-60427.firebasestorage.app",
  messagingSenderId: "239053774645",
  appId:             "1:239053774645:web:16c664bf6194edc5db367c",
};

export const company = {
  // Shown in the header and on the sign-in screen.
  name: "The Blank Company",

  // The product name. Also becomes the browser tab title.
  systemName: "Anchor",

  // Shown on the "not on the approved list" screen so a refused agent knows
  // who to contact. Use a real address — this is the only way they get in.
  supportContact: "afiqahsyasya15@gmail.com",

  // Optional. Drop a file at assets/logo.png and set this to "assets/logo.png".
  // Leave as "" and the header shows the company name as text instead.
  logoUrl: "",
};

// How the app runs.
//
//   solo: true   One person does everything: start the PTAA, draft the Word
//                agreement and the Excel invoice, edit and print them, then
//                upload the confirmed files and file them to Google Drive.
//                Sales Agents are a list to pick from, not accounts.
//
//   solo: false  The full team workflow — agents sign in and submit requests,
//                the admin reviews, releases, tracks signatures and completes.
//
// Switching back and forth is safe: nothing is deleted either way.
export const workflow = {
  solo: true,
};

// The Firebase SDK version is pinned at the top of js/core.js (one line, three
// import URLs). Bump it there if you ever need a newer SDK.
