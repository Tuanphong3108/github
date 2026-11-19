// Test hợp đồng cho các nhóm tool issues / actions / admin: mock GitHub kiểm tra từng tool
// gọi ĐÚNG method + path + query + body, rồi kiểm tra kết quả trả về. Chạy: npm test
import http from "node:http";
import assert from "node:assert/strict";
import { configure, handle } from "../src/app.js";
import { getTools } from "../src/tools/index.js";

const out = (s) => process.stdout.write(s + "\n");
console.log = () => {}; // handleRpc log mỗi lần gọi tool

/* ------------------------------------------------------------------ mock */
let queue = [];
let failures = [];

function partial(actual, expected, where = "body") {
  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${where}: expected object, got ${JSON.stringify(actual)}`);
    if (Array.isArray(expected)) {
      assert.ok(Array.isArray(actual) && actual.length === expected.length, `${where}: array length ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
      expected.forEach((e, i) => partial(actual[i], e, `${where}[${i}]`));
    } else for (const k of Object.keys(expected)) partial(actual[k], expected[k], `${where}.${k}`);
  } else assert.equal(actual, expected, `${where}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, "http://m");
  const next = queue.shift();
  if (!next) {
    failures.push(`unexpected call ${req.method} ${req.url}`);
    res.writeHead(599, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "unexpected call" }));
    return;
  }
  try {
    assert.equal(req.method, next.method, `method of ${req.url}`);
    assert.equal(url.pathname, next.path, "path");
    if (next.query) assert.deepEqual(Object.fromEntries(url.searchParams), next.query, `query of ${url.pathname}`);
    if (next.body !== undefined) partial(JSON.parse(raw.toString()), next.body);
    if (next.exactBody !== undefined) assert.deepEqual(JSON.parse(raw.toString()), next.exactBody, `body of ${url.pathname}`);
    if (next.noBody) assert.equal(raw.length, 0, "expected no body");
    if (next.raw !== undefined) assert.equal(raw.toString("utf8"), next.raw, "raw body");
    for (const [k, v] of Object.entries(next.headers || {})) assert.equal(req.headers[k], v, `header ${k}`);
  } catch (e) {
    failures.push(`${req.method} ${req.url}: ${e.message}`);
  }
  const status = next.status || 200;
  const headers = { ...(next.replyHeaders || {}), "Content-Type": next.text !== undefined ? "text/plain" : "application/json" };
  res.writeHead(status, headers);
  res.end(status === 204 || status === 302 ? "" : next.text !== undefined ? next.text : JSON.stringify(next.reply ?? {}));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const M = `http://127.0.0.1:${mock.address().port}`;

const ENV = { GITHUB_CLIENT_ID: "g", GITHUB_CLIENT_SECRET: "g", MCP_CLIENT_ID: "c", MCP_CLIENT_SECRET: "s", SESSION_SECRET: "x", GITHUB_API_URL: M, GITHUB_WEB_URL: M, GITHUB_UPLOADS_URL: `${M}/up` };
configure(ENV);

async function rpc(method, params) {
  const r = await handle(new Request("http://worker.test/mcp", { method: "POST", headers: { Authorization: "Bearer gho_x", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
  return (await r.json()).result;
}

/** Gọi tool, kiểm tra các call tới GitHub đúng thứ tự mong đợi. */
async function run(name, args, calls = []) {
  queue = calls.map((c) => ({ ...c }));
  failures = [];
  const r = await rpc("tools/call", { name, arguments: args });
  assert.deepEqual(failures, [], `${name}: ${failures.join(" | ")}`);
  assert.equal(queue.length, 0, `${name}: ${queue.length} call(s) mong đợi nhưng không được gọi`);
  return r;
}
const data = (r) => {
  assert.ok(!r.isError, "tool lỗi: " + r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
let passed = 0;
const ok = (n) => { out(`  ✓ ${n}`); passed++; };
const O = { owner: "o", repo: "r" };
const P = "/repos/o/r";

try {
  /* ============================================================ registry */
  assert.equal(getTools(["core"]).length, 12);
  assert.equal(new Set(getTools(["all"]).map((t) => t.name)).size, getTools(["all"]).length);
  configure({ ...ENV, TOOL_GROUPS: "core,admin" });
  const sub = (await rpc("tools/list")).tools.map((t) => t.name);
  assert.ok(sub.includes("list_files") && sub.includes("create_webhook") && !sub.includes("create_issue") && !sub.includes("get_job_logs"));
  assert.equal((await rpc("tools/call", { name: "create_issue", arguments: { ...O, title: "x" } })).isError, true, "tool ngoài nhóm phải bị từ chối");
  configure(ENV);
  ok(`Đăng ký tool: ${getTools(["all"]).length} tool, TOOL_GROUPS lọc được nhóm`);

  /* ============================================================== issues */
  let r = data(await run("list_issues", { ...O, labels: "bug,help", state: "open" }, [
    { method: "GET", path: `${P}/issues`, query: { state: "open", labels: "bug,help", per_page: "30", page: "1" }, reply: [
      { number: 1, title: "A", state: "open", user: { login: "u" }, labels: [{ name: "bug" }], assignees: [], comments: 0, body: "hello", html_url: "u1" },
      { number: 2, title: "PR", state: "open", pull_request: {}, user: { login: "u" }, labels: [], assignees: [], comments: 0 },
    ] },
  ]));
  assert.equal(r.count, 1);
  assert.equal(r.issues[0].number, 1);
  assert.deepEqual(r.issues[0].labels, ["bug"]);
  ok("list_issues (lọc, loại bỏ PR, labels dạng chuỗi)");

  r = data(await run("get_issue", { ...O, number: 5, include_comments: true }, [
    { method: "GET", path: `${P}/issues/5`, reply: { number: 5, title: "T", state: "open", body: "B", comments: 1, labels: [], assignees: [] } },
    { method: "GET", path: `${P}/issues/5/comments`, query: { per_page: "100" }, reply: [{ id: 1, user: { login: "x" }, body: "hi" }] },
  ]));
  assert.equal(r.body, "B");
  assert.equal(r.comment_list[0].body, "hi");
  ok("get_issue + comments");

  await run("create_issue", { ...O, title: "T", body: "B", labels: ["a", "b"], assignees: "me" }, [
    { method: "POST", path: `${P}/issues`, exactBody: { title: "T", body: "B", labels: ["a", "b"], assignees: ["me"] }, status: 201, reply: { number: 9, title: "T", state: "open", labels: [], assignees: [] } },
  ]);
  ok("create_issue");

  await run("update_issue", { ...O, number: 5, state: "closed", state_reason: "completed", labels: ["x"], milestone: null }, [
    { method: "PATCH", path: `${P}/issues/5`, exactBody: { state: "closed", state_reason: "completed", labels: ["x"], milestone: null }, reply: { number: 5, state: "closed", labels: [], assignees: [] } },
  ]);
  assert.equal((await run("update_issue", { ...O, number: 5 }, [])).isError, true);
  ok("update_issue (đóng, nhãn, bỏ milestone; không có gì để sửa = lỗi, không gọi API)");

  await run("add_issue_comment", { ...O, number: 5, body: "yo" }, [{ method: "POST", path: `${P}/issues/5/comments`, exactBody: { body: "yo" }, status: 201, reply: { id: 3, body: "yo", user: { login: "me" } } }]);
  await run("edit_issue_comment", { ...O, comment_id: 3, body: "yo2" }, [{ method: "PATCH", path: `${P}/issues/comments/3`, exactBody: { body: "yo2" }, reply: { id: 3, body: "yo2" } }]);
  await run("delete_issue_comment", { ...O, comment_id: 3 }, [{ method: "DELETE", path: `${P}/issues/comments/3`, status: 204 }]);
  await run("list_issue_comments", { ...O, number: 5 }, [{ method: "GET", path: `${P}/issues/5/comments`, query: { per_page: "30", page: "1" }, reply: [] }]);
  ok("add/edit/delete/list comment");

  await run("list_labels", O, [{ method: "GET", path: `${P}/labels`, query: { per_page: "100", page: "1" }, reply: [{ name: "bug", color: "f00", description: null }] }]);
  r = data(await run("add_labels", { ...O, number: 5, labels: "bug" }, [{ method: "POST", path: `${P}/issues/5/labels`, exactBody: { labels: ["bug"] }, reply: [{ name: "bug" }] }]));
  assert.deepEqual(r.labels, ["bug"]);
  await run("remove_label", { ...O, number: 5, label: "good first issue" }, [{ method: "DELETE", path: `${P}/issues/5/labels/good%20first%20issue`, reply: [] }]);
  await run("add_assignees", { ...O, number: 5, assignees: ["a"] }, [{ method: "POST", path: `${P}/issues/5/assignees`, exactBody: { assignees: ["a"] }, status: 201, reply: { assignees: [{ login: "a" }] } }]);
  await run("remove_assignees", { ...O, number: 5, assignees: ["a"] }, [{ method: "DELETE", path: `${P}/issues/5/assignees`, exactBody: { assignees: ["a"] }, reply: { assignees: [] } }]);
  ok("labels & assignees (thêm/xóa, tên có khoảng trắng được encode)");

  /* ======================================================== pull requests */
  const pr = { number: 7, title: "PR", state: "open", draft: false, user: { login: "u" }, head: { ref: "feat", sha: "H", repo: { full_name: "o/r" } }, base: { ref: "main", sha: "B" }, labels: [], assignees: [], requested_reviewers: [] };
  await run("list_pull_requests", { ...O, state: "all", base: "main" }, [{ method: "GET", path: `${P}/pulls`, query: { state: "all", base: "main", per_page: "30", page: "1" }, reply: [pr] }]);
  r = data(await run("get_pull_request", { ...O, number: 7 }, [{ method: "GET", path: `${P}/pulls/7`, reply: { ...pr, mergeable: true, mergeable_state: "clean", changed_files: 2, additions: 5, deletions: 1, commits: 1 } }]));
  assert.equal(r.mergeable, true);
  ok("list/get pull request");

  await run("create_pull_request", { ...O, title: "PR", head: "feat", draft: true }, [
    { method: "GET", path: P, reply: { default_branch: "main" } },
    { method: "POST", path: `${P}/pulls`, exactBody: { title: "PR", head: "feat", base: "main", draft: true }, status: 201, reply: pr },
  ]);
  ok("create_pull_request (base mặc định = default branch)");

  await run("update_pull_request", { ...O, number: 7, state: "closed" }, [{ method: "PATCH", path: `${P}/pulls/7`, exactBody: { state: "closed" }, reply: { ...pr, state: "closed" } }]);
  assert.equal((await run("update_pull_request", { ...O, number: 7 }, [])).isError, true);
  ok("update_pull_request (đóng PR không merge)");

  r = data(await run("merge_pull_request", { ...O, number: 7, merge_method: "squash", sha: "H" }, [{ method: "PUT", path: `${P}/pulls/7/merge`, exactBody: { merge_method: "squash", sha: "H" }, reply: { merged: true, sha: "M", message: "Pull Request successfully merged" } }]));
  assert.equal(r.merged, true);
  await run("merge_pull_request", { ...O, number: 7 }, [{ method: "PUT", path: `${P}/pulls/7/merge`, exactBody: { merge_method: "merge" }, reply: { merged: true, sha: "M" } }]);
  const notMergeable = await run("merge_pull_request", { ...O, number: 7 }, [{ method: "PUT", path: `${P}/pulls/7/merge`, status: 405, reply: { message: "Pull Request is not mergeable" } }]);
  assert.equal(notMergeable.isError, true);
  assert.match(notMergeable.content[0].text, /405.*not mergeable/);
  ok("merge_pull_request (squash + sha, mặc định merge, lỗi GitHub được báo lại)");

  r = await run("get_pull_request_diff", { ...O, number: 7 }, [{ method: "GET", path: `${P}/pulls/7`, headers: { accept: "application/vnd.github.diff" }, text: "diff --git a/x b/x\n+new\n" }]);
  assert.equal(r.content[0].text, "diff --git a/x b/x\n+new\n");
  r = data(await run("list_pull_request_files", { ...O, number: 7, include_patch: true }, [{ method: "GET", path: `${P}/pulls/7/files`, query: { per_page: "100", page: "1" }, reply: [{ filename: "a.js", status: "modified", additions: 1, deletions: 0, patch: "@@ +1" }] }]));
  assert.equal(r.files[0].patch, "@@ +1");
  ok("get_pull_request_diff, list_pull_request_files");

  r = data(await run("create_pull_request_review", { ...O, number: 7, event: "REQUEST_CHANGES", body: "fix", comments: [{ path: "a.js", line: 3, body: "nit" }, { path: "b.js", line: 9, start_line: 5, side: "LEFT", body: "multi" }] }, [
    { method: "POST", path: `${P}/pulls/7/reviews`, exactBody: { event: "REQUEST_CHANGES", body: "fix", comments: [
      { path: "a.js", line: 3, side: "RIGHT", body: "nit" },
      { path: "b.js", line: 9, side: "LEFT", body: "multi", start_line: 5, start_side: "LEFT" },
    ] }, reply: { id: 11, state: "CHANGES_REQUESTED", user: { login: "me" } } },
  ]));
  assert.equal(r.inline_comments, 2);
  await run("create_pull_request_review", { ...O, number: 7, event: "APPROVE" }, [{ method: "POST", path: `${P}/pulls/7/reviews`, exactBody: { event: "APPROVE" }, reply: { id: 12, state: "APPROVED" } }]);
  await run("list_pull_request_reviews", { ...O, number: 7 }, [{ method: "GET", path: `${P}/pulls/7/reviews`, query: { per_page: "30", page: "1" }, reply: [{ id: 11, state: "APPROVED", user: { login: "x" } }] }]);
  ok("review: comment từng dòng / approve / request changes");

  await run("add_pull_request_comment", { ...O, number: 7, path: "a.js", line: 3, body: "c" }, [
    { method: "GET", path: `${P}/pulls/7`, reply: pr },
    { method: "POST", path: `${P}/pulls/7/comments`, exactBody: { body: "c", commit_id: "H", path: "a.js", line: 3, side: "RIGHT" }, status: 201, reply: { id: 50, path: "a.js", line: 3, body: "c" } },
  ]);
  await run("reply_to_review_comment", { ...O, number: 7, comment_id: 50, body: "re" }, [{ method: "POST", path: `${P}/pulls/7/comments/50/replies`, exactBody: { body: "re" }, status: 201, reply: { id: 51, in_reply_to_id: 50, body: "re" } }]);
  await run("list_pull_request_comments", { ...O, number: 7 }, [{ method: "GET", path: `${P}/pulls/7/comments`, query: { per_page: "30", page: "1" }, reply: [] }]);
  await run("request_reviewers", { ...O, number: 7, reviewers: "bob" }, [{ method: "POST", path: `${P}/pulls/7/requested_reviewers`, exactBody: { reviewers: ["bob"] }, status: 201, reply: { number: 7, requested_reviewers: [{ login: "bob" }], requested_teams: [] } }]);
  assert.equal((await run("request_reviewers", { ...O, number: 7 }, [])).isError, true);
  ok("bình luận dòng (tự lấy head sha), reply, request_reviewers");

  /* ============================================================== actions */
  await run("list_workflows", O, [{ method: "GET", path: `${P}/actions/workflows`, query: { per_page: "30", page: "1" }, reply: { total_count: 1, workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] } }]);
  r = data(await run("list_workflow_runs", { ...O, workflow_id: "ci.yml", status: "failure", branch: "main" }, [
    { method: "GET", path: `${P}/actions/workflows/ci.yml/runs`, query: { branch: "main", status: "failure", per_page: "30", page: "1" }, reply: { total_count: 1, workflow_runs: [{ id: 9, name: "CI", status: "completed", conclusion: "failure", head_branch: "main", actor: { login: "u" } }] } },
  ]));
  assert.equal(r.runs[0].conclusion, "failure");
  await run("list_workflow_runs", O, [{ method: "GET", path: `${P}/actions/runs`, query: { per_page: "30", page: "1" }, reply: { total_count: 0, workflow_runs: [] } }]);
  await run("get_workflow_run", { ...O, run_id: 9 }, [{ method: "GET", path: `${P}/actions/runs/9`, reply: { id: 9, status: "completed" } }]);
  ok("list_workflows, list_workflow_runs (theo workflow / toàn repo), get_workflow_run");

  r = data(await run("list_run_jobs", { ...O, run_id: 9 }, [{ method: "GET", path: `${P}/actions/runs/9/jobs`, query: { per_page: "100" }, reply: { total_count: 1, jobs: [{ id: 5, name: "build", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "Checkout", status: "completed", conclusion: "success" }, { number: 2, name: "Test", status: "completed", conclusion: "failure" }] }] } }]));
  assert.deepEqual(r.jobs[0].failed_steps, ["Test"]);
  ok("list_run_jobs (liệt kê step lỗi)");

  const LOG = ["2026-11-19T10:00:00.1234567Z \u001b[36mline one\u001b[0m", "2026-11-19T10:00:01.0000000Z line two", "2026-11-19T10:00:02.0000000Z ##[error]Process completed with exit code 1.", "2026-11-19T10:00:03.0000000Z line four", "2026-11-19T10:00:04.0000000Z line five"].join("\n");
  r = await run("get_job_logs", { ...O, job_id: 5, tail_lines: 2 }, [
    { method: "GET", path: `${P}/actions/jobs/5/logs`, status: 302, replyHeaders: { Location: `${M}/blob/5` } },
    { method: "GET", path: "/blob/5", text: LOG },
  ]);
  assert.equal(r.content[1].text, "line four\nline five");
  assert.equal(JSON.parse(r.content[0].text).total_lines, 5);
  r = await run("get_job_logs", { ...O, job_id: 5, grep: "##\\[error\\]", context: 1 }, [{ method: "GET", path: `${P}/actions/jobs/5/logs`, text: LOG }]);
  assert.equal(r.content[1].text, "2: line two\n3: ##[error]Process completed with exit code 1.\n4: line four");
  r = await run("get_job_logs", { ...O, job_id: 5, tail_lines: 0, keep_timestamps: true }, [{ method: "GET", path: `${P}/actions/jobs/5/logs`, text: LOG }]);
  assert.match(r.content[1].text.split("\n")[0], /^2026-11-19T10:00:00\.1234567Z line one$/);
  ok("get_job_logs (theo redirect, bỏ timestamp/màu, tail, grep + context)");

  const BIG = Array.from({ length: 300 }, (_, i) => `2026-11-19T10:00:00.0000000Z row ${i + 1}`).join("\n");
  r = await run("get_job_logs", { ...O, job_id: 5 }, [{ method: "GET", path: `${P}/actions/jobs/5/logs`, text: BIG }]);
  assert.equal(r.content[1].text.split("\n").length, 200, "mặc định chỉ trả 200 dòng cuối");
  assert.equal(r.content[1].text.split("\n")[0], "row 101");
  assert.equal(JSON.parse(r.content[0].text).total_lines, 300);
  r = await run("get_job_logs", { ...O, job_id: 5, max_chars: 30 }, [{ method: "GET", path: `${P}/actions/jobs/5/logs`, text: BIG }]);
  assert.equal(JSON.parse(r.content[0].text).truncated, true);
  assert.ok(r.content[1].text.length <= 30 && r.content[1].text.endsWith("row 300"), "cắt giữ lại phần cuối");

  await run("rerun_workflow", { ...O, run_id: 9 }, [{ method: "POST", path: `${P}/actions/runs/9/rerun`, status: 201 }]);
  await run("rerun_workflow", { ...O, run_id: 9, only_failed: true, enable_debug_logging: true }, [{ method: "POST", path: `${P}/actions/runs/9/rerun-failed-jobs`, exactBody: { enable_debug_logging: true }, status: 201 }]);
  await run("rerun_workflow", { ...O, job_id: 5 }, [{ method: "POST", path: `${P}/actions/jobs/5/rerun`, status: 201 }]);
  assert.equal((await run("rerun_workflow", O, [])).isError, true);
  await run("cancel_workflow_run", { ...O, run_id: 9 }, [{ method: "POST", path: `${P}/actions/runs/9/cancel`, status: 202 }]);
  await run("cancel_workflow_run", { ...O, run_id: 9, force: true }, [{ method: "POST", path: `${P}/actions/runs/9/force-cancel`, status: 202 }]);
  await run("dispatch_workflow", { ...O, workflow_id: "ci.yml", ref: "main", inputs: { env: "prod" } }, [{ method: "POST", path: `${P}/actions/workflows/ci.yml/dispatches`, exactBody: { ref: "main", inputs: { env: "prod" } }, status: 204 }]);
  ok("rerun (tất cả / job lỗi / 1 job), cancel (thường + force), dispatch_workflow");

  const rel = { id: 3, tag_name: "v1", name: "v1", draft: false, prerelease: false, author: { login: "u" }, assets: [{ id: 8, name: "a.zip", size: 4, content_type: "application/zip", download_count: 0, browser_download_url: "https://dl" }], body: "notes" };
  await run("list_releases", O, [{ method: "GET", path: `${P}/releases`, query: { per_page: "30", page: "1" }, reply: [rel] }]);
  r = data(await run("get_release", { ...O, latest: true }, [{ method: "GET", path: `${P}/releases/latest`, reply: rel }]));
  assert.equal(r.assets[0].download_url, "https://dl");
  await run("get_release", { ...O, tag: "v1.0/rc" }, [{ method: "GET", path: `${P}/releases/tags/v1.0%2Frc`, reply: rel }]);
  await run("get_release", { ...O, release_id: 3 }, [{ method: "GET", path: `${P}/releases/3`, reply: rel }]);
  assert.equal((await run("get_release", O, [])).isError, true);
  await run("create_release", { ...O, tag_name: "v2", generate_release_notes: true, draft: true }, [{ method: "POST", path: `${P}/releases`, exactBody: { tag_name: "v2", draft: true, generate_release_notes: true }, status: 201, reply: rel }]);
  await run("update_release", { ...O, release_id: 3, draft: false }, [{ method: "PATCH", path: `${P}/releases/3`, exactBody: { draft: false }, reply: rel }]);
  ok("releases: list / get (id, tag, latest) / create / update");

  r = data(await run("delete_release", { ...O, release_id: 3, delete_tag: true }, [
    { method: "GET", path: `${P}/releases/3`, reply: rel },
    { method: "DELETE", path: `${P}/releases/3`, status: 204 },
    { method: "DELETE", path: `${P}/git/refs/tags/v1`, status: 204 },
  ]));
  assert.equal(r.tag_deleted, "v1");
  await run("delete_release", { ...O, release_id: 3 }, [{ method: "DELETE", path: `${P}/releases/3`, status: 204 }]);
  await run("delete_release_asset", { ...O, asset_id: 8 }, [{ method: "DELETE", path: `${P}/releases/assets/8`, status: 204 }]);
  ok("delete_release (± xoá tag), delete_release_asset");

  r = data(await run("upload_release_asset", { ...O, release_id: 3, name: "a.zip", content: Buffer.from("PK\u0003\u0004zip").toString("base64"), encoding: "base64" }, [
    { method: "POST", path: `/up${P}/releases/3/assets`, query: { name: "a.zip" }, headers: { "content-type": "application/zip" }, raw: "PK\u0003\u0004zip", status: 201, reply: { id: 8, name: "a.zip", size: 7, content_type: "application/zip", browser_download_url: "https://dl" } },
  ]));
  assert.equal(r.download_url, "https://dl");
  await run("upload_release_asset", { ...O, release_id: 3, name: "notes.txt", content: "xin chào" }, [{ method: "POST", path: `/up${P}/releases/3/assets`, query: { name: "notes.txt" }, headers: { "content-type": "text/plain" }, raw: "xin chào", status: 201, reply: { id: 9, name: "notes.txt" } }]);
  ok("upload_release_asset (base64 + text, gửi tới uploads host, đúng content-type)");

  /* =============================================================== admin */
  const repoObj = { full_name: "o/r", name: "r", private: true, default_branch: "main", topics: ["x"], delete_branch_on_merge: false, security_and_analysis: { secret_scanning: { status: "disabled" } }, permissions: { admin: true } };
  r = data(await run("get_repo_settings", O, [{ method: "GET", path: P, reply: repoObj }]));
  assert.equal(r.security_and_analysis.secret_scanning.status, "disabled");
  r = data(await run("update_repo_settings", { ...O, description: "d", delete_branch_on_merge: true, topics: ["a", "b"] }, [
    { method: "PATCH", path: P, exactBody: { description: "d", delete_branch_on_merge: true }, reply: { ...repoObj, description: "d", delete_branch_on_merge: true } },
    { method: "PUT", path: `${P}/topics`, exactBody: { names: ["a", "b"] }, reply: { names: ["a", "b"] } },
  ]));
  assert.deepEqual(r.topics, ["a", "b"]);
  assert.equal(r.delete_branch_on_merge, true);
  await run("update_repo_settings", { ...O, name: "r2" }, [{ method: "PATCH", path: P, exactBody: { name: "r2" }, reply: { ...repoObj, name: "r2", full_name: "o/r2" } }]);
  await run("update_repo_settings", { ...O, topics: ["only"] }, [{ method: "PUT", path: `${P}/topics`, exactBody: { names: ["only"] }, reply: {} }, { method: "GET", path: P, reply: repoObj }]);
  assert.equal((await run("update_repo_settings", O, [])).isError, true);
  ok("get/update_repo_settings (+ topics, đổi tên)");

  const hook = { id: 4, name: "web", active: true, events: ["push"], config: { url: "https://x.test/h", content_type: "json", secret: "********" }, last_response: { code: 200, status: "active", message: "OK" } };
  r = await run("create_webhook", { ...O, url: "https://x.test/h", secret: "s3cret" }, [{ method: "POST", path: `${P}/hooks`, exactBody: { name: "web", active: true, events: ["push"], config: { url: "https://x.test/h", content_type: "json", insecure_ssl: "0", secret: "s3cret" } }, status: 201, reply: hook }]);
  assert.equal(data(r).has_secret, true);
  assert.ok(!r.content[0].text.includes("********") && !r.content[0].text.includes("s3cret"), "không được lộ secret");
  await run("create_webhook", { ...O, url: "https://x.test/h", events: "push,issues", content_type: "form", active: false }, [{ method: "POST", path: `${P}/hooks`, body: { active: false, events: ["push", "issues"], config: { content_type: "form" } }, status: 201, reply: hook }]);
  await run("list_webhooks", O, [{ method: "GET", path: `${P}/hooks`, query: { per_page: "30", page: "1" }, reply: [hook] }]);
  await run("update_webhook", { ...O, hook_id: 4, events: ["push", "issues"] }, [{ method: "PATCH", path: `${P}/hooks/4`, exactBody: { events: ["push", "issues"] }, reply: hook }]);
  await run("update_webhook", { ...O, hook_id: 4, url: "https://y.test", secret: "n" }, [{ method: "PATCH", path: `${P}/hooks/4`, exactBody: { config: { url: "https://y.test", content_type: "json", insecure_ssl: "0", secret: "n" } }, reply: hook }]);
  assert.equal((await run("update_webhook", { ...O, hook_id: 4, secret: "n" }, [])).isError, true);
  await run("ping_webhook", { ...O, hook_id: 4 }, [{ method: "POST", path: `${P}/hooks/4/pings`, status: 204 }]);
  await run("list_webhook_deliveries", { ...O, hook_id: 4 }, [{ method: "GET", path: `${P}/hooks/4/deliveries`, query: { per_page: "30" }, reply: [{ id: 1, event: "push", status_code: 200 }] }]);
  await run("delete_webhook", { ...O, hook_id: 4 }, [{ method: "DELETE", path: `${P}/hooks/4`, status: 204 }]);
  ok("webhooks: create (không lộ secret) / list / update / ping / deliveries / delete");

  r = data(await run("get_branch_protection", { ...O, branch: "main" }, [{ method: "GET", path: `${P}/branches/main/protection`, reply: { required_status_checks: { strict: true, contexts: ["build"] }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true }, restrictions: null, allow_force_pushes: { enabled: false } } }]));
  assert.equal(r.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(r.enforce_admins, true);
  await run("update_branch_protection", { ...O, branch: "main", required_approving_reviews: 1, required_status_checks: { contexts: ["build"] }, enforce_admins: true }, [
    { method: "PUT", path: `${P}/branches/main/protection`, exactBody: {
      required_status_checks: { strict: true, contexts: ["build"] }, enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_reviews: false },
      restrictions: null, required_linear_history: false, allow_force_pushes: false, allow_deletions: false, required_conversation_resolution: false,
    }, reply: {} },
  ]);
  await run("update_branch_protection", { ...O, branch: "release/1.0", required_status_checks: '{"strict":false,"contexts":["t"]}', allow_force_pushes: true, restrictions: { users: ["u"] } }, [
    { method: "PUT", path: `${P}/branches/release/1.0/protection`, body: { required_status_checks: { strict: false, contexts: ["t"] }, enforce_admins: false, required_pull_request_reviews: null, allow_force_pushes: true, allow_deletions: false, required_linear_history: false, restrictions: { users: ["u"], teams: [], apps: [] } }, reply: {} },
  ]);
  await run("delete_branch_protection", { ...O, branch: "fix#1?/x y" }, [{ method: "DELETE", path: `${P}/branches/fix%231%3F/x%20y/protection`, status: 204 }]);
  await run("delete_branch_protection", { ...O, branch: "main" }, [{ method: "DELETE", path: `${P}/branches/main/protection`, status: 204 }]);
  ok("branch protection: get / set (thay toàn bộ, branch có dấu /, tham số dạng chuỗi JSON) / delete");

  const rs = { id: 6, name: "protect-main", target: "branch", enforcement: "active", conditions: {}, rules: [{ type: "deletion" }] };
  await run("list_rulesets", O, [{ method: "GET", path: `${P}/rulesets`, query: { per_page: "100" }, reply: [rs] }]);
  await run("get_ruleset", { ...O, ruleset_id: 6 }, [{ method: "GET", path: `${P}/rulesets/6`, reply: rs }]);
  await run("create_ruleset", { ...O, ruleset: JSON.stringify({ name: "protect-main", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "deletion" }] }) }, [
    { method: "POST", path: `${P}/rulesets`, body: { name: "protect-main", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] }, status: 201, reply: rs },
  ]);
  assert.equal((await run("create_ruleset", { ...O, ruleset: { name: "x" } }, [])).isError, true);
  await run("update_ruleset", { ...O, ruleset_id: 6, ruleset: { enforcement: "evaluate" } }, [{ method: "PUT", path: `${P}/rulesets/6`, exactBody: { enforcement: "evaluate" }, reply: rs }]);
  await run("delete_ruleset", { ...O, ruleset_id: 6 }, [{ method: "DELETE", path: `${P}/rulesets/6`, status: 204 }]);
  ok("rulesets: list / get / create (JSON string) / update / delete");

  r = data(await run("list_security_alerts", { ...O, kind: "dependabot", severity: "high" }, [{ method: "GET", path: `${P}/dependabot/alerts`, query: { state: "open", severity: "high", per_page: "30", page: "1" }, reply: [{ number: 1, state: "open", dependency: { package: { name: "lodash", ecosystem: "npm" }, manifest_path: "package.json" }, security_advisory: { severity: "high", summary: "Prototype pollution", cve_id: "CVE-1" }, security_vulnerability: { first_patched_version: { identifier: "4.17.21" } } }] }]));
  assert.equal(r.alerts[0].package, "lodash");
  assert.equal(r.alerts[0].fixed_in, "4.17.21");
  await run("list_security_alerts", { ...O, kind: "secret_scanning", severity: "high" }, [{ method: "GET", path: `${P}/secret-scanning/alerts`, query: { state: "open", per_page: "30", page: "1" }, reply: [] }]);
  await run("list_security_alerts", { ...O, kind: "code_scanning", state: "dismissed" }, [{ method: "GET", path: `${P}/code-scanning/alerts`, query: { state: "dismissed", per_page: "30", page: "1" }, reply: [] }]);
  const disabled = await run("list_security_alerts", { ...O, kind: "dependabot" }, [{ method: "GET", path: `${P}/dependabot/alerts`, status: 403, reply: { message: "Dependabot alerts are disabled for this repository." } }]);
  assert.match(disabled.content[0].text, /disabled for this repository/);
  await run("update_security_alert", { ...O, kind: "dependabot", number: 1, state: "dismissed", reason: "not_used", comment: "c" }, [{ method: "PATCH", path: `${P}/dependabot/alerts/1`, exactBody: { state: "dismissed", dismissed_reason: "not_used", dismissed_comment: "c" }, reply: { number: 1, state: "dismissed" } }]);
  await run("update_security_alert", { ...O, kind: "secret_scanning", number: 3, state: "dismissed", reason: "false_positive" }, [{ method: "PATCH", path: `${P}/secret-scanning/alerts/3`, exactBody: { state: "resolved", resolution: "false_positive" }, reply: { number: 3, state: "resolved" } }]);
  ok("security alerts: list (3 loại, lỗi khi tính năng tắt) / update (map đúng trường từng loại)");

  r = data(await run("set_security_features", { ...O, dependabot_alerts: true, dependabot_security_updates: false, secret_scanning: true, secret_scanning_push_protection: false }, [
    { method: "PUT", path: `${P}/vulnerability-alerts`, status: 204 },
    { method: "DELETE", path: `${P}/automated-security-fixes`, status: 204 },
    { method: "PATCH", path: P, exactBody: { security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "disabled" } } }, reply: {} },
  ]));
  assert.equal(r.applied.secret_scanning, true);
  assert.equal((await run("set_security_features", O, [])).isError, true);
  ok("set_security_features");

  /* ================================================ lỗi GitHub được báo lại */
  const nf = await run("get_issue", { ...O, number: 404 }, [{ method: "GET", path: `${P}/issues/404`, status: 404, reply: { message: "Not Found" } }]);
  assert.equal(nf.isError, true);
  assert.match(nf.content[0].text, /GitHub API 404.*Not Found/);
  const miss = await run("create_issue", O, []);
  assert.match(miss.content[0].text, /Missing required argument\(s\): title/);
  ok("Lỗi GitHub (404) và thiếu tham số được báo rõ");

  out(`\nOK — ${passed} nhóm kiểm tra đã qua.`);
} catch (e) {
  out("\nFAIL: " + (e.stack || e));
  if (failures.length) out("Mock ghi nhận: " + failures.join(" | "));
  process.exitCode = 1;
} finally {
  mock.close();
}
