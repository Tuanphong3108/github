/** Helper GitHub dùng chung cho mọi nhóm tool: client REST, mã hoá đường dẫn, schema chung. */
import { cfg } from "./config.js";

/**
 * Gọi GitHub REST API. Trả JSON đã parse (hoặc text nếu phản hồi không phải JSON, vd. diff/log).
 * opts: { accept, base, raw (body nhị phân), contentType }
 */
export async function gh(token, method, path, body, opts = {}) {
  const raw = opts.raw !== undefined;
  const res = await fetch((opts.base || cfg.ghApi) + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: opts.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-server",
      ...(raw ? { "Content-Type": opts.contentType || "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? opts.raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && typeof data === "object" ? data.message || JSON.stringify(data) : text || res.statusText;
    throw Object.assign(new Error(`GitHub API ${res.status} on ${method} ${path.split("?")[0]}: ${detail}`), { status: res.status, data });
  }
  return data;
}

export const ep = (p) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
export const qs = (o) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
export const R = (a) => `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
export const cleanPath = (p) => String(p).replace(/^\/+/, "");
export const toB64 = (content, encoding) =>
  encoding === "base64" ? String(content).replace(/\s+/g, "") : Buffer.from(String(content), "utf8").toString("base64");

export function need(a, ...keys) {
  const miss = keys.filter((k) => a[k] === undefined || a[k] === null || a[k] === "");
  if (miss.length) throw new Error(`Missing required argument(s): ${miss.join(", ")}`);
}

export async function defaultBranch(t, a) {
  const r = await gh(t, "GET", R(a));
  return r.default_branch;
}

/** SHA đầu branch, null nếu branch chưa tồn tại. */
export async function branchHead(t, a, branch) {
  try {
    const r = await gh(t, "GET", `${R(a)}/git/ref/heads/${ep(branch)}`);
    return r.object.sha;
  } catch (e) {
    if (e.status === 404) return null;
    if (e.status === 409) throw new Error("Repository is empty. Create the first file with create_file, then use commit_changes/push_changes.");
    throw e;
  }
}

export async function pushRef(t, a, branch, sha, force) {
  const head = await branchHead(t, a, branch);
  try {
    if (head) {
      await gh(t, "PATCH", `${R(a)}/git/refs/heads/${ep(branch)}`, { sha, force: !!force });
      return { created: false };
    }
    await gh(t, "POST", `${R(a)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    return { created: true };
  } catch (e) {
    if (e.status === 422 && /fast.?forward/i.test(e.message)) {
      throw new Error(`Push rejected: not a fast-forward (branch "${branch}" moved). Re-run commit_changes on top of the current head, or pass force=true to overwrite.`);
    }
    throw e;
  }
}

/* ---- tiện ích rút gọn dữ liệu cho gọn token ---- */
export const login = (x) => x?.login ?? null;
export const logins = (arr) => (arr || []).map((x) => x.login);
export const labelNames = (arr) => (arr || []).map((l) => (typeof l === "string" ? l : l.name));
export const pageQ = (a, def = 30) => ({
  per_page: Math.min(Math.max(Number(a.per_page) || def, 1), 100),
  page: Math.max(Number(a.page) || 1, 1),
});
export const clipText = (s, max) => {
  const str = String(s ?? "");
  return str.length > max ? `${str.slice(0, max)}\n…(truncated, ${str.length - max} more chars)` : str;
};

/* ---- schema dùng chung ---- */
export const OWNER = { type: "string", description: "Repository owner (user or organization), e.g. Tuanphong3108" };
export const REPO = { type: "string", description: "Repository name, e.g. github" };
export const BRANCH = { type: "string", description: "Branch name. Defaults to the repository's default branch." };
export const ENCODING = { type: "string", enum: ["utf-8", "base64"], description: "How `content` is encoded. Use base64 for binary files. Default utf-8." };
export const PAGE_PROPS = {
  per_page: { type: "integer", description: "1-100, default 30." },
  page: { type: "integer", description: "Page number, default 1." },
};

export const tool = (name, description, properties, required, handler, annotations = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
  annotations,
  handler,
});

/** Chấp nhận mảng hoặc chuỗi "a,b,c" (Gemini đôi khi gửi chuỗi thay vì mảng). */
export const arr = (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : String(v).split(",").map((s) => s.trim()).filter(Boolean));

/** Chấp nhận object hoặc chuỗi JSON. */
export const obj = (v, name = "value") => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    throw new Error(`\`${name}\` must be an object (or a valid JSON string).`);
  }
};

/** Chỉ lấy các key được truyền (khác undefined) từ `a`. */
export const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
