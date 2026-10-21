// Stand-in for ../../config.js while running harness.html.
// The import map in harness.html points "../config.js" here, so the real
// config (and whatever is or is not pasted into it) never affects the tests.

export const firebaseConfig = {
  apiKey: "test-key",
  authDomain: "ptaa-test.firebaseapp.com",
  projectId: "ptaa-test",
  storageBucket: "ptaa-test.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:test",
};

export const company = {
  name: "Test Realty Sdn. Bhd.",
  systemName: "PTAA Workflow System",
  supportContact: "admin@test.example",
  logoUrl: "",
};
