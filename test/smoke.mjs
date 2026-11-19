// Smoke test: dựng GitHub giả (in-memory) + chạy server.js thật, đi hết luồng OAuth và gọi các tool core.
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
const commits = new Map(); // id -> { tree, parents, message, date }
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
const mkCommit = (tree, parents, message, date = new Date().toISOString()) => {
  const id = sha();
  commits.set(id, { tree, parents, message, date });
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

refs.set("main", mkCommit(mkTree(new Map([["README.md", mkBlob(b64("# hello\n"))]])), [], "init", "2026-01-01T00:00:00Z"));

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

  if (p === "/user/repos" && req.method === "POST") return json(201, { full_name: `u/${body.name}`, private: body.private, default_branch: "main", html_url: "x", clone_url: "x" });
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
  if (rest === "/commits" && req.method === "GET") {
    const startRef = url.searchParams.get("sha") || "main";
    let cur = refs.get(startRef) || (commits.has(startRef) ? startRef : null);
    if (!cur) return nf();
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const chain = [];
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const c = commits.get(cur);
      if (!c) break;
      if ((!since || c.date >= since) && (!until || c.date <= until)) {
        chain.push({ sha: cur, html_url: "x", commit: { message: c.message, author: { name: "t", date: c.date }, committer: { name: "t", date: c.date } }, parents: c.parents.map((s) => ({ sha: s })) });
      }
      cur = c.parents[0] || null;
    }
    const perPage = Number(url.searchParams.get("per_page") || 30);
    const page = Number(url.searchParams.get("page") || 1);
    return json(200, chain.slice((page - 1) * perPage, page * perPage));
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

await new Promise((r) => mock.listen(Number(process.env.MOCK_PORT || 0), "127.0.0.1", r));
const mockUrl = `http://127.0.0.1:${mock.address().port}`;

/* ------------------------------------------------------------------- chạy server */
let base, child;
if (process.env.SMOKE_BASE) {
  // Server chạy sẵn bên ngoài (vd. `wrangler dev`), trỏ GITHUB_API_URL/GITHUB_WEB_URL về mock (MOCK_PORT)
  base = process.env.SMOKE_BASE;
} else {
  const port = 38000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js")], {
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, GITHUB_API_URL: mockUrl, GITHUB_WEB_URL: mockUrl, GITHUB_CLIENT_ID: "gid", GITHUB_CLIENT_SECRET: "gsec", MCP_CLIENT_ID: "cid", MCP_CLIENT_SECRET: "csec", SESSION_SECRET: "s" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => /listening/.test(String(d)) && resolve());
    child.on("exit", (c) => reject(new Error("server exited " + c)));
  });
}

let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

