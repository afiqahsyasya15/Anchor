// Static check: a module that USES one of our own exported names but never
// imports or declares it. Caught a real bug — `table(...)` called in a file
// that had not imported it, which only showed up as a blank screen.
//
//   node tests/check-undeclared.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;   // the project root
const FILES = [
  "js/validate.js", "js/model.js", "js/images.js", "js/core.js", "js/ui.js",
  "js/auth.js", "js/chunks.js", "js/docx.js", "js/placeholders.js",
  "js/templates.js", "js/notifications.js", "js/requests.js",
  "js/screens.js", "js/screens-request.js", "js/screens-queue.js",
  "js/screens-templates.js", "js/screens-notifications.js", "js/app.js",
];

// Every name any of our own modules exports. If one of these appears as a bare
// identifier in a file that neither imports nor defines it, that is the bug.
const exported = new Set();
for (const f of FILES) {
  const code = readFileSync(join(ROOT, f), "utf8");
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) exported.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim(); if (!t) continue;
      exported.add((t.split(/\s+as\s+/)[1] || t).trim());
    }
  }
}

function addParams(list, known) {
  for (const part of String(list).split(",")) {
    const t = part.trim().replace(/^\.\.\./, "").split(/[:=]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) known.add(t);
  }
}

let problems = 0;
for (const f of FILES) {
  const code = readFileSync(join(ROOT, f), "utf8");

  const known = new Set();
  for (const m of code.matchAll(/^import\s*\{([^}]*)\}\s*from/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim(); if (!t) continue;
      known.add((t.split(/\s+as\s+/).pop()).trim());
    }
  }
  for (const m of code.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gm)) known.add(m[1]);
  // Anything declared locally, at any depth.
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) known.add(m[1]);
  // Destructured locals and parameters are noisy to parse; treat any name that
  // appears on the left of a destructure as known.
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split(/[:=]/)[0].trim();
      if (t) known.add(t);
    }
  }
  // Function parameters. Only these two shapes, so a call like foo(table) is
  // not mistaken for a parameter list and does not weaken the check.
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) addParams(m[1], known);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) addParams(m[1], known);

  const reexports = /export\s*\*\s*from/.test(code);

  // Strip strings and comments so text inside them is not mistaken for code.
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");

  for (const name of exported) {
    if (known.has(name)) continue;
    if (reexports) continue;
    // Used as a call, or as a bare value in an expression position.
    const used = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, "m").test(stripped);
    if (used) {
      console.log(`✗ ${f} uses ${name}() but neither imports nor defines it`);
      problems++;
    }
  }
}

console.log(problems === 0 ? "✓ no undeclared uses of our own exports" : `${problems} problem(s)`);
process.exit(problems ? 1 : 0);
