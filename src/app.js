/**
 * Lõi dùng chung của GitHub MCP server: MCP (Streamable HTTP, stateless) + OAuth 2.0 proxy.
 * Chỉ dùng Web API chuẩn (Request/Response/fetch) + node:crypto nên chạy được trên
 * Node >= 20 (server.js) và Cloudflare Workers với nodejs_compat (worker.js).
 *
 * State/auth code/access token đều là blob mã hoá AES-256-GCM, không cần DB.
 */
import crypto from "node:crypto";

/* ------------------------------------------------------------------ config */
let cfg = null;
let KEY = null;
let cfgSig = "";

const REQUIRED = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "MCP_CLIENT_ID", "MCP_CLIENT_SECRET"];
const OPTIONAL = ["SESSION_SECRET", "PUBLIC_URL", "GITHUB_API_URL", "GITHUB_WEB_URL", "GITHUB_SCOPES", "ALLOWED_REDIRECT_URIS", "PORT"];

/** Nạp cấu hình từ một object env (process.env hoặc env binding của Workers). */
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
    ghClientId: env.GITHUB_CLIENT_ID,
    ghClientSecret: env.GITHUB_CLIENT_SECRET,
    clientId: env.MCP_CLIENT_ID,
    clientSecret: env.MCP_CLIENT_SECRET,
    scopes: env.GITHUB_SCOPES || "repo",
    allowedRedirects: (env.ALLOWED_REDIRECT_URIS || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  KEY = crypto.createHash("sha256").update(`github-mcp|${env.SESSION_SECRET || ""}|${cfg.clientSecret}`).digest();
  cfgSig = sig;
  return cfg;
}
export const getConfig = () => cfg;

