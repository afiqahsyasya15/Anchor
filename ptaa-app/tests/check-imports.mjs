// Static check: every named import resolves to something the target module
// actually exports.
//
//   node tests/check-imports.mjs
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;   // the project root
// Discovered rather than listed, so a new module is covered the moment it
// exists — an out-of-date list here was how a missing export reached the app.
const files = ["config.js", ...readdirSync(join(ROOT, "js"))
  .filter(n => n.endsWith(".js"))
  .sort()
  .map(n => "js/" + n)]
  .filter(f => { try { readFileSync(join(ROOT, f)); return true; } catch { return false; } });

const src = Object.fromEntries(files.map(f => [f, readFileSync(join(ROOT, f), "utf8")]));

function exportsOf(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const code = src[file];
  if (!code) return new Set();
  const out = new Set();

  // export const/function/class NAME
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  // export { a, b as c }  (not a re-export from)
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}\s*(?!from)/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim(); if (!t) continue;
      out.add((t.split(/\s+as\s+/)[1] || t).trim());
    }
  }
  // export { a } from './x'
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim(); if (!t) continue;
      out.add((t.split(/\s+as\s+/)[1] || t).trim());
    }
  }
  // export * from './x'
  for (const m of code.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = norm(file, m[1]);
    if (target) for (const n of exportsOf(target, seen)) out.add(n);
  }
  return out;
}

function norm(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const p = resolve("/" + dirname(fromFile), spec).slice(1);
  return files.includes(p) ? p : null;
}

// Names that come from the Firebase CDN and are re-exported by core.js.
const CDN_RE = /^https:\/\//;
let problems = 0;

for (const file of files) {
  const code = src[file];
  for (const m of code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
    const spec = m[2];
    if (CDN_RE.test(spec)) continue;                 // remote module, cannot check
    const target = norm(file, spec);
    if (!target) { console.log(`? ${file}: cannot resolve ${spec}`); problems++; continue; }
    const avail = exportsOf(target);
    // core.js re-exports CDN names via an `export { ... }` block, already captured.
    for (const part of m[1].split(",")) {
      const t = part.trim(); if (!t) continue;
      const name = t.split(/\s+as\s+/)[0].trim();
      if (!avail.has(name)) {
        console.log(`✗ ${file} imports { ${name} } from ${spec} — not exported there`);
        problems++;
      }
    }
  }
}

console.log(problems === 0 ? "✓ all named imports resolve" : `${problems} problem(s)`);
process.exit(problems ? 1 : 0);
