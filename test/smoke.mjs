// Smoke test: dựng GitHub giả (in-memory) + chạy server.js thật, đi hết luồng OAuth và gọi cả 10 tool.
// Chạy: npm test
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sha = () => crypto.randomBytes(20).toString("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString("utf8");

/* ---------------------------------------------------------- GitHub giả (mini git) */
const blobs = new Map(); // id -> base64
const trees = new Map(); // id -> Map(path -> blobId)
const commits = new Map(); // id -> { tree, parents, message }
const refs = new Map(); // branch -> commit id

const mkBlob = (b) => {
  const id = sha();
  blobs.set(id, b);
  return id;
};
const mkTree = (map) => {
  const id = sha();
  trees.set(id, map);
  return id;
};
const mkCommit = (tree, parents, message) => {
  const id = sha();
  commits.set(id, { tree, parents, message });
  return id;
};
const treeOf = (cid) => trees.get(commits.get(cid).tree);
const isAncestor = (a, b) => {
  const seen = [b];
  while (seen.length) {
    const c = seen.pop();
    if (c === a) return true;
    seen.push(...(commits.get(c)?.parents || []));
  }
  return false;
};

refs.set("main", mkCommit(mkTree(new Map([["README.md", mkBlob(b64("# hello\n"))]])), [], "init"));

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://m");
  const p = url.pathname;
  const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? await readJson(req) : {};
  const json = (s, o) => {
    res.writeHead(s, { "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const nf = () => json(404, { message: "Not Found" });

  if (p === "/login/oauth/authorize") {
    const loc = new URL(url.searchParams.get("redirect_uri"));
    loc.searchParams.set("code", "ghcode");
    loc.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: loc.toString() });
    return res.end();
  }
  if (p === "/login/oauth/access_token") return json(200, body.code === "ghcode" ? { access_token: "gho_fake" } : { error: "bad_verification_code" });
  if (req.headers.authorization !== "Bearer gho_fake") return json(401, { message: "Bad credentials" });

  if (p === "/user/repos") return json(200, [{ full_name: "u/r", private: false, default_branch: "main", description: null, pushed_at: "2026-01-01T00:00:00Z", permissions: { push: true }, html_url: "https://github.com/u/r" }]);

  const m = p.match(/^\/repos\/u\/r(\/.*)?$/);
  if (!m) return nf();
  const rest = m[1] || "";
  let x;

  if (rest === "") return json(200, { default_branch: "main" });

  if ((x = rest.match(/^\/contents\/?(.*)$/))) {
    const fp = decodeURIComponent(x[1]);
    if (req.method === "GET") {
      const head = refs.get(url.searchParams.get("ref") || "main");
      if (!head) return nf();
      const t = treeOf(head);
      if (t.has(fp)) return json(200, { type: "file", name: fp.split("/").pop(), path: fp, sha: t.get(fp), size: unb64(blobs.get(t.get(fp))).length, encoding: "base64", content: blobs.get(t.get(fp)) });
      const pre = fp ? fp + "/" : "";
      const kids = new Map();
      for (const [k, id] of t) if (k.startsWith(pre)) {
        const name = k.slice(pre.length).split("/")[0];
        kids.set(name, k.slice(pre.length).includes("/") ? { name, path: pre + name, type: "dir", sha: "d" } : { name, path: k, type: "file", sha: id, size: 1 });
      }
      return kids.size ? json(200, [...kids.values()]) : nf();
    }
    const branch = body.branch || "main";
    const head = refs.get(branch);
    const t = new Map(treeOf(head));
    if (req.method === "PUT") {
      if (t.has(fp) && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (t.has(fp) && body.sha !== t.get(fp)) return json(409, { message: `${fp} does not match` });
      const bid = mkBlob(body.content);
      t.set(fp, bid);
      const c = mkCommit(mkTree(t), [head], body.message);
      refs.set(branch, c);
      return json(200, { content: { path: fp, sha: bid, html_url: "x" }, commit: { sha: c, html_url: "x" } });
    }
    if (req.method === "DELETE") {
      if (!t.has(fp)) return nf();
      if (body.sha !== t.get(fp)) return json(409, { message: "sha mismatch" });
      t.delete(fp);
      const c = mkCommit(mkTree(t), [head], body.message);
      refs.set(branch, c);
      return json(200, { commit: { sha: c, html_url: "x" } });
    }
  }

  if ((x = rest.match(/^\/git\/ref\/heads\/(.+)$/))) {
    const h = refs.get(decodeURIComponent(x[1]));
    return h ? json(200, { object: { sha: h } }) : nf();
  }
  if (rest === "/git/refs" && req.method === "POST") {
    const b = body.ref.replace("refs/heads/", "");
    if (refs.has(b)) return json(422, { message: "Reference already exists" });
    if (!commits.has(body.sha)) return json(422, { message: "Object does not exist" });
    refs.set(b, body.sha);
    return json(201, { object: { sha: body.sha } });
  }
  if ((x = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === "PATCH") {
    const b = decodeURIComponent(x[1]);
    if (!refs.has(b)) return nf();
    if (!body.force && !isAncestor(refs.get(b), body.sha)) return json(422, { message: "Update is not a fast forward" });
    refs.set(b, body.sha);
    return json(200, { object: { sha: body.sha } });
  }
  if ((x = rest.match(/^\/git\/commits\/([0-9a-f]+)$/))) {
    const c = commits.get(x[1]);
    return c ? json(200, { sha: x[1], tree: { sha: c.tree }, message: c.message }) : nf();
  }
  if (rest === "/git/commits" && req.method === "POST") return json(201, { sha: mkCommit(body.tree, body.parents, body.message) });
  if (rest === "/git/blobs" && req.method === "POST") return json(201, { sha: mkBlob(body.encoding === "base64" ? body.content : b64(body.content)) });
  if ((x = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/))) return json(200, { content: blobs.get(x[1]), encoding: "base64" });
  if (rest === "/git/trees" && req.method === "POST") {
    const t = new Map(trees.get(body.base_tree));
    for (const e of body.tree) e.sha === null ? t.delete(e.path) : t.set(e.path, e.sha);
    return json(201, { sha: mkTree(t) });
  }
  if ((x = rest.match(/^\/git\/trees\/([0-9a-f]+)$/))) {
    const t = trees.get(x[1]);
    return json(200, { truncated: false, tree: [...t].map(([k, id]) => ({ path: k, type: "blob", size: 1, sha: id })) });
  }
  if ((x = rest.match(/^\/commits\/(.+)$/))) {
    const ref = decodeURIComponent(x[1]);
    const id = refs.get(ref) || (commits.has(ref) ? ref : null);
    if (!id) return nf();
    const c = commits.get(id);
    const before = c.parents[0] ? treeOf(c.parents[0]) : new Map();
    const after = treeOf(id);
    const files = [];
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(k) === after.get(k)) continue;
      files.push({ filename: k, status: !before.has(k) ? "added" : !after.has(k) ? "removed" : "modified", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x" });
    }
    return json(200, { sha: id, html_url: "x", commit: { message: c.message, author: { name: "t" }, committer: { name: "t" }, tree: { sha: c.tree } }, parents: c.parents.map((s) => ({ sha: s })), stats: { total: files.length }, files });
  }
  return nf();
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

/* ------------------------------------------------------------------- chạy server */
const port = 38000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js")], {
  env: { ...process.env, PORT: String(port), PUBLIC_URL: base, GITHUB_API_URL: mockUrl, GITHUB_WEB_URL: mockUrl, GITHUB_CLIENT_ID: "gid", GITHUB_CLIENT_SECRET: "gsec", MCP_CLIENT_ID: "cid", MCP_CLIENT_SECRET: "csec", SESSION_SECRET: "s" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => /listening/.test(String(d)) && resolve());
  child.on("exit", (c) => reject(new Error("server exited " + c)));
});

let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

try {
  /* --- discovery + auth guard --- */
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.token_endpoint, `${base}/token`);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  ok("OAuth metadata");

  const noAuth = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate"), /resource_metadata=/);
  ok("401 + WWW-Authenticate khi chưa có token");

  /* --- OAuth flow (PKCE) --- */
  const verifier = "v".repeat(50);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authQ = (o = {}) => new URLSearchParams({ response_type: "code", client_id: "cid", redirect_uri: "https://gemini.example/cb", state: "xyz", code_challenge: challenge, code_challenge_method: "S256", ...o });

  assert.equal((await fetch(`${base}/authorize?${authQ({ client_id: "nope" })}`, { redirect: "manual" })).status, 400);
  assert.equal((await fetch(`${base}/authorize?${authQ({ redirect_uri: "http://evil.example/cb" })}`, { redirect: "manual" })).status, 400);
  ok("Từ chối client_id / redirect_uri sai");

  const a1 = await fetch(`${base}/authorize?${authQ()}`, { redirect: "manual" });
  assert.equal(a1.status, 302);
  const a2 = await fetch(a1.headers.get("location"), { redirect: "manual" }); // GitHub giả -> callback
  const a3 = await fetch(a2.headers.get("location"), { redirect: "manual" }); // callback -> redirect về Gemini
  const back = new URL(a3.headers.get("location"));
  assert.equal(back.origin + back.pathname, "https://gemini.example/cb");
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code");
  assert.ok(code);
  ok("Luồng /authorize -> GitHub -> /oauth/callback -> code");

  const tokenReq = (extra, auth) =>
    fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(auth ? { Authorization: "Basic " + Buffer.from(auth).toString("base64") } : {}) },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://gemini.example/cb", ...extra }),
    });
  assert.equal((await tokenReq({ code_verifier: verifier }, "cid:wrong")).status, 401);
  assert.equal((await tokenReq({ code_verifier: "bad" }, "cid:csec")).status, 400);
  const tok = await (await tokenReq({ code_verifier: verifier }, "cid:csec")).json();
  assert.match(tok.access_token, /^mcp_/);
  ok("/token: sai secret=401, sai PKCE=400, đúng=access_token");

  const refreshed = await (await fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: "cid", client_secret: "csec" }) })).json();
  assert.match(refreshed.access_token, /^mcp_/);
  ok("refresh_token");

  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer mcp_garbage" }, body: "{}" })).status, 401);
  ok("Token giả bị từ chối");

  /* --- MCP --- */
  let id = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return r.json();
  };
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const text = (r) => r.content.map((c) => c.text).join("\n");
  const data = (r) => JSON.parse(r.content[0].text);
  const R = { owner: "u", repo: "r" };

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const notif = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notif.status, 202);
  const list = await rpc("tools/list");
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["commit_changes", "create_branch", "create_file", "delete_file", "get_commit", "list_files", "list_repos", "push_changes", "read_file", "update_file"]);
  ok("initialize + tools/list (10 tool)");

  assert.equal(data(await call("list_repos", {}))[0].full_name, "u/r");
  ok("list_repos");

  assert.equal(data(await call("list_files", R))[0].name, "README.md");
  ok("list_files");

  const rd = await call("read_file", { ...R, path: "README.md" });
  assert.equal(rd.content[1].text, "# hello\n");
  ok("read_file");

  const cf = await call("create_file", { ...R, path: "docs/a.md", content: "A" });
  assert.ok(!cf.isError, text(cf));
  assert.equal((await call("create_file", { ...R, path: "docs/a.md", content: "again" })).isError, true);
  ok("create_file (+ lỗi khi file đã tồn tại)");

  const uf = await call("update_file", { ...R, path: "docs/a.md", content: "A2" });
  assert.ok(!uf.isError, text(uf));
  assert.equal((await call("read_file", { ...R, path: "docs/a.md" })).content[1].text, "A2");
  ok("update_file (tự lấy sha)");

  const rec = data(await call("list_files", { ...R, recursive: true }));
  assert.deepEqual(rec.entries.map((e) => e.path).sort(), ["README.md", "docs/a.md"]);
  ok("list_files recursive");

  const cb = data(await call("create_branch", { ...R, branch: "feature/x" }));
  assert.equal(cb.sha, refs.get("feature/x"));
  ok("create_branch");

  const before = refs.get("feature/x");
  const cc = data(await call("commit_changes", { ...R, branch: "feature/x", message: "multi", changes: [{ path: "src/b.txt", content: "B" }, { path: "README.md", action: "delete" }] }));
  assert.equal(cc.pushed, false);
  assert.equal(refs.get("feature/x"), before, "commit_changes không được di chuyển branch");
  ok("commit_changes (chưa push thì branch đứng yên)");

  const pc = data(await call("push_changes", { ...R, branch: "feature/x", commit_sha: cc.commit_sha }));
  assert.equal(refs.get("feature/x"), cc.commit_sha);
  assert.equal(pc.created, false);
  ok("push_changes");

  const gc = data(await call("get_commit", { ...R, ref: cc.commit_sha, include_patch: true }));
  assert.deepEqual(gc.files.map((f) => `${f.status}:${f.filename}`).sort(), ["added:src/b.txt", "removed:README.md"]);
  assert.equal(gc.parents[0], before);
  ok("get_commit");

  const np = data(await call("commit_changes", { ...R, branch: "new/y", from_branch: "main", message: "new branch", push: true, changes: [{ path: "n.txt", content: "N" }] }));
  assert.equal(np.pushed, true);
  assert.equal(np.branch_created, true);
  assert.equal(refs.get("new/y"), np.commit_sha);
  ok("commit_changes push=true tạo branch mới");

  const div = data(await call("commit_changes", { ...R, branch: "main", message: "diverge", changes: [{ path: "m.txt", content: "M" }] }));
  const rej = await call("push_changes", { ...R, branch: "feature/x", commit_sha: div.commit_sha });
  assert.equal(rej.isError, true);
  assert.match(text(rej), /fast-forward/i);
  const forced = await call("push_changes", { ...R, branch: "feature/x", commit_sha: div.commit_sha, force: true });
  assert.ok(!forced.isError, text(forced));
  ok("push non-fast-forward bị chặn, force=true thì qua");

  const df = await call("delete_file", { ...R, path: "docs/a.md" });
  assert.ok(!df.isError, text(df));
  assert.equal((await call("read_file", { ...R, path: "docs/a.md" })).isError, true);
  ok("delete_file");

  console.log(`\nOK — ${passed} nhóm kiểm tra đã qua.`);
} catch (e) {
  console.error("\nFAIL:", e);
  process.exitCode = 1;
} finally {
  child.kill();
  mock.close();
}
