// Minimal static server for compile-demo/output/preview (node builtins only). Local machine only.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { PORT, PREVIEW_OUT } from "./paths.mjs";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".xml": "text/xml", ".png": "image/png", ".json": "application/json" };

export function startServer({ port = PORT, root = PREVIEW_OUT, quiet = false } = {}) {
  return new Promise((resolveP, reject) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^([/\\])+/, "");
      const file = join(root, rel);
      if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const url = `http://localhost:${server.address().port}/`;
      if (!quiet) console.log(`Form preview: ${url}  (Ctrl+C to stop)`);
      resolveP({ server, url });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(join(PREVIEW_OUT, "index.html"))) {
    console.error("No preview built yet: run `npm run compile:preview` from Backend.");
    process.exit(1);
  }
  await startServer();
}
