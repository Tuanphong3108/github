/** Nhóm "actions": GitHub Actions (workflow, run, job, log, chạy lại/hủy/kích hoạt) và Releases (tạo/sửa/xóa, đính kèm file). */
import { cfg } from "../config.js";
import { tool, gh, qs, R, need, pageQ, login, clipText, pick, OWNER, REPO, PAGE_PROPS } from "../github.js";

const RUN_ID = { type: "integer", description: "Workflow run id (from list_workflow_runs)." };
const JOB_ID = { type: "integer", description: "Job id (from list_run_jobs)." };
const REL_ID = { type: "integer", description: "Release id (from list_releases)." };
const WF = { type: "string", description: "Workflow id or file name, e.g. ci.yml." };

const mapRun = (r) => ({
  id: r.id,
  name: r.name || r.display_title,
  workflow_id: r.workflow_id,
  run_number: r.run_number,
  run_attempt: r.run_attempt,
  event: r.event,
  status: r.status,
  conclusion: r.conclusion,
  branch: r.head_branch,
  sha: r.head_sha,
  actor: login(r.actor),
  created_at: r.created_at,
  updated_at: r.updated_at,
  url: r.html_url,
});

const mapRelease = (r, full) => ({
  id: r.id,
  tag_name: r.tag_name,
  name: r.name,
  draft: r.draft,
  prerelease: r.prerelease,
  target_commitish: r.target_commitish,
  author: login(r.author),
  created_at: r.created_at,
  published_at: r.published_at,
  url: r.html_url,
  assets: (r.assets || []).map((x) => ({ id: x.id, name: x.name, size: x.size, content_type: x.content_type, downloads: x.download_count, download_url: x.browser_download_url })),
  ...(full ? { body: clipText(r.body, 8000) } : {}),
});

