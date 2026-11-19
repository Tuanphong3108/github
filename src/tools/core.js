/** Nhóm "core": repo, file, branch, commit, push, lịch sử commit. */
import { cfg } from "../config.js";
import { tool, gh, ep, qs, R, cleanPath, toB64, need, defaultBranch, branchHead, pushRef, OWNER, REPO, BRANCH, ENCODING } from "../github.js";

export const CORE_TOOLS = [
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
    "create_repo",
    "Create a new GitHub repository for the authenticated user, or inside an organization. Private by default and initialized with a README by default, so the repo is not empty and create_branch/commit_changes work right away.",
    {
      name: { type: "string", description: "Repository name, e.g. my-project" },
      description: { type: "string", description: "Short description." },
      private: { type: "boolean", description: "Create a private repository. Default true." },
      org: { type: "string", description: "Create under this organization instead of the user's account." },
      auto_init: { type: "boolean", description: "Create an initial commit with a README. Default true." },
      gitignore_template: { type: "string", description: "Optional .gitignore template, e.g. Node, Python." },
      license_template: { type: "string", description: "Optional license, e.g. mit, apache-2.0." },
      homepage: { type: "string", description: "Optional homepage URL." },
    },
    ["name"],
    async (a, t) => {
      need(a, "name");
      const r = await gh(t, "POST", a.org ? `/orgs/${encodeURIComponent(a.org)}/repos` : "/user/repos", {
        name: a.name,
        private: a.private !== false,
        auto_init: a.auto_init !== false,
        ...(a.description ? { description: a.description } : {}),
        ...(a.homepage ? { homepage: a.homepage } : {}),
        ...(a.gitignore_template ? { gitignore_template: a.gitignore_template } : {}),
        ...(a.license_template ? { license_template: a.license_template } : {}),
      });
      return { full_name: r.full_name, private: r.private, default_branch: r.default_branch, html_url: r.html_url, clone_url: r.clone_url };
    },
  ),

  tool(
    "fork_repo",
    "Fork a repository into the authenticated user's account (or into an organization). Forking is asynchronous: the fork may take a few seconds before its files are readable. Afterwards open a pull request with create_pull_request using head=\"<your-login>:<branch>\".",
    {
      owner: OWNER,
      repo: REPO,
      organization: { type: "string", description: "Fork into this organization instead of your own account." },
      name: { type: "string", description: "Name for the fork (default: same as the original)." },
      default_branch_only: { type: "boolean", description: "Copy only the default branch. Default false." },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const r = await gh(t, "POST", `${R(a)}/forks`, { ...(a.organization ? { organization: a.organization } : {}), ...(a.name ? { name: a.name } : {}), ...(a.default_branch_only !== undefined ? { default_branch_only: !!a.default_branch_only } : {}) });
      return { full_name: r.full_name, parent: r.parent?.full_name, default_branch: r.default_branch, html_url: r.html_url, note: "Fork is created asynchronously; retry reads after a few seconds if it looks empty." };
    },
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
    "list_commits",
    "List commits of a repository (newest first, or oldest-first from the beginning when from_start=true). Supports filtering by branch/SHA (`sha`), file/directory (`path`), author, and date range (`since` / `until` in ISO 8601 format).",
    {
      owner: OWNER,
      repo: REPO,
      sha: { type: "string", description: "Branch name, tag, or commit SHA to start listing from. Defaults to the default branch." },
      path: { type: "string", description: "Only commits containing this file or directory path." },
      author: { type: "string", description: "GitHub username or email address to filter by." },
      since: { type: "string", description: "Only commits after this ISO 8601 date/time, e.g. 2026-07-01T00:00:00Z." },
      until: { type: "string", description: "Only commits before this ISO 8601 date/time, e.g. 2026-11-19T23:59:59Z." },
      from_start: { type: "boolean", description: "Walk history all the way to the initial commit and return chronological order (oldest first). Default false (newest first)." },
      per_page: { type: "integer", description: "1-100, default 30 (ignored when from_start=true, which auto-paginates)." },
      page: { type: "integer", description: "Page number, default 1 (ignored when from_start=true)." },
      max_commits: { type: "integer", description: "Cap when from_start=true, default 500 (max 2000)." },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const mapCommit = (c) => ({
        sha: c.sha,
        url: c.html_url,
        message: c.commit?.message,
        author: c.commit?.author,
        committer: c.commit?.committer,
        parents: (c.parents || []).map((p) => p.sha),
      });
      const baseQuery = {
        sha: a.sha,
        path: a.path ? cleanPath(a.path) : undefined,
        author: a.author,
        since: a.since,
        until: a.until,
      };
      if (a.from_start) {
        const cap = Math.min(Math.max(a.max_commits || 500, 1), 2000);
        const all = [];
        let page = 1;
        let truncated = false;
        while (all.length < cap) {
          const batch = await gh(t, "GET", `${R(a)}/commits${qs({ ...baseQuery, per_page: 100, page })}`);
          if (!Array.isArray(batch) || !batch.length) break;
          all.push(...batch.map(mapCommit));
          if (batch.length < 100) break;
          if (all.length >= cap) {
            truncated = true;
            break;
          }
          page++;
        }
        const trimmed = all.slice(0, cap).reverse();
        return {
          order: "oldest_first",
          total: trimmed.length,
          truncated,
          commits: trimmed,
        };
      }
      const per_page = Math.min(Math.max(a.per_page || 30, 1), 100);
      const page = Math.max(a.page || 1, 1);
      const data = await gh(t, "GET", `${R(a)}/commits${qs({ ...baseQuery, per_page, page })}`);
      const list = Array.isArray(data) ? data.map(mapCommit) : [];
      return {
        order: "newest_first",
        page,
        per_page,
        count: list.length,
        has_more: list.length === per_page,
        commits: list,
      };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_commit",
    "Inspect a single commit: message, author, parents, stats and changed files (optionally with patches). Use it to verify a commit/push.",
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
