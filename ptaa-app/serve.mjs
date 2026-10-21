// ---------------------------------------------------------------------------
// A minimal static file server, so the app can be previewed locally.
//
//   node serve.mjs           → http://localhost:5173
//   node serve.mjs 8080      → a different port
//
// No dependencies and nothing to install — it uses only what ships with
// Node.js. start-local.bat runs this for you.
//
// Google sign-in refuses to work from a file:// page, which is the only reason
// a server is needed at all. Firebase authorises "localhost" on any port.
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".md":    "text/plain; charset=utf-8",
  ".rules": "text/plain; charset=utf-8",
};

const server = createServer(async (req, res) => {
  let target = "";
  try {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    target = join(ROOT, normalize(pathname));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("403 Forbidden");
      return;
    }

    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
      // Never cache during development, so an edit shows up on refresh.
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
       .end("404 Not Found\n\n" + req.url);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Something else is serving on it — close that window, or run:`);
    console.error(`      node serve.mjs 5174\n`);
  } else {
    console.error("\n  Could not start the server:", err.message, "\n");
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n  Serving: ${ROOT}`);
  console.log(`  Open:    http://localhost:${PORT}`);
  console.log(`\n  Leave this window open. Press Ctrl+C to stop.\n`);
});
