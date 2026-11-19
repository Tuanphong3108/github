/**
 * Cấu hình (nạp từ process.env hoặc env binding của Cloudflare Workers).
 * `cfg` và `KEY` là live binding: sau configure() mọi module import đều thấy giá trị mới.
 */
import crypto from "node:crypto";

export let cfg = null;
export let KEY = null;
let cfgSig = "";

const REQUIRED = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "MCP_CLIENT_ID", "MCP_CLIENT_SECRET"];
const OPTIONAL = [
  "SESSION_SECRET",
  "PUBLIC_URL",
  "GITHUB_API_URL",
  "GITHUB_WEB_URL",
  "GITHUB_UPLOADS_URL",
  "GITHUB_SCOPES",
  "ALLOWED_REDIRECT_URIS",
  "TOOL_GROUPS",
  "PORT",
];

export const DEFAULT_SCOPES = "repo";

/** Nạp cấu hình từ một object env. Ném lỗi nếu thiếu biến bắt buộc. */
export function configure(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  const sig = [...REQUIRED, ...OPTIONAL].map((k) => env[k] ?? "").join("\u0000");
  if (sig === cfgSig) return cfg;
  cfg = {
    port: Number(env.PORT || 3000),
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
    ghApi: (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, ""),
    ghWeb: (env.GITHUB_WEB_URL || "https://github.com").replace(/\/+$/, ""),
    ghUploads: (env.GITHUB_UPLOADS_URL || "https://uploads.github.com").replace(/\/+$/, ""),
    ghClientId: env.GITHUB_CLIENT_ID,
    ghClientSecret: env.GITHUB_CLIENT_SECRET,
    clientId: env.MCP_CLIENT_ID,
    clientSecret: env.MCP_CLIENT_SECRET,
    scopes: env.GITHUB_SCOPES || DEFAULT_SCOPES,
    allowedRedirects: (env.ALLOWED_REDIRECT_URIS || "").split(",").map((s) => s.trim()).filter(Boolean),
    toolGroups: (env.TOOL_GROUPS || "all").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
  KEY = crypto.createHash("sha256").update(`github-mcp|${env.SESSION_SECRET || ""}|${cfg.clientSecret}`).digest();
  cfgSig = sig;
  return cfg;
}

export const getConfig = () => cfg;
