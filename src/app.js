/**
 * Lõi dùng chung của GitHub MCP server: MCP (Streamable HTTP, stateless) + OAuth 2.0 proxy.
 * Chỉ dùng Web API chuẩn (Request/Response/fetch) + node:crypto nên chạy được trên
 * Node >= 20 (server.js) và Cloudflare Workers với nodejs_compat (worker.js).
 *
 * State/auth code/access token đều là blob mã hoá AES-256-GCM, không cần DB.
 */
import crypto from "node:crypto";
import { ICON_SVG, ICON_PNG_B64, ICON_ICO_B64 } from "./icons.js";
import { cfg, KEY, configure, getConfig } from "./config.js";
import { getTools } from "./tools/index.js";

export { configure, getConfig };

const SERVER_INFO = { name: "github-remote-repository", title: "Github Remote Repository", version: "1.6.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/* ------------------------------------------------------------------ sealing */
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

function unseal(s, type) {
  try {
    const b = Buffer.from(String(s), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const o = JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"));
    if (o.t !== type) return null;
    if (o.exp && o.exp < Date.now()) return null;
    return o;
  } catch {
    return null;
  }
}

const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/* --------------------------------------------------------------- http utils */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

const jres = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...headers } });
const plain = (status, headers = {}) => new Response(null, { status, headers: { ...CORS, ...headers } });
const redirect = (url) => new Response(null, { status: 302, headers: { ...CORS, Location: url, "Cache-Control": "no-store" } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const errorPage = (status, msg) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Lỗi</title><body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px"><h2>Không thể tiếp tục</h2><p>${esc(msg)}</p></body>`,
    { status, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } },
  );