try {
  /* --- discovery + auth guard --- */
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.token_endpoint, `${base}/token`);
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  ok("OAuth metadata");

  const ico = await fetch(`${base}/favicon.ico`);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.deepEqual([...new Uint8Array(await ico.arrayBuffer()).slice(0, 4)], [0, 0, 1, 0]);
  const png = await fetch(`${base}/icon.png`);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(await (await fetch(`${base}/favicon.svg`)).text(), /<svg/);
  assert.match(await (await fetch(`${base}/`, { headers: { Accept: "text/html" } })).text(), /rel="icon"/);
  assert.equal((await (await fetch(`${base}/`)).json()).ok, true);
  ok("Icon: /favicon.ico, /favicon.svg, /icon.png, trang chủ HTML");

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
  assert.equal(init.result.serverInfo.title, "Github Remote Repository");
  assert.equal(init.result.serverInfo.icons[0].src, `${base}/icon.png`);
  const notif = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(notif.status, 202);
  const list = await rpc("tools/list");
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["commit_changes", "create_branch", "create_file", "create_repo", "delete_file", "get_commit", "list_commits", "list_files", "list_repos", "push_changes", "read_file", "update_file"]) assert.ok(names.includes(n), `thiếu tool ${n}`);
  for (const n of ["create_issue", "merge_pull_request", "get_job_logs", "create_release", "create_webhook", "update_branch_protection"]) assert.ok(names.includes(n), `thiếu tool ${n}`);
  assert.equal(new Set(names).size, names.length, "tên tool bị trùng");
  ok(`initialize + tools/list (${names.length} tool, đủ các nhóm)`);

  assert.equal(data(await call("list_repos", {}))[0].full_name, "u/r");
  ok("list_repos");

  const nr = data(await call("create_repo", { name: "new-repo", description: "d" }));
  assert.equal(nr.full_name, "u/new-repo");
  assert.equal(nr.private, true, "mặc định phải là private");
  assert.equal(data(await call("create_repo", { name: "pub", private: false })).private, false);
  ok("create_repo (mặc định private)");

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

  /* --- edit_file --- */
  const fileText = async (path) => (await call("read_file", { ...R, path })).content[1].text;
  await call("create_file", { ...R, path: "e.txt", content: "alpha\nbeta\nbeta2\ngamma\n" });
  let ef = await call("edit_file", { ...R, path: "e.txt", old_string: "alpha", new_string: "ALPHA" });
  assert.ok(!ef.isError, text(ef));
  assert.equal(await fileText("e.txt"), "ALPHA\nbeta\nbeta2\ngamma\n");
  const efd = data(ef);
  assert.equal(efd.edits[0].replacements, 1);
  assert.equal(efd.commit_sha, refs.get("main"), "edit_file phải tạo đúng 1 commit trên main");
  ok("edit_file: thay 1 đoạn, giữ nguyên phần còn lại, 1 commit");

  const headBefore = refs.get("main");
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "beta", new_string: "B" });
  assert.equal(ef.isError, true);
  assert.match(text(ef), /matches 2 places/);
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "does not exist", new_string: "x" });
  assert.match(text(ef), /not found/);
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "gamma", new_string: "gamma" });
  assert.match(text(ef), /identical/);
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "ALPHA" });
  assert.match(text(ef), /new_string is required/);
  assert.equal(refs.get("main"), headBefore, "edit lỗi không được tạo commit");
  assert.equal(await fileText("e.txt"), "ALPHA\nbeta\nbeta2\ngamma\n");
  ok("edit_file: lỗi khi trùng nhiều chỗ / không tìm thấy / không đổi gì / thiếu new_string, không commit");

  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "beta", new_string: "B", replace_all: true });
  assert.ok(!ef.isError, text(ef));
  assert.equal(data(ef).edits[0].replacements, 2);
  assert.equal(await fileText("e.txt"), "ALPHA\nB\nB2\ngamma\n");
  ok("edit_file: replace_all");

  const c1 = refs.get("main");
  ef = await call("edit_file", { ...R, path: "e.txt", edits: [{ old_string: "ALPHA", new_string: "A" }, { old_string: "A\nB\n", new_string: "AB\n" }, { old_string: "gamma", new_string: "cost $& and $1 $$" }] });
  assert.ok(!ef.isError, text(ef));
  assert.equal(await fileText("e.txt"), "AB\nB2\ncost $& and $1 $$\n");
  assert.notEqual(refs.get("main"), c1);
  assert.equal(commits.get(refs.get("main")).parents[0], c1, "nhiều edit gộp trong đúng 1 commit");
  ok("edit_file: nhiều edit tuần tự trong 1 commit, ký tự $ được giữ nguyên");

  ef = await call("edit_file", { ...R, path: "e.txt", edits: [{ old_string: "AB", new_string: "X" }, { old_string: "nope", new_string: "y" }] });
  assert.match(text(ef), /Edit #2/);
  assert.equal(await fileText("e.txt"), "AB\nB2\ncost $& and $1 $$\n", "1 edit lỗi thì không edit nào được ghi");
  const c2 = refs.get("main");
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "AB", new_string: "ZZ", dry_run: true });
  assert.equal(data(ef).dry_run, true);
  assert.equal(refs.get("main"), c2, "dry_run không commit");
  ok("edit_file: edit lỗi thì không ghi gì (atomic), dry_run không commit");

  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "AB", new_string: "ZZ", sha: "deadbeef" });
  assert.match(text(ef), /File changed since you read it/);
  const cur = data(await call("read_file", { ...R, path: "e.txt" }).then((r) => ({ content: [r.content[0]] })));
  ef = await call("edit_file", { ...R, path: "e.txt", old_string: "AB", new_string: "ZZ", sha: cur.sha });
  assert.ok(!ef.isError, text(ef));
  ok("edit_file: tham số sha chặn ghi đè khi file đã đổi");

  await call("create_file", { ...R, path: "win.txt", content: "x\r\ny\r\nz\r\n" });
  ef = await call("edit_file", { ...R, path: "win.txt", old_string: "x\ny", new_string: "p\nq" });
  assert.ok(!ef.isError, text(ef));
  assert.equal(await fileText("win.txt"), "p\r\nq\r\nz\r\n");
  await call("create_file", { ...R, path: "bin.dat", content: Buffer.from([1, 0, 2, 0, 3]).toString("base64"), encoding: "base64" });
  assert.match(text(await call("edit_file", { ...R, path: "bin.dat", old_string: "a", new_string: "b" })), /binary/);
  assert.match(text(await call("edit_file", { ...R, path: "docs", old_string: "a", new_string: "b" })), /directory/);
  for (const f of ["e.txt", "win.txt", "bin.dat"]) assert.ok(!(await call("delete_file", { ...R, path: f })).isError);
  ok("edit_file: file CRLF, từ chối file nhị phân và thư mục");

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

  const lcNew = data(await call("list_commits", { ...R, sha: "feature/x" }));
  assert.equal(lcNew.order, "newest_first");
  assert.equal(lcNew.commits[0].sha, cc.commit_sha);
  assert.equal(lcNew.commits.at(-1).message, "init");

  const lcOld = data(await call("list_commits", { ...R, sha: "feature/x", from_start: true }));
  assert.equal(lcOld.order, "oldest_first");
  assert.equal(lcOld.commits[0].message, "init");
  assert.equal(lcOld.commits.at(-1).sha, cc.commit_sha);

  const lcRange = data(await call("list_commits", { ...R, sha: "feature/x", since: "2026-06-01T00:00:00Z" }));
  assert.ok(lcRange.commits.every((c) => c.message !== "init"));
  ok("list_commits (mới nhất, từ đầu from_start=true, và lọc since/until)");

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
  child?.kill();
  mock.close();
}
