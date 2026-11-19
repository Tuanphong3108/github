/** Nhóm "issues": Issues (tạo/đóng/sửa/bình luận/nhãn/assignee) và Pull Requests (tạo, review, bình luận dòng, merge, đóng). */
import { tool, gh, qs, R, need, defaultBranch, pageQ, login, logins, labelNames, clipText, arr, pick, OWNER, REPO, PAGE_PROPS } from "../github.js";

const NUM = { type: "integer", description: "Issue or pull request number, e.g. 42." };
const STR_ARR = (d) => ({ type: "array", items: { type: "string" }, description: d });
const BODY_MAX = 8000;

const mapIssue = (i, full) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  ...(i.state_reason ? { state_reason: i.state_reason } : {}),
  user: login(i.user),
  labels: labelNames(i.labels),
  assignees: logins(i.assignees),
  milestone: i.milestone?.title ?? null,
  comments: i.comments,
  is_pull_request: !!i.pull_request,
  created_at: i.created_at,
  updated_at: i.updated_at,
  closed_at: i.closed_at,
  url: i.html_url,
  ...(full ? { body: clipText(i.body, BODY_MAX) } : { body_preview: i.body ? clipText(i.body, 200) : null }),
});

const mapComment = (c) => ({ id: c.id, user: login(c.user), created_at: c.created_at, updated_at: c.updated_at, url: c.html_url, body: clipText(c.body, BODY_MAX) });

const mapPR = (p, full) => ({
  number: p.number,
  title: p.title,
  state: p.state,
  draft: p.draft,
  merged: p.merged ?? !!p.merged_at,
  merged_at: p.merged_at,
  user: login(p.user),
  head: { ref: p.head?.ref, sha: p.head?.sha, repo: p.head?.repo?.full_name },
  base: { ref: p.base?.ref, sha: p.base?.sha },
  labels: labelNames(p.labels),
  assignees: logins(p.assignees),
  requested_reviewers: logins(p.requested_reviewers),
  ...(p.mergeable !== undefined ? { mergeable: p.mergeable, mergeable_state: p.mergeable_state } : {}),
  ...(p.changed_files !== undefined ? { commits: p.commits, additions: p.additions, deletions: p.deletions, changed_files: p.changed_files } : {}),
  created_at: p.created_at,
  updated_at: p.updated_at,
  url: p.html_url,
  ...(full ? { body: clipText(p.body, BODY_MAX) } : {}),
});

const mapReviewComment = (c) => ({
  id: c.id,
  review_id: c.pull_request_review_id,
  in_reply_to_id: c.in_reply_to_id ?? undefined,
  user: login(c.user),
  path: c.path,
  line: c.line ?? c.original_line,
  side: c.side,
  commit_id: c.commit_id,
  created_at: c.created_at,
  url: c.html_url,
  body: clipText(c.body, 4000),
});

const issuePath = (a) => `${R(a)}/issues/${a.number}`;
const prPath = (a) => `${R(a)}/pulls/${a.number}`;