async function readText(request, limit = 8 * 1024 * 1024) {
  const t = await request.text();
  if (t.length > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
  return t;
}

const baseUrl = (request) => cfg.publicUrl || new URL(request.url).origin;

/* ------------------------------------------------------------ tool registry */
let toolCache = { sig: null, list: [], map: new Map() };
function tools() {
  const sig = cfg.toolGroups.join(",");
  if (toolCache.sig !== sig) {
    const list = getTools(cfg.toolGroups);
    toolCache = { sig, list, map: new Map(list.map((x) => [x.name, x])) };
  }
  return toolCache;
}

const MAX_OUT = 250_000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n…(output truncated)" : s);

async function callTool(name, args, token) {
  const t = tools().map.get(name);
  if (!t) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const r = await t.handler(args || {}, token);
    if (r && r._blocks) return { content: r._blocks.map((b) => ({ ...b, text: clip(b.text) })) };
    return { content: [{ type: "text", text: clip(typeof r === "string" ? r : JSON.stringify(r, null, 2)) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
  }
}

/* --------------------------------------------------------------- MCP JSON-RPC */
async function handleRpc(msg, token, base) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  const isNote = !("id" in msg);
  const ok = (result) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => (isNote ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          ...SERVER_INFO,
          icons: [
            { src: `${base}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
            { src: `${base}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
          ],
        },
        instructions:
          "GitHub tools. Files/commits: create_file/update_file/delete_file commit straight to a branch; for multi-file changes use commit_changes then push_changes; browse history with list_commits/get_commit. Issues & pull requests: create_issue, update_issue (close/label/assign), create_pull_request, create_pull_request_review, merge_pull_request. Actions & releases: list_workflow_runs, list_run_jobs, get_job_logs (read failures), rerun_workflow, dispatch_workflow, create_release, upload_release_asset. Admin: webhooks, branch protection/rulesets, security alerts, repo settings. Ask for confirmation before destructive actions (merge, delete, force push, settings changes).",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools().list.map(({ handler, ...rest }) => rest) });
    case "tools/call": {
      if (!msg.params?.name) return fail(-32602, "Missing tool name");
      console.log(`[mcp] tools/call ${msg.params.name}`);
      return ok(await callTool(msg.params.name, msg.params.arguments, token));
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function bearer(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m) return null;
  const tok = m[1].trim();
  if (tok.startsWith("mcp_")) {
    const o = unseal(tok.slice(4), "tok");
    return o ? o.gh : null;
  }
  return tok; // cho phép dùng thẳng GitHub token (PAT / gho_) khi test
}

async function handleMcp(request) {
  const base = baseUrl(request);
  const token = bearer(request);
  if (!token) {
    return jres(401, { error: "unauthorized", error_description: "Bearer token required" }, {
      "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
  }
  let payload;
  try {
    payload = JSON.parse(await readText(request));
  } catch (e) {
    if (e.status === 413) return jres(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Body too large" } });
    return jres(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handleRpc(m, token, base)))).filter(Boolean);
    return out.length ? jres(200, out) : plain(202);
  }
  const out = await handleRpc(payload, token, base);
  return out ? jres(200, out) : plain(202);
}

/* --------------------------------------------------------------------- OAuth */
function redirectAllowed(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return false;
  if (cfg.allowedRedirects.length) return cfg.allowedRedirects.some((p) => uri.startsWith(p));
  return true;
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  return u.toString();
}

function metadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: cfg.scopes.split(/[ ,]+/).filter(Boolean),
  };
}

function handleAuthorize(request, url) {
  const p = url.searchParams;
  if (p.get("client_id") !== cfg.clientId) return errorPage(400, "client_id không hợp lệ.");
  const ru = p.get("redirect_uri");
  if (!ru || !redirectAllowed(ru)) return errorPage(400, "redirect_uri không hợp lệ hoặc không nằm trong ALLOWED_REDIRECT_URIS.");
  if (p.get("response_type") !== "code") return redirect(withParams(ru, { error: "unsupported_response_type", state: p.get("state") ?? undefined }));
  const txn = seal({
    t: "txn",
    ru,
    st: p.get("state") ?? null,
    cc: p.get("code_challenge") || null,
    ccm: p.get("code_challenge_method") || "plain",
    exp: Date.now() + 10 * 60_000,
  });
  const gUrl = new URL(`${cfg.ghWeb}/login/oauth/authorize`);
  gUrl.searchParams.set("client_id", cfg.ghClientId);
  gUrl.searchParams.set("redirect_uri", `${baseUrl(request)}/oauth/callback`);
  gUrl.searchParams.set("scope", cfg.scopes);
  gUrl.searchParams.set("state", txn);
  gUrl.searchParams.set("allow_signup", "false");
  return redirect(gUrl.toString());
}

async function handleCallback(request, url) {
  const p = url.searchParams;
  const txn = unseal(p.get("state") || "", "txn");
  if (!txn) return errorPage(400, "State không hợp lệ hoặc đã hết hạn. Hãy kết nối lại từ Gemini.");
  const back = (params) => redirect(withParams(txn.ru, { ...params, state: txn.st ?? undefined }));
  if (p.get("error")) return back({ error: p.get("error") === "access_denied" ? "access_denied" : "server_error", error_description: p.get("error_description") || undefined });
  const code = p.get("code");
  if (!code) return back({ error: "invalid_request" });

  let tokenRes;
  try {
    const r = await fetch(`${cfg.ghWeb}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "github-mcp-server" },
      body: JSON.stringify({ client_id: cfg.ghClientId, client_secret: cfg.ghClientSecret, code, redirect_uri: `${baseUrl(request)}/oauth/callback` }),
    });
    tokenRes = await r.json();
  } catch (e) {
    console.error("[oauth] github token exchange failed:", e.message);
    return back({ error: "server_error", error_description: "GitHub token exchange failed" });
  }
  if (!tokenRes.access_token) {
    console.error("[oauth] github error:", tokenRes.error);
    return back({ error: "access_denied", error_description: tokenRes.error_description || tokenRes.error || "GitHub did not return a token" });
  }
  const ourCode = seal({ t: "code", gh: tokenRes.access_token, ru: txn.ru, cc: txn.cc, ccm: txn.ccm, exp: Date.now() + 5 * 60_000 });
  return back({ code: ourCode });
}

async function handleToken(request) {
  const raw = await readText(request, 64 * 1024);
  const ct = String(request.headers.get("content-type") || "");
  const nostore = { "Cache-Control": "no-store", Pragma: "no-cache" };
  let body = {};
  try {
    body = ct.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return jres(400, { error: "invalid_request" }, nostore);
  }
  let id = body.client_id;
  let secret = body.client_secret;
  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (basic) {
    const [i, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
    id = decodeURIComponent(i);
    secret = decodeURIComponent(rest.join(":"));
  }
  if (!id || !secret || !safeEq(id, cfg.clientId) || !safeEq(secret, cfg.clientSecret)) {
    return jres(401, { error: "invalid_client" }, nostore);
  }

  const issue = (ghToken) => {
    const tok = "mcp_" + seal({ t: "tok", gh: ghToken });
    return jres(200, { access_token: tok, token_type: "Bearer", scope: cfg.scopes.replace(/\s+/g, " "), refresh_token: tok }, nostore);
  };

  if (body.grant_type === "authorization_code") {
    const c = unseal(body.code || "", "code");
    if (!c) return jres(400, { error: "invalid_grant", error_description: "Code invalid or expired" }, nostore);
    if (body.redirect_uri && body.redirect_uri !== c.ru) return jres(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" }, nostore);
    if (c.cc) {
      const v = body.code_verifier;
      const calc = c.ccm === "S256" ? crypto.createHash("sha256").update(String(v || "")).digest("base64url") : v;
      if (!v || !safeEq(calc, c.cc)) return jres(400, { error: "invalid_grant", error_description: "PKCE verification failed" }, nostore);
    }
    return issue(c.gh);
  }
  if (body.grant_type === "refresh_token") {
    const r = unseal(String(body.refresh_token || "").replace(/^mcp_/, ""), "tok");
    if (!r) return jres(400, { error: "invalid_grant" }, nostore);
    return issue(r.gh);
  }
  return jres(400, { error: "unsupported_grant_type" }, nostore);
}

/* --------------------------------------------------------------------- icons */
const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
let iconBin = null;
const icons = () => (iconBin ||= { png: fromB64(ICON_PNG_B64), ico: fromB64(ICON_ICO_B64) });
const ICON_HEADERS = { ...CORS, "Cache-Control": "public, max-age=86400" };
const iconRes = (body, type) => new Response(body, { status: 200, headers: { ...ICON_HEADERS, "Content-Type": type } });

function landingPage(base) {
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(SERVER_INFO.title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32 64x64"><link rel="apple-touch-icon" href="/icon.png">
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;text-align:center">
<img src="/icon.png" width="96" height="96" alt="" style="border-radius:22px">
<h1 style="font-size:1.4rem">${esc(SERVER_INFO.title)}</h1>
<p>MCP endpoint:<br><code>${esc(base)}/mcp</code></p></body></html>`;
}

/* -------------------------------------------------------------------- router */
/** Xử lý 1 Request chuẩn Web, trả Response. Gọi configure(env) trước. */
export async function handle(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    if (method === "OPTIONS") return plain(204);

    if (path === "/" && (request.headers.get("accept") || "").includes("text/html"))
      return new Response(landingPage(baseUrl(request)), { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });
    if (method === "GET" && path === "/favicon.ico") return iconRes(icons().ico, "image/x-icon");
    if (method === "GET" && path === "/favicon.svg") return iconRes(ICON_SVG, "image/svg+xml");
    if (method === "GET" && (path === "/icon.png" || path === "/apple-touch-icon.png")) return iconRes(icons().png, "image/png");
    if (path === "/" || path === "/health") return jres(200, { ok: true, name: SERVER_INFO.name, mcp: `${baseUrl(request)}/mcp` });
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return jres(200, metadata(baseUrl(request)));
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      const b = baseUrl(request);
      return jres(200, { resource: `${b}/mcp`, authorization_servers: [b], bearer_methods_supported: ["header"] });
    }
    if (path === "/authorize" && method === "GET") return handleAuthorize(request, url);
    if (path === "/oauth/callback" && method === "GET") return await handleCallback(request, url);
    if (path === "/token" && method === "POST") return await handleToken(request);
    if (path === "/mcp") {
      if (method === "POST") return await handleMcp(request);
      return plain(405, { Allow: "POST, OPTIONS" });
    }
    return jres(404, { error: "not_found" });
  } catch (e) {
    console.error("[server]", e);
    return jres(e.status || 500, { error: "server_error" });
  }
}
