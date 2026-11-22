const http = require("http");
const fs = require("fs");
const path = require("path");
require("./lib/env").loadEnv();
const { openDb } = require("./lib/db");
const { createHandler } = require("./lib/handler");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// Images and card data rarely change, so browsers keep them for a week instead of asking again on
// every page view (a table can show hundreds of icons). Same rule as vercel.json. Everything else,
// including the versioned app.js and style.css, is checked on each load.
const LONG_CACHE = "public, max-age=604800, stale-while-revalidate=86400";
const cacheControl = (rel) =>
  rel.startsWith("img/") || rel === "card-info.json" ? LONG_CACHE : "no-cache";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://*.googletagmanager.com; img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://*.g.doubleclick.net https://*.google.com; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.g.doubleclick.net https://*.google.com; frame-ancestors 'none'",
};

async function start() {
  const db = await openDb();
  const handleApi = createHandler(db);
  const server = http.createServer(async (req, res) => {
    if (await handleApi(req, res)) return;
    const url = new URL(req.url, "http://localhost");
    const rel =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(PUBLIC, rel);
    const stat = file.startsWith(`${PUBLIC}${path.sep}`)
      ? await fs.promises.stat(file).catch(() => null)
      : null;
    if (!stat || stat.isDirectory()) {
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": cacheControl(rel.replace(/\\/g, "/")),
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(PORT, HOST, () =>
    console.log(`STS2 TRACKER running at http://localhost:${PORT}`),
  );
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