const SERVER_INFO = { name: "github-remote-repository", title: "Github Remote Repository", version: "1.1.1" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

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

/* ------------------------------------------------------------- GitHub client */
async function gh(token, method, path, body) {
  const res = await fetch(cfg.ghApi + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-server",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

const ep = (p) => String(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
const qs = (o) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};
const R = (a) => `/repos/${encodeURIComponent(a.owner)}/${encodeURIComponent(a.repo)}`;
const cleanPath = (p) => String(p).replace(/^\/+/, "");
const toB64 = (content, encoding) =>
  encoding === "base64" ? String(content).replace(/\s+/g, "") : Buffer.from(String(content), "utf8").toString("base64");

function need(a, ...keys) {
  const miss = keys.filter((k) => a[k] === undefined || a[k] === null || a[k] === "");
  if (miss.length) throw new Error(`Missing required argument(s): ${miss.join(", ")}`);
}

async function defaultBranch(t, a) {
  const r = await gh(t, "GET", R(a));
  return r.default_branch;
}

/** SHA đầu branch, null nếu branch chưa tồn tại. */
async function branchHead(t, a, branch) {
  try {
    const r = await gh(t, "GET", `${R(a)}/git/ref/heads/${ep(branch)}`);
    return r.object.sha;
  } catch (e) {
    if (e.status === 404) return null;
    if (e.status === 409) throw new Error("Repository is empty. Create the first file with create_file, then use commit_changes/push_changes.");
    throw e;
  }
}

async function pushRef(t, a, branch, sha, force) {
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

/* -------------------------------------------------------------------- tools */
const OWNER = { type: "string", description: "Repository owner (user or organization), e.g. Tuanphong3108" };
const REPO = { type: "string", description: "Repository name, e.g. github" };
const BRANCH = { type: "string", description: "Branch name. Defaults to the repository's default branch." };
const ENCODING = { type: "string", enum: ["utf-8", "base64"], description: "How `content` is encoded. Use base64 for binary files. Default utf-8." };

const tool = (name, description, properties, required, handler, annotations = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties, required },
  annotations,
  handler,
});

const TOOLS = [
  tool(
    "list_repos",
    "List GitHub repositories the authenticated user can access (own, collaborator, organization). Optionally list the repos of one organization.",
    {
      org: { type: "string", description: "If set, list repositories of this organization instead." },
      type: { type: "string", enum: ["all", "owner", "member", "public", "private"], description: "Filter (for org: all/public/private). Default all." },
      sort: { type: "string", enum: ["created", "updated", "pushed", "full_name"], description: "Default pushed." },
      per_page: { type: "integer", description: "1-100, default 30." },
      page: { type: "integer", description: "Page number, default 1." },
    },
    [],
    async (a, t) => {
      const common = { sort: a.sort || "pushed", per_page: Math.min(a.per_page || 30, 100), page: a.page || 1 };
      const data = a.org
        ? await gh(t, "GET", `/orgs/${encodeURIComponent(a.org)}/repos${qs({ ...common, type: a.type })}`)
        : await gh(t, "GET", `/user/repos${qs({ ...common, affiliation: "owner,collaborator,organization_member", type: a.type === "owner" || a.type === "member" || a.type === "all" ? undefined : a.type })}`);
      return data.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
        description: r.description,
        pushed_at: r.pushed_at,
        permissions: r.permissions,
        html_url: r.html_url,
      }));
    },
    { readOnlyHint: true },
  ),

  tool(
    "list_files",
    "Browse the file tree of a repository. Lists one directory, or the whole tree below `path` when recursive=true.",
    {
      owner: OWNER,
      repo: REPO,
      path: { type: "string", description: "Directory path, empty for repo root." },
      ref: { type: "string", description: "Branch, tag or commit SHA. Defaults to the default branch." },
      recursive: { type: "boolean", description: "List all files below path (default false)." },
      max_entries: { type: "integer", description: "Cap for recursive listing, default 2000." },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const prefix = (a.path || "").replace(/^\/+|\/+$/g, "");
      if (!a.recursive) {
        const data = await gh(t, "GET", `${R(a)}/contents${prefix ? "/" + ep(prefix) : ""}${qs({ ref: a.ref })}`);
        const map = (i) => ({ name: i.name, path: i.path, type: i.type === "dir" ? "dir" : i.type, size: i.size, sha: i.sha });
        return Array.isArray(data) ? data.map(map) : map(data);
      }
      const ref = a.ref || (await defaultBranch(t, a));
      const c = await gh(t, "GET", `${R(a)}/commits/${ep(ref)}`);
      const tree = await gh(t, "GET", `${R(a)}/git/trees/${c.commit.tree.sha}?recursive=1`);
      let items = tree.tree;
      if (prefix) items = items.filter((i) => i.path === prefix || i.path.startsWith(prefix + "/"));
      const cap = a.max_entries || 2000;
      return {
        ref,
        commit: c.sha,
        truncated: !!tree.truncated || items.length > cap,
        total: items.length,
        entries: items.slice(0, cap).map((i) => ({ path: i.path, type: i.type === "tree" ? "dir" : "file", size: i.size, sha: i.sha })),
      };
    },
    { readOnlyHint: true },
  ),

  tool(
    "read_file",
    "Read a file's content from a repository (text returned as-is; binary files return metadata unless as_base64=true). Also returns the blob sha needed for update/delete.",
    {
      owner: OWNER,
      repo: REPO,
      path: { type: "string", description: "File path, e.g. src/index.js" },
      ref: { type: "string", description: "Branch, tag or commit SHA. Defaults to the default branch." },
      start_line: { type: "integer", description: "1-based first line to return (optional)." },
      end_line: { type: "integer", description: "1-based last line to return (optional)." },
      max_chars: { type: "integer", description: "Truncate output after N characters, default 100000." },
      as_base64: { type: "boolean", description: "Return base64 instead of text (for binary files)." },
    },
    ["owner", "repo", "path"],
    async (a, t) => {
      need(a, "owner", "repo", "path");
      const data = await gh(t, "GET", `${R(a)}/contents/${ep(a.path)}${qs({ ref: a.ref })}`);
      if (Array.isArray(data)) throw new Error(`"${a.path}" is a directory — use list_files.`);
      if (data.type !== "file") return { path: data.path, type: data.type, note: "Not a regular file (symlink/submodule).", target: data.target || data.submodule_git_url };
      let buf;
      if (data.encoding === "base64" && data.content) buf = Buffer.from(data.content, "base64");
      else buf = Buffer.from((await gh(t, "GET", `${R(a)}/git/blobs/${data.sha}`)).content, "base64"); // file > 1MB
      const meta = { path: data.path, sha: data.sha, size: buf.length, ref: a.ref || "(default branch)" };
      const binary = buf.subarray(0, 8000).includes(0);
      if (a.as_base64) {
        if (buf.length > 2 * 1024 * 1024) return { ...meta, note: "File larger than 2MB, not returned." };
        return { ...meta, encoding: "base64", content: buf.toString("base64") };
      }
      if (binary) return { ...meta, binary: true, note: "Binary file — call again with as_base64=true." };
      let text = buf.toString("utf8");
      let lines = null;
      if (a.start_line || a.end_line) {
        const all = text.split("\n");
        lines = all.length;
        text = all.slice(Math.max((a.start_line || 1) - 1, 0), a.end_line || all.length).join("\n");
      }
      const max = a.max_chars || 100000;
      const truncated = text.length > max;
      if (truncated) text = text.slice(0, max);
      return { _blocks: [{ type: "text", text: JSON.stringify({ ...meta, total_lines: lines ?? undefined, truncated }) }, { type: "text", text }] };
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_file",
    "Create a new file and commit it directly to a branch (one commit). Fails if the file already exists — use update_file. Works on empty repositories.",
    {
      owner: OWNER,
      repo: REPO,
      path: { type: "string", description: "File path to create, e.g. docs/readme.md" },
      content: { type: "string", description: "File content." },
      message: { type: "string", description: "Commit message. Default: 'Create <path>'." },
      branch: BRANCH,
      encoding: ENCODING,
    },
    ["owner", "repo", "path", "content"],
    async (a, t) => {
      need(a, "owner", "repo", "path");
      if (a.content === undefined || a.content === null) throw new Error("Missing required argument(s): content");
      const r = await gh(t, "PUT", `${R(a)}/contents/${ep(a.path)}`, {
        message: a.message || `Create ${cleanPath(a.path)}`,
        content: toB64(a.content, a.encoding),
        ...(a.branch ? { branch: a.branch } : {}),
      });
      return { path: r.content?.path, file_sha: r.content?.sha, commit_sha: r.commit?.sha, commit_url: r.commit?.html_url, html_url: r.content?.html_url };
    },
  ),

  tool(
    "update_file",
    "Replace the full content of an existing file and commit it directly to a branch. If `sha` is omitted the current blob sha is fetched automatically.",
    {
      owner: OWNER,
      repo: REPO,
      path: { type: "string", description: "Path of the existing file." },
      content: { type: "string", description: "NEW full content of the file." },
      message: { type: "string", description: "Commit message. Default: 'Update <path>'." },
      branch: BRANCH,
      sha: { type: "string", description: "Blob sha of the file being replaced (optional, auto-fetched)." },
      encoding: ENCODING,
    },
    ["owner", "repo", "path", "content"],
    async (a, t) => {
      need(a, "owner", "repo", "path");
      if (a.content === undefined || a.content === null) throw new Error("Missing required argument(s): content");
      let sha = a.sha;
      if (!sha) {
        const cur = await gh(t, "GET", `${R(a)}/contents/${ep(a.path)}${qs({ ref: a.branch })}`);
        if (Array.isArray(cur)) throw new Error(`"${a.path}" is a directory.`);
        sha = cur.sha;
      }
      const r = await gh(t, "PUT", `${R(a)}/contents/${ep(a.path)}`, {
        message: a.message || `Update ${cleanPath(a.path)}`,
        content: toB64(a.content, a.encoding),
        sha,
        ...(a.branch ? { branch: a.branch } : {}),
      });
      return { path: r.content?.path, file_sha: r.content?.sha, commit_sha: r.commit?.sha, commit_url: r.commit?.html_url, html_url: r.content?.html_url };
    },
  ),

  tool(
    "delete_file",
    "Delete a file and commit the deletion directly to a branch. If `sha` is omitted the current blob sha is fetched automatically.",
    {
      owner: OWNER,
      repo: REPO,
      path: { type: "string", description: "Path of the file to delete." },
      message: { type: "string", description: "Commit message. Default: 'Delete <path>'." },
      branch: BRANCH,
      sha: { type: "string", description: "Blob sha of the file (optional, auto-fetched)." },
    },
    ["owner", "repo", "path"],
    async (a, t) => {
      need(a, "owner", "repo", "path");
      let sha = a.sha;
      if (!sha) {
        const cur = await gh(t, "GET", `${R(a)}/contents/${ep(a.path)}${qs({ ref: a.branch })}`);
        if (Array.isArray(cur)) throw new Error(`"${a.path}" is a directory — delete files individually or use commit_changes with action "delete".`);
        sha = cur.sha;
      }
      const r = await gh(t, "DELETE", `${R(a)}/contents/${ep(a.path)}`, {
        message: a.message || `Delete ${cleanPath(a.path)}`,
        sha,
        ...(a.branch ? { branch: a.branch } : {}),
      });
      return { deleted: cleanPath(a.path), commit_sha: r.commit?.sha, commit_url: r.commit?.html_url };
    },
    { destructiveHint: true },
  ),

  tool(
    "create_branch",
    "Create a new branch from another branch (default: the default branch) or from a specific commit SHA.",
    {
      owner: OWNER,
      repo: REPO,
      branch: { type: "string", description: "Name of the new branch, e.g. feature/login" },
      from_branch: { type: "string", description: "Source branch. Defaults to the default branch." },
      from_sha: { type: "string", description: "Source commit SHA (overrides from_branch)." },
    },
    ["owner", "repo", "branch"],
    async (a, t) => {
      need(a, "owner", "repo", "branch");
      let sha = a.from_sha;
      let from = a.from_sha;
      if (!sha) {
        from = a.from_branch || (await defaultBranch(t, a));
        sha = await branchHead(t, a, from);
        if (!sha) throw new Error(`Source branch "${from}" not found.`);
      }
      const r = await gh(t, "POST", `${R(a)}/git/refs`, { ref: `refs/heads/${a.branch}`, sha });
      return { branch: a.branch, from, sha: r.object.sha };
    },
  ),

  tool(
    "commit_changes",
    "Create ONE commit containing many file changes (upserts and deletes) on top of a branch. The commit is created but the branch is NOT moved until push_changes is called with the returned commit_sha — or pass push=true to do both. Chain several commits by passing the previous commit_sha as parent_sha.",
    {
      owner: OWNER,
      repo: REPO,
      message: { type: "string", description: "Commit message." },
      changes: {
        type: "array",
        description: "File changes to include in the commit.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path." },
            action: { type: "string", enum: ["upsert", "delete"], description: "upsert (create or overwrite, default) or delete." },
            content: { type: "string", description: "Full file content (required for upsert)." },
            encoding: ENCODING,
            mode: { type: "string", description: "File mode, default 100644 (use 100755 for executables)." },
          },
          required: ["path"],
        },
      },
      branch: { ...BRANCH, description: "Target branch (parent is its current head). Defaults to the default branch. May be a branch that doesn't exist yet — push_changes will create it." },
      from_branch: { type: "string", description: "If `branch` doesn't exist yet, branch off this one (default: the default branch)." },
      parent_sha: { type: "string", description: "Explicit parent commit (e.g. the previous commit_sha to chain commits). Overrides the branch head." },
      push: { type: "boolean", description: "Also move the branch to the new commit immediately (default false)." },
      force: { type: "boolean", description: "With push=true: force update, allow non-fast-forward." },
      author_name: { type: "string", description: "Optional commit author name (needs author_email)." },
      author_email: { type: "string", description: "Optional commit author email." },
    },
    ["owner", "repo", "message", "changes"],
    async (a, t) => {
      need(a, "owner", "repo", "message");
      if (!Array.isArray(a.changes) || !a.changes.length) throw new Error("`changes` must be a non-empty array.");
      const branch = a.branch || (await defaultBranch(t, a));
      let parent = a.parent_sha || (await branchHead(t, a, branch));
      if (!parent) {
        const base = a.from_branch || (await defaultBranch(t, a));
        parent = await branchHead(t, a, base);
        if (!parent) throw new Error(`Cannot find a base commit: branch "${branch}" and "${base}" do not exist.`);
      }
      const parentCommit = await gh(t, "GET", `${R(a)}/git/commits/${parent}`);

      const entries = [];
      for (const c of a.changes) {
        if (!c || !c.path) throw new Error("Every change needs a `path`.");
        const path = cleanPath(c.path);
        const action = c.action || "upsert";
        if (action === "delete") {
          entries.push({ path, mode: "100644", type: "blob", sha: null });
        } else if (action === "upsert") {
          if (c.content === undefined || c.content === null) throw new Error(`Change for "${path}" needs \`content\`.`);
          const enc = c.encoding === "base64" ? "base64" : "utf-8";
          const blob = await gh(t, "POST", `${R(a)}/git/blobs`, { content: enc === "base64" ? toB64(c.content, "base64") : String(c.content), encoding: enc });
          entries.push({ path, mode: c.mode || "100644", type: "blob", sha: blob.sha });
        } else {
          throw new Error(`Unknown action "${action}" for "${path}" (use upsert or delete).`);
        }
      }

      const tree = await gh(t, "POST", `${R(a)}/git/trees`, { base_tree: parentCommit.tree.sha, tree: entries });
      const commit = await gh(t, "POST", `${R(a)}/git/commits`, {
        message: a.message,
        tree: tree.sha,
        parents: [parent],
        ...(a.author_name && a.author_email ? { author: { name: a.author_name, email: a.author_email } } : {}),
      });

      const out = { commit_sha: commit.sha, tree_sha: tree.sha, parent_sha: parent, branch, files: entries.length, pushed: false };
      if (a.push) {
        const r = await pushRef(t, a, branch, commit.sha, a.force);
        out.pushed = true;
        out.branch_created = r.created;
      } else {
        out.next = `Call push_changes with branch="${branch}" and commit_sha="${commit.sha}" to publish this commit.`;
      }
      return out;
    },
  ),

  tool(
    "push_changes",
    "Publish a commit created by commit_changes: move (or create) the branch so it points at commit_sha. Fast-forward only unless force=true.",
    {
      owner: OWNER,
      repo: REPO,
      commit_sha: { type: "string", description: "Commit SHA returned by commit_changes." },
      branch: BRANCH,
      force: { type: "boolean", description: "Allow non-fast-forward update (overwrites history). Default false." },
    },
    ["owner", "repo", "commit_sha"],
    async (a, t) => {
      need(a, "owner", "repo", "commit_sha");
      const branch = a.branch || (await defaultBranch(t, a));
      const r = await pushRef(t, a, branch, a.commit_sha, a.force);
      return { branch, commit_sha: a.commit_sha, created: r.created, force: !!a.force, url: `${cfg.ghWeb}/${a.owner}/${a.repo}/commit/${a.commit_sha}` };
    },
    { destructiveHint: true },
  ),

  tool(
    "get_commit",
    "Inspect a commit: message, author, parents, stats and changed files (optionally with patches). Use it to verify a commit/push.",
    {
      owner: OWNER,
      repo: REPO,
      ref: { type: "string", description: "Commit SHA, branch or tag. Defaults to the default branch head." },
      include_patch: { type: "boolean", description: "Include per-file diffs (each truncated to 4000 chars). Default false." },
      max_files: { type: "integer", description: "Max files listed, default 100." },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const ref = a.ref || (await defaultBranch(t, a));
      const c = await gh(t, "GET", `${R(a)}/commits/${ep(ref)}`);
      const files = (c.files || []).slice(0, a.max_files || 100).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(a.include_patch && f.patch ? { patch: f.patch.length > 4000 ? f.patch.slice(0, 4000) + "\n…(truncated)" : f.patch } : {}),
      }));
      return {
        sha: c.sha,
        url: c.html_url,
        message: c.commit?.message,
        author: c.commit?.author,
        committer: c.commit?.committer,
        parents: (c.parents || []).map((p) => p.sha),
        stats: c.stats,
        files_total: (c.files || []).length,
        files,
      };
    },
    { readOnlyHint: true },
  ),
];

const TOOL_MAP = new Map(TOOLS.map((x) => [x.name, x]));
const MAX_OUT = 250_000;
const clip = (s) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + "\n…(output truncated)" : s);

async function callTool(name, args, token) {
  const t = TOOL_MAP.get(name);
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
async function handleRpc(msg, token) {
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
        serverInfo: SERVER_INFO,
        instructions:
          "GitHub repository tools. Direct edits: create_file/update_file/delete_file commit straight to a branch. For multi-file changes use commit_changes then push_changes. Verify with get_commit.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ handler, ...rest }) => rest) });
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
    const out = (await Promise.all(payload.map((m) => handleRpc(m, token)))).filter(Boolean);
    return out.length ? jres(200, out) : plain(202);
  }
  const out = await handleRpc(payload, token);
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

/* -------------------------------------------------------------------- router */
/** Xử lý 1 Request chuẩn Web, trả Response. Gọi configure(env) trước. */
export async function handle(request) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    if (method === "OPTIONS") return plain(204);

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
