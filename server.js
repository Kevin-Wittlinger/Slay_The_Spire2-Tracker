const http = require("http");
const fs = require("fs");
const path = require("path");
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
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
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
    if (
      !file.startsWith(`${PUBLIC}${path.sep}`) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    ) {
      res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-cache",
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