export const ISSUE_TOOLS = [
  /* ------------------------------------------------------------------ Issues */
  tool(
    "list_issues",
    "List issues of a repository (pull requests are excluded unless include_prs=true). Filter by state, labels, assignee, creator, date.",
    {
      owner: OWNER,
      repo: REPO,
      state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
      labels: STR_ARR("Only issues having ALL of these labels."),
      assignee: { type: "string", description: 'GitHub username, "none" for unassigned, or "*" for any.' },
      creator: { type: "string", description: "Username of the issue author." },
      mentioned: { type: "string", description: "Username mentioned in the issue." },
      since: { type: "string", description: "Only issues updated after this ISO 8601 time." },
      sort: { type: "string", enum: ["created", "updated", "comments"], description: "Default created." },
      direction: { type: "string", enum: ["asc", "desc"], description: "Default desc." },
      include_prs: { type: "boolean", description: "Also return pull requests (GitHub treats PRs as issues). Default false." },
      ...PAGE_PROPS,
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const labels = arr(a.labels);
      const q = qs({ state: a.state, labels: labels?.join(","), assignee: a.assignee, creator: a.creator, mentioned: a.mentioned, since: a.since, sort: a.sort, direction: a.direction, ...pageQ(a) });
      const data = await gh(t, "GET", `${R(a)}/issues${q}`);
      const items = a.include_prs ? data : data.filter((i) => !i.pull_request);
      return { count: items.length, has_more: data.length === pageQ(a).per_page, issues: items.map((i) => mapIssue(i, false)) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_issue",
    "Get one issue (full body), optionally with its comments.",
    { owner: OWNER, repo: REPO, number: NUM, include_comments: { type: "boolean", description: "Also fetch the comments (up to 100). Default false." } },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const i = await gh(t, "GET", issuePath(a));
      const out = mapIssue(i, true);
      if (a.include_comments && i.comments > 0) out.comment_list = (await gh(t, "GET", `${issuePath(a)}/comments${qs({ per_page: 100 })}`)).map(mapComment);
      return out;
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_issue",
    "Create a new issue, optionally with labels (missing labels are created automatically), assignees and a milestone.",
    {
      owner: OWNER,
      repo: REPO,
      title: { type: "string", description: "Issue title." },
      body: { type: "string", description: "Issue body (Markdown)." },
      labels: STR_ARR("Label names."),
      assignees: STR_ARR("GitHub usernames to assign."),
      milestone: { type: "integer", description: "Milestone number." },
    },
    ["owner", "repo", "title"],
    async (a, t) => {
      need(a, "owner", "repo", "title");
      const i = await gh(t, "POST", `${R(a)}/issues`, { title: a.title, ...pick(a, ["body", "milestone"]), ...(a.labels ? { labels: arr(a.labels) } : {}), ...(a.assignees ? { assignees: arr(a.assignees) } : {}) });
      return mapIssue(i, true);
    },
  ),

  tool(
    "update_issue",
    "Edit an issue: title, body, close/reopen (state), labels (REPLACES the whole label set), assignees (REPLACES the whole set), milestone (null removes it). Works for pull requests' title/body/labels/assignees too.",
    {
      owner: OWNER,
      repo: REPO,
      number: NUM,
      title: { type: "string" },
      body: { type: "string" },
      state: { type: "string", enum: ["open", "closed"], description: "closed = close the issue, open = reopen." },
      state_reason: { type: "string", enum: ["completed", "not_planned", "reopened"], description: "Why it was closed/reopened." },
      labels: STR_ARR("Full list of labels the issue should have afterwards."),
      assignees: STR_ARR("Full list of assignees afterwards. Empty list clears them."),
      milestone: { type: ["integer", "null"], description: "Milestone number, or null to remove." },
    },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const body = pick(a, ["title", "body", "state", "state_reason"]);
      if (a.labels !== undefined) body.labels = arr(a.labels);
      if (a.assignees !== undefined) body.assignees = arr(a.assignees);
      if ("milestone" in a) body.milestone = a.milestone;
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one of title, body, state, labels, assignees, milestone.");
      return mapIssue(await gh(t, "PATCH", issuePath(a), body), true);
    },
  ),

  tool(
    "add_issue_comment",
    "Comment on an issue or on the conversation of a pull request.",
    { owner: OWNER, repo: REPO, number: NUM, body: { type: "string", description: "Comment text (Markdown)." } },
    ["owner", "repo", "number", "body"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "body");
      return mapComment(await gh(t, "POST", `${issuePath(a)}/comments`, { body: a.body }));
    },
  ),

  tool(
    "list_issue_comments",
    "List comments of an issue or a pull request conversation (oldest first).",
    { owner: OWNER, repo: REPO, number: NUM, since: { type: "string", description: "ISO 8601, only comments updated after." }, ...PAGE_PROPS },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const list = await gh(t, "GET", `${issuePath(a)}/comments${qs({ since: a.since, ...pageQ(a) })}`);
      return { count: list.length, has_more: list.length === pageQ(a).per_page, comments: list.map(mapComment) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "edit_issue_comment",
    "Edit the text of an existing issue/PR conversation comment (by comment id).",
    { owner: OWNER, repo: REPO, comment_id: { type: "integer" }, body: { type: "string", description: "New comment text." } },
    ["owner", "repo", "comment_id", "body"],
    async (a, t) => {
      need(a, "owner", "repo", "comment_id", "body");
      return mapComment(await gh(t, "PATCH", `${R(a)}/issues/comments/${a.comment_id}`, { body: a.body }));
    },
  ),

  tool(
    "delete_issue_comment",
    "Delete an issue/PR conversation comment (by comment id). Cannot be undone.",
    { owner: OWNER, repo: REPO, comment_id: { type: "integer" } },
    ["owner", "repo", "comment_id"],
    async (a, t) => {
      need(a, "owner", "repo", "comment_id");
      await gh(t, "DELETE", `${R(a)}/issues/comments/${a.comment_id}`);
      return { deleted: true, comment_id: a.comment_id };
    },
    { destructiveHint: true },
  ),

  tool(
    "list_labels",
    "List the labels defined in a repository.",
    { owner: OWNER, repo: REPO, ...PAGE_PROPS },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const list = await gh(t, "GET", `${R(a)}/labels${qs(pageQ(a, 100))}`);
      return list.map((l) => ({ name: l.name, color: l.color, description: l.description }));
    },
    { readOnlyHint: true },
  ),

  tool(
    "add_labels",
    "ADD labels to an issue or PR, keeping the existing ones (labels that don't exist yet are created).",
    { owner: OWNER, repo: REPO, number: NUM, labels: STR_ARR("Label names to add.") },
    ["owner", "repo", "number", "labels"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "labels");
      return { labels: labelNames(await gh(t, "POST", `${issuePath(a)}/labels`, { labels: arr(a.labels) })) };
    },
  ),

  tool(
    "remove_label",
    "Remove one label from an issue or PR.",
    { owner: OWNER, repo: REPO, number: NUM, label: { type: "string", description: "Label name to remove." } },
    ["owner", "repo", "number", "label"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "label");
      return { labels: labelNames(await gh(t, "DELETE", `${issuePath(a)}/labels/${encodeURIComponent(a.label)}`)) };
    },
  ),

  tool(
    "add_assignees",
    "ADD assignees to an issue or PR, keeping existing ones.",
    { owner: OWNER, repo: REPO, number: NUM, assignees: STR_ARR("GitHub usernames.") },
    ["owner", "repo", "number", "assignees"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "assignees");
      return { assignees: logins((await gh(t, "POST", `${issuePath(a)}/assignees`, { assignees: arr(a.assignees) })).assignees) };
    },
  ),

  tool(
    "remove_assignees",
    "Remove assignees from an issue or PR.",
    { owner: OWNER, repo: REPO, number: NUM, assignees: STR_ARR("GitHub usernames to remove.") },
    ["owner", "repo", "number", "assignees"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "assignees");
      return { assignees: logins((await gh(t, "DELETE", `${issuePath(a)}/assignees`, { assignees: arr(a.assignees) })).assignees) };
    },
  ),

  /* ----------------------------------------------------------- Pull requests */
  tool(
    "list_pull_requests",
    "List pull requests of a repository.",
    {
      owner: OWNER,
      repo: REPO,
      state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
      head: { type: "string", description: "Filter by head, format user:branch." },
      base: { type: "string", description: "Filter by base branch." },
      sort: { type: "string", enum: ["created", "updated", "popularity", "long-running"] },
      direction: { type: "string", enum: ["asc", "desc"] },
      ...PAGE_PROPS,
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const list = await gh(t, "GET", `${R(a)}/pulls${qs({ ...pick(a, ["state", "head", "base", "sort", "direction"]), ...pageQ(a) })}`);
      return { count: list.length, has_more: list.length === pageQ(a).per_page, pull_requests: list.map((p) => mapPR(p, false)) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_pull_request",
    "Get one pull request: state, branches, mergeability (mergeable may be null while GitHub is still computing, retry shortly), size, reviewers, body.",
    { owner: OWNER, repo: REPO, number: NUM },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      return mapPR(await gh(t, "GET", prPath(a)), true);
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_pull_request",
    "Open a pull request from `head` into `base` (default: the default branch). The head branch must already contain commits not in base.",
    {
      owner: OWNER,
      repo: REPO,
      title: { type: "string" },
      head: { type: "string", description: "Branch with the changes. Use user:branch for a fork." },
      base: { type: "string", description: "Branch to merge into. Defaults to the default branch." },
      body: { type: "string", description: "PR description (Markdown)." },
      draft: { type: "boolean", description: "Open as draft." },
      maintainer_can_modify: { type: "boolean" },
    },
    ["owner", "repo", "title", "head"],
    async (a, t) => {
      need(a, "owner", "repo", "title", "head");
      const base = a.base || (await defaultBranch(t, a));
      return mapPR(await gh(t, "POST", `${R(a)}/pulls`, { title: a.title, head: a.head, base, ...pick(a, ["body", "draft", "maintainer_can_modify"]) }), true);
    },
  ),

  tool(
    "update_pull_request",
    "Edit a pull request: title, body, base branch, or close/reopen it (state). Closing does not merge.",
    {
      owner: OWNER,
      repo: REPO,
      number: NUM,
      title: { type: "string" },
      body: { type: "string" },
      base: { type: "string", description: "Retarget to another base branch." },
      state: { type: "string", enum: ["open", "closed"], description: "closed = close WITHOUT merging; open = reopen." },
    },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const body = pick(a, ["title", "body", "base", "state"]);
      if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one of title, body, base, state.");
      return mapPR(await gh(t, "PATCH", prPath(a), body), true);
    },
  ),

  tool(
    "merge_pull_request",
    "Merge a pull request (merge commit, squash or rebase). Fails if not mergeable, checks are required, or the branch moved (when `sha` is given).",
    {
      owner: OWNER,
      repo: REPO,
      number: NUM,
      merge_method: { type: "string", enum: ["merge", "squash", "rebase"], description: "Default merge." },
      commit_title: { type: "string", description: "Title of the merge/squash commit." },
      commit_message: { type: "string", description: "Extra detail for the merge commit message." },
      sha: { type: "string", description: "Expected head SHA; merge is refused if the PR head differs (safety check)." },
    },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const r = await gh(t, "PUT", `${prPath(a)}/merge`, { merge_method: a.merge_method || "merge", ...pick(a, ["commit_title", "commit_message", "sha"]) });
      return { merged: r.merged, sha: r.sha, message: r.message };
    },
    { destructiveHint: true },
  ),

  tool(
    "list_pull_request_files",
    "List the files changed by a pull request (with additions/deletions, optionally the patch of each file).",
    { owner: OWNER, repo: REPO, number: NUM, include_patch: { type: "boolean", description: "Include each file's diff (clipped to 3000 chars). Default false." }, ...PAGE_PROPS },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const list = await gh(t, "GET", `${prPath(a)}/files${qs(pageQ(a, 100))}`);
      return {
        count: list.length,
        has_more: list.length === pageQ(a, 100).per_page,
        files: list.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(a.include_patch && f.patch ? { patch: clipText(f.patch, 3000) } : {}) })),
      };
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_pull_request_diff",
    "Get the full unified diff of a pull request as text (clipped to max_chars).",
    { owner: OWNER, repo: REPO, number: NUM, max_chars: { type: "integer", description: "Default 60000." } },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const d = await gh(t, "GET", prPath(a), undefined, { accept: "application/vnd.github.diff" });
      return typeof d === "string" ? clipText(d, a.max_chars || 60000) : JSON.stringify(d);
    },
    { readOnlyHint: true },
  ),

  tool(
    "list_pull_request_reviews",
    "List the reviews on a pull request (approved / changes requested / commented).",
    { owner: OWNER, repo: REPO, number: NUM, ...PAGE_PROPS },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const list = await gh(t, "GET", `${prPath(a)}/reviews${qs(pageQ(a))}`);
      return list.map((r) => ({ id: r.id, user: login(r.user), state: r.state, submitted_at: r.submitted_at, commit_id: r.commit_id, url: r.html_url, body: clipText(r.body, 2000) }));
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_pull_request_review",
    "Submit a review on a pull request: approve, request changes, or comment — optionally with inline comments on specific lines of the diff, all in one review.",
    {
      owner: OWNER,
      repo: REPO,
      number: NUM,
      event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "Default COMMENT." },
      body: { type: "string", description: "Overall review text (required for REQUEST_CHANGES and for COMMENT without inline comments)." },
      commit_id: { type: "string", description: "Head commit SHA to review. Defaults to the latest." },
      comments: {
        type: "array",
        description: "Inline comments on the diff.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path in the PR." },
            line: { type: "integer", description: "Line number in the file (new version for side RIGHT)." },
            side: { type: "string", enum: ["LEFT", "RIGHT"], description: "RIGHT = added/unchanged lines (default), LEFT = removed lines." },
            start_line: { type: "integer", description: "For multi-line comments: first line." },
            body: { type: "string" },
          },
          required: ["path", "line", "body"],
        },
      },
    },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const comments = (a.comments || []).map((c) => {
        need(c, "path", "line", "body");
        return { path: c.path, line: c.line, side: c.side || "RIGHT", body: c.body, ...(c.start_line ? { start_line: c.start_line, start_side: c.side || "RIGHT" } : {}) };
      });
      const r = await gh(t, "POST", `${prPath(a)}/reviews`, { event: a.event || "COMMENT", ...pick(a, ["body", "commit_id"]), ...(comments.length ? { comments } : {}) });
      return { id: r.id, state: r.state, user: login(r.user), submitted_at: r.submitted_at, url: r.html_url, inline_comments: comments.length };
    },
  ),

  tool(
    "add_pull_request_comment",
    "Leave a single inline comment on a line of a pull request's diff (outside of a review). Use create_pull_request_review to batch several.",
    {
      owner: OWNER,
      repo: REPO,
      number: NUM,
      path: { type: "string", description: "File path in the PR." },
      line: { type: "integer", description: "Line number in the file." },
      body: { type: "string" },
      side: { type: "string", enum: ["LEFT", "RIGHT"], description: "Default RIGHT." },
      start_line: { type: "integer", description: "For a multi-line comment: first line." },
      commit_id: { type: "string", description: "Commit SHA to comment on. Defaults to the PR head." },
    },
    ["owner", "repo", "number", "path", "line", "body"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "path", "line", "body");
      const commit_id = a.commit_id || (await gh(t, "GET", prPath(a))).head.sha;
      const side = a.side || "RIGHT";
      const c = await gh(t, "POST", `${prPath(a)}/comments`, { body: a.body, commit_id, path: a.path, line: a.line, side, ...(a.start_line ? { start_line: a.start_line, start_side: side } : {}) });
      return mapReviewComment(c);
    },
  ),

  tool(
    "reply_to_review_comment",
    "Reply to an existing inline review comment on a pull request (by review comment id).",
    { owner: OWNER, repo: REPO, number: NUM, comment_id: { type: "integer", description: "Id of the review comment to reply to." }, body: { type: "string" } },
    ["owner", "repo", "number", "comment_id", "body"],
    async (a, t) => {
      need(a, "owner", "repo", "number", "comment_id", "body");
      return mapReviewComment(await gh(t, "POST", `${prPath(a)}/comments/${a.comment_id}/replies`, { body: a.body }));
    },
  ),

  tool(
    "list_pull_request_comments",
    "List the inline (line-level) review comments of a pull request.",
    { owner: OWNER, repo: REPO, number: NUM, ...PAGE_PROPS },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      const list = await gh(t, "GET", `${prPath(a)}/comments${qs(pageQ(a))}`);
      return { count: list.length, has_more: list.length === pageQ(a).per_page, comments: list.map(mapReviewComment) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "request_reviewers",
    "Request reviews on a pull request from users and/or teams.",
    { owner: OWNER, repo: REPO, number: NUM, reviewers: STR_ARR("GitHub usernames."), team_reviewers: STR_ARR("Team slugs (organization repos).") },
    ["owner", "repo", "number"],
    async (a, t) => {
      need(a, "owner", "repo", "number");
      if (!a.reviewers && !a.team_reviewers) throw new Error("Pass reviewers and/or team_reviewers.");
      const r = await gh(t, "POST", `${prPath(a)}/requested_reviewers`, { ...(a.reviewers ? { reviewers: arr(a.reviewers) } : {}), ...(a.team_reviewers ? { team_reviewers: arr(a.team_reviewers) } : {}) });
      return { number: r.number, requested_reviewers: logins(r.requested_reviewers), requested_teams: (r.requested_teams || []).map((x) => x.slug) };
    },
  ),
];