const MIME = { zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", json: "application/json", txt: "text/plain", md: "text/markdown", js: "text/javascript", pdf: "application/pdf", apk: "application/vnd.android.package-archive", png: "image/png", jpg: "image/jpeg", crx: "application/x-chrome-extension" };
const guessMime = (name) => MIME[String(name).split(".").pop().toLowerCase()] || "application/octet-stream";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z /;

export const ACTIONS_TOOLS = [
  /* ------------------------------------------------------------------ Actions */
  tool(
    "list_workflows",
    "List the GitHub Actions workflows of a repository.",
    { owner: OWNER, repo: REPO, ...PAGE_PROPS },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const r = await gh(t, "GET", `${R(a)}/actions/workflows${qs(pageQ(a))}`);
      return { total: r.total_count, workflows: r.workflows.map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "list_workflow_runs",
    "List workflow runs (newest first) of the whole repo or of one workflow. Filter by branch, event, status (queued, in_progress, completed, or a conclusion like failure/success) and actor.",
    {
      owner: OWNER,
      repo: REPO,
      workflow_id: { ...WF, description: "Limit to one workflow: id or file name, e.g. ci.yml. Omit for all workflows." },
      branch: { type: "string" },
      event: { type: "string", description: "push, pull_request, workflow_dispatch, schedule…" },
      status: { type: "string", description: "queued, in_progress, completed, success, failure, cancelled…" },
      actor: { type: "string" },
      ...PAGE_PROPS,
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const base = a.workflow_id ? `${R(a)}/actions/workflows/${encodeURIComponent(a.workflow_id)}/runs` : `${R(a)}/actions/runs`;
      const r = await gh(t, "GET", `${base}${qs({ ...pick(a, ["branch", "event", "status", "actor"]), ...pageQ(a) })}`);
      return { total: r.total_count, count: r.workflow_runs.length, runs: r.workflow_runs.map(mapRun) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_workflow_run",
    "Get one workflow run (status, conclusion, branch, commit, attempt).",
    { owner: OWNER, repo: REPO, run_id: RUN_ID },
    ["owner", "repo", "run_id"],
    async (a, t) => {
      need(a, "owner", "repo", "run_id");
      return mapRun(await gh(t, "GET", `${R(a)}/actions/runs/${a.run_id}`));
    },
    { readOnlyHint: true },
  ),

  tool(
    "list_run_jobs",
    "List the jobs of a workflow run with each step's status/conclusion — use it to find the failing job/step, then read its log with get_job_logs.",
    { owner: OWNER, repo: REPO, run_id: RUN_ID, filter: { type: "string", enum: ["latest", "all"], description: "latest = only the latest attempt (default), all = every attempt." } },
    ["owner", "repo", "run_id"],
    async (a, t) => {
      need(a, "owner", "repo", "run_id");
      const r = await gh(t, "GET", `${R(a)}/actions/runs/${a.run_id}/jobs${qs({ filter: a.filter, per_page: 100 })}`);
      return {
        total: r.total_count,
        jobs: r.jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          run_attempt: j.run_attempt,
          started_at: j.started_at,
          completed_at: j.completed_at,
          failed_steps: (j.steps || []).filter((s) => s.conclusion === "failure").map((s) => s.name),
          steps: (j.steps || []).map((s) => ({ n: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
        })),
      };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_job_logs",
    "Read the log of one job. By default returns the LAST `tail_lines` lines (where failures usually are) with timestamps and colour codes removed. Use `grep` (regex, case-insensitive) to show only matching lines with context, e.g. grep=\"error|failed\".",
    {
      owner: OWNER,
      repo: REPO,
      job_id: JOB_ID,
      tail_lines: { type: "integer", description: "Number of trailing lines to return, default 200. Use 0 for the whole log." },
      grep: { type: "string", description: "Regex; return only matching lines (+context) instead of the tail." },
      context: { type: "integer", description: "Lines of context around each grep match, default 2." },
      keep_timestamps: { type: "boolean", description: "Keep the leading timestamps. Default false." },
      max_chars: { type: "integer", description: "Hard cap on returned characters, default 60000." },
    },
    ["owner", "repo", "job_id"],
    async (a, t) => {
      need(a, "owner", "repo", "job_id");
      let text = await gh(t, "GET", `${R(a)}/actions/jobs/${a.job_id}/logs`, undefined, { accept: "*/*" });
      if (typeof text !== "string") text = JSON.stringify(text);
      let lines = text.split(/\r?\n/).map((l) => {
        const clean = l.replace(ANSI, "");
        return a.keep_timestamps ? clean : clean.replace(STAMP, "");
      });
      const total = lines.length;
      let mode = "tail";
      if (a.grep) {
        let re;
        try {
          re = new RegExp(a.grep, "i");
        } catch {
          re = new RegExp(a.grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        const ctx = Math.max(a.context ?? 2, 0);
        const keep = new Set();
        let hits = 0;
        lines.forEach((l, i) => {
          if (hits < 300 && re.test(l)) {
            hits++;
            for (let k = Math.max(0, i - ctx); k <= Math.min(total - 1, i + ctx); k++) keep.add(k);
          }
        });
        const out = [];
        let prev = -2;
        for (const i of [...keep].sort((x, y) => x - y)) {
          if (i !== prev + 1 && out.length) out.push("--");
          out.push(`${i + 1}: ${lines[i]}`);
          prev = i;
        }
        lines = out;
        mode = `grep (${hits} matching lines)`;
      } else {
        const n = a.tail_lines === undefined ? 200 : a.tail_lines;
        if (n > 0 && lines.length > n) lines = lines.slice(-n);
      }
      const cap = a.max_chars || 60000;
      let body = lines.join("\n");
      const truncated = body.length > cap;
      if (truncated) body = body.slice(-cap); // giữ phần cuối
      return { _blocks: [{ type: "text", text: JSON.stringify({ job_id: a.job_id, total_lines: total, mode, truncated }) }, { type: "text", text: body }] };
    },
    { readOnlyHint: true },
  ),

  tool(
    "rerun_workflow",
    "Re-run a workflow run: everything (default), only its failed jobs (only_failed=true), or one single job (job_id).",
    {
      owner: OWNER,
      repo: REPO,
      run_id: { ...RUN_ID, description: "Workflow run id (not needed when job_id is given)." },
      only_failed: { type: "boolean", description: "Re-run only failed jobs (and their dependants)." },
      job_id: { ...JOB_ID, description: "Re-run just this job." },
      enable_debug_logging: { type: "boolean" },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const dbg = a.enable_debug_logging ? { enable_debug_logging: true } : undefined;
      if (a.job_id) {
        await gh(t, "POST", `${R(a)}/actions/jobs/${a.job_id}/rerun`, dbg);
        return { requested: "job", job_id: a.job_id };
      }
      need(a, "run_id");
      await gh(t, "POST", `${R(a)}/actions/runs/${a.run_id}/${a.only_failed ? "rerun-failed-jobs" : "rerun"}`, dbg);
      return { requested: a.only_failed ? "failed_jobs" : "all_jobs", run_id: a.run_id };
    },
  ),

  tool(
    "cancel_workflow_run",
    "Cancel a workflow run that is queued or in progress.",
    { owner: OWNER, repo: REPO, run_id: RUN_ID, force: { type: "boolean", description: "Force-cancel a run that does not respond to a normal cancel." } },
    ["owner", "repo", "run_id"],
    async (a, t) => {
      need(a, "owner", "repo", "run_id");
      await gh(t, "POST", `${R(a)}/actions/runs/${a.run_id}/${a.force ? "force-cancel" : "cancel"}`);
      return { requested: a.force ? "force-cancel" : "cancel", run_id: a.run_id };
    },
    { destructiveHint: true },
  ),

  tool(
    "dispatch_workflow",
    "Trigger a workflow manually (workflow_dispatch). The workflow file must declare `on: workflow_dispatch`. Returns immediately; use list_workflow_runs to find the new run.",
    {
      owner: OWNER,
      repo: REPO,
      workflow_id: WF,
      ref: { type: "string", description: "Branch or tag to run on, e.g. main." },
      inputs: { type: "object", description: "Workflow inputs as key/value strings.", additionalProperties: { type: "string" } },
    },
    ["owner", "repo", "workflow_id", "ref"],
    async (a, t) => {
      need(a, "owner", "repo", "workflow_id", "ref");
      await gh(t, "POST", `${R(a)}/actions/workflows/${encodeURIComponent(a.workflow_id)}/dispatches`, { ref: a.ref, ...(a.inputs ? { inputs: a.inputs } : {}) });
      return { dispatched: true, workflow: a.workflow_id, ref: a.ref };
    },
  ),

  /* ----------------------------------------------------------------- Releases */
  tool(
    "list_releases",
    "List the releases of a repository (newest first), with their attached assets.",
    { owner: OWNER, repo: REPO, ...PAGE_PROPS },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const list = await gh(t, "GET", `${R(a)}/releases${qs(pageQ(a))}`);
      return { count: list.length, has_more: list.length === pageQ(a).per_page, releases: list.map((r) => mapRelease(r, false)) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_release",
    "Get one release (with notes and assets) by release_id, by tag, or the latest published one.",
    { owner: OWNER, repo: REPO, release_id: REL_ID, tag: { type: "string", description: "Tag name, e.g. v1.0.0." }, latest: { type: "boolean", description: "Get the latest published release." } },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const path = a.release_id ? `/releases/${a.release_id}` : a.tag ? `/releases/tags/${encodeURIComponent(a.tag)}` : a.latest ? "/releases/latest" : null;
      if (!path) throw new Error("Pass release_id, tag, or latest=true.");
      return mapRelease(await gh(t, "GET", `${R(a)}${path}`), true);
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_release",
    "Create a release for a tag (the tag is created from target_commitish if it doesn't exist). Can auto-generate notes, be a draft or pre-release.",
    {
      owner: OWNER,
      repo: REPO,
      tag_name: { type: "string", description: "Tag, e.g. v1.0.0." },
      target_commitish: { type: "string", description: "Branch or commit SHA the tag is created from if missing. Default: default branch." },
      name: { type: "string", description: "Release title." },
      body: { type: "string", description: "Release notes (Markdown)." },
      draft: { type: "boolean", description: "Create unpublished draft." },
      prerelease: { type: "boolean" },
      generate_release_notes: { type: "boolean", description: "Auto-generate notes from merged PRs/commits (appended to body)." },
      make_latest: { type: "string", enum: ["true", "false", "legacy"], description: "Mark as the latest release." },
    },
    ["owner", "repo", "tag_name"],
    async (a, t) => {
      need(a, "owner", "repo", "tag_name");
      return mapRelease(await gh(t, "POST", `${R(a)}/releases`, pick(a, ["tag_name", "target_commitish", "name", "body", "draft", "prerelease", "generate_release_notes", "make_latest"])), true);
    },
  ),

  tool(
    "update_release",
    "Edit a release (title, notes, tag, draft/prerelease flags). Publish a draft by setting draft=false.",
    {
      owner: OWNER,
      repo: REPO,
      release_id: REL_ID,
      tag_name: { type: "string" },
      target_commitish: { type: "string" },
      name: { type: "string" },
      body: { type: "string" },
      draft: { type: "boolean" },
      prerelease: { type: "boolean" },
      make_latest: { type: "string", enum: ["true", "false", "legacy"] },
    },
    ["owner", "repo", "release_id"],
    async (a, t) => {
      need(a, "owner", "repo", "release_id");
      const body = pick(a, ["tag_name", "target_commitish", "name", "body", "draft", "prerelease", "make_latest"]);
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      return mapRelease(await gh(t, "PATCH", `${R(a)}/releases/${a.release_id}`, body), true);
    },
  ),

  tool(
    "delete_release",
    "Delete a release (its assets go with it). The git tag is kept unless delete_tag=true. Cannot be undone.",
    { owner: OWNER, repo: REPO, release_id: REL_ID, delete_tag: { type: "boolean", description: "Also delete the release's git tag." } },
    ["owner", "repo", "release_id"],
    async (a, t) => {
      need(a, "owner", "repo", "release_id");
      let tag = null;
      if (a.delete_tag) tag = (await gh(t, "GET", `${R(a)}/releases/${a.release_id}`)).tag_name;
      await gh(t, "DELETE", `${R(a)}/releases/${a.release_id}`);
      if (tag) await gh(t, "DELETE", `${R(a)}/git/refs/tags/${tag.split("/").map(encodeURIComponent).join("/")}`);
      return { deleted: true, release_id: a.release_id, tag_deleted: tag };
    },
    { destructiveHint: true },
  ),

  tool(
    "upload_release_asset",
    "Attach a file (build output) to a release. Pass the file content as text (default) or base64 for binary files. Practical limit is whatever your client can send in one message (a few MB).",
    {
      owner: OWNER,
      repo: REPO,
      release_id: REL_ID,
      name: { type: "string", description: "File name shown on the release, e.g. app-1.0.zip." },
      content: { type: "string", description: "File content." },
      encoding: { type: "string", enum: ["utf-8", "base64"], description: "How `content` is encoded. Default utf-8." },
      content_type: { type: "string", description: "MIME type. Guessed from the file extension if omitted." },
      label: { type: "string", description: "Optional display label." },
    },
    ["owner", "repo", "release_id", "name", "content"],
    async (a, t) => {
      need(a, "owner", "repo", "release_id", "name");
      if (a.content === undefined || a.content === null) throw new Error("Missing required argument(s): content");
      const bytes = new Uint8Array(a.encoding === "base64" ? Buffer.from(String(a.content).replace(/\s+/g, ""), "base64") : Buffer.from(String(a.content), "utf8"));
      const r = await gh(t, "POST", `${R(a)}/releases/${a.release_id}/assets${qs({ name: a.name, label: a.label })}`, undefined, {
        base: cfg.ghUploads,
        raw: bytes,
        contentType: a.content_type || guessMime(a.name),
      });
      return { id: r.id, name: r.name, size: r.size, content_type: r.content_type, download_url: r.browser_download_url };
    },
  ),

  tool(
    "delete_release_asset",
    "Delete one asset from a release (by asset id, see get_release).",
    { owner: OWNER, repo: REPO, asset_id: { type: "integer" } },
    ["owner", "repo", "asset_id"],
    async (a, t) => {
      need(a, "owner", "repo", "asset_id");
      await gh(t, "DELETE", `${R(a)}/releases/assets/${a.asset_id}`);
      return { deleted: true, asset_id: a.asset_id };
    },
    { destructiveHint: true },
  ),
];
