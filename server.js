#!/usr/bin/env node
/**
 * Entry point Node.js (Render, Railway, Fly, Docker, chạy local + tunnel…).
 * Toàn bộ logic nằm ở src/app.js; file này chỉ chuyển http.IncomingMessage <-> Request/Response.
 * Cần Node >= 20, không có dependency ngoài.
 */
import http from "node:http";
import { configure, handle } from "./src/app.js";

let cfg;
try {
  cfg = configure(process.env);
} catch (e) {
  console.error(`${e.message}\nXem README.md (chạy "npm run gen-creds" để sinh MCP_CLIENT_ID/SECRET).`);
  process.exit(1);
}

const MAX_BODY = 8 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c);
    }
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || `localhost:${cfg.port}`).split(",")[0].trim();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (["content-length", "transfer-encoding", "connection"].includes(k)) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    const request = new Request(`${proto}://${host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });

    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "server_error" }));
  }
});

server.listen(cfg.port, () => {
  const base = cfg.publicUrl || `http://localhost:${cfg.port}`;
  console.log(`GitHub MCP server listening on :${cfg.port}`);
  console.log(`MCP endpoint : ${base}/mcp`);
  console.log(`GitHub callback URL (đăng ký trong OAuth App): ${base}/oauth/callback`);
});
