/** Nhóm "admin": webhook, branch protection, ruleset, cảnh báo bảo mật (Dependabot/secret/code scanning), cài đặt repo. Cần quyền admin trên repo. */
import { tool, gh, qs, ep, R, need, pageQ, login, clipText, arr, obj, pick, OWNER, REPO, PAGE_PROPS } from "../github.js";

const STR_ARR = (d) => ({ type: "array", items: { type: "string" }, description: d });
const HOOK_ID = { type: "integer", description: "Webhook id (from list_webhooks)." };
const BR = { type: "string", description: "Branch name, e.g. main." };

const mapHook = (h) => ({
  id: h.id,
  name: h.name,
  active: h.active,
  events: h.events,
  url: h.config?.url,
  content_type: h.config?.content_type,
  has_secret: !!h.config?.secret,
  last_response: h.last_response ? { code: h.last_response.code, status: h.last_response.status, message: h.last_response.message } : undefined,
  updated_at: h.updated_at,
});

const mapRepo = (r) => ({
  full_name: r.full_name,
  description: r.description,
  homepage: r.homepage,
  private: r.private,
  visibility: r.visibility,
  archived: r.archived,
  default_branch: r.default_branch,
  topics: r.topics,
  has_issues: r.has_issues,
  has_projects: r.has_projects,
  has_wiki: r.has_wiki,
  allow_squash_merge: r.allow_squash_merge,
  allow_merge_commit: r.allow_merge_commit,
  allow_rebase_merge: r.allow_rebase_merge,
  allow_auto_merge: r.allow_auto_merge,
  delete_branch_on_merge: r.delete_branch_on_merge,
  allow_update_branch: r.allow_update_branch,
  security_and_analysis: r.security_and_analysis,
  permissions: r.permissions,
  url: r.html_url,
});

const mapAlert = (x) => ({
  number: x.number,
  state: x.state,
  severity: x.security_advisory?.severity ?? x.security_vulnerability?.severity ?? x.rule?.security_severity_level ?? x.rule?.severity,
  summary: x.security_advisory?.summary ?? x.rule?.description ?? x.secret_type_display_name ?? x.secret_type,
  package: x.dependency?.package?.name,
  ecosystem: x.dependency?.package?.ecosystem,
  manifest: x.dependency?.manifest_path,
  fixed_in: x.security_vulnerability?.first_patched_version?.identifier,
  cve: x.security_advisory?.cve_id,
  tool: x.tool?.name,
  location: x.most_recent_instance?.location,
  created_at: x.created_at,
  url: x.html_url,
});

export const ADMIN_TOOLS = [
  /* ------------------------------------------------------------ Repo settings */
  tool(
    "get_repo_settings",
    "Read a repository's settings: visibility, default branch, topics, merge options, features and security & analysis status.",
    { owner: OWNER, repo: REPO },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      return mapRepo(await gh(t, "GET", R(a)));
    },
    { readOnlyHint: true },
  ),

  tool(
    "update_repo_settings",
    "Change repository settings (only the fields you pass). Needs admin rights. Careful: renaming, changing visibility, changing the default branch or archiving affects everyone using the repo.",
    {
      owner: OWNER,
      repo: REPO,
      name: { type: "string", description: "Rename the repository." },
      description: { type: "string" },
      homepage: { type: "string" },
      visibility: { type: "string", enum: ["public", "private", "internal"] },
      default_branch: { type: "string", description: "Must be an existing branch." },
      archived: { type: "boolean", description: "Archive (read-only) the repository." },
      has_issues: { type: "boolean" },
      has_projects: { type: "boolean" },
      has_wiki: { type: "boolean" },
      allow_squash_merge: { type: "boolean" },
      allow_merge_commit: { type: "boolean" },
      allow_rebase_merge: { type: "boolean" },
      allow_auto_merge: { type: "boolean" },
      allow_update_branch: { type: "boolean" },
      delete_branch_on_merge: { type: "boolean", description: "Auto-delete head branches after a PR is merged." },
      topics: STR_ARR("Replace the repository topics (lowercase, no spaces)."),
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const body = pick(a, ["name", "description", "homepage", "visibility", "default_branch", "archived", "has_issues", "has_projects", "has_wiki", "allow_squash_merge", "allow_merge_commit", "allow_rebase_merge", "allow_auto_merge", "allow_update_branch", "delete_branch_on_merge"]);
      if (!Object.keys(body).length && a.topics === undefined) throw new Error("Nothing to update: pass at least one setting.");
      let repo = a;
      let r = null;
      if (Object.keys(body).length) {
        r = await gh(t, "PATCH", R(a), body);
        repo = { owner: a.owner, repo: r.name };
      }
      if (a.topics !== undefined) await gh(t, "PUT", `${R(repo)}/topics`, { names: arr(a.topics) });
      return mapRepo({ ...(r || (await gh(t, "GET", R(repo)))), ...(a.topics !== undefined ? { topics: arr(a.topics) } : {}) });
    },
    { destructiveHint: true },
  ),

  /* ----------------------------------------------------------------- Webhooks */
  tool(
    "list_webhooks",
    "List the webhooks of a repository (secrets are never shown, only whether one is set) with the status of their last delivery.",
    { owner: OWNER, repo: REPO, ...PAGE_PROPS },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      return (await gh(t, "GET", `${R(a)}/hooks${qs(pageQ(a))}`)).map(mapHook);
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_webhook",
    "Create a repository webhook that POSTs events to a URL.",
    {
      owner: OWNER,
      repo: REPO,
      url: { type: "string", description: "Payload URL (https)." },
      events: STR_ARR('Events to send, e.g. ["push","pull_request","issues"] or ["*"] for all. Default ["push"].'),
      content_type: { type: "string", enum: ["json", "form"], description: "Default json." },
      secret: { type: "string", description: "Secret used to sign payloads (X-Hub-Signature-256)." },
      active: { type: "boolean", description: "Default true." },
    },
    ["owner", "repo", "url"],
    async (a, t) => {
      need(a, "owner", "repo", "url");
      const h = await gh(t, "POST", `${R(a)}/hooks`, {
        name: "web",
        active: a.active !== false,
        events: arr(a.events) || ["push"],
        config: { url: a.url, content_type: a.content_type || "json", insecure_ssl: "0", ...(a.secret ? { secret: a.secret } : {}) },
      });
      return mapHook(h);
    },
  ),

  tool(
    "update_webhook",
    "Update a webhook. `events` and `active` change on their own. To change url / content_type / secret pass `url` together with the others: GitHub REPLACES the whole config, so omitted content_type falls back to json and an omitted secret is removed.",
    {
      owner: OWNER,
      repo: REPO,
      hook_id: HOOK_ID,
      events: STR_ARR("Replace the subscribed events."),
      active: { type: "boolean" },
      url: { type: "string", description: "New payload URL (starts a config replace)." },
      content_type: { type: "string", enum: ["json", "form"] },
      secret: { type: "string" },
    },
    ["owner", "repo", "hook_id"],
    async (a, t) => {
      need(a, "owner", "repo", "hook_id");
      const body = pick(a, ["active"]);
      if (a.events !== undefined) body.events = arr(a.events);
      if (a.url || a.content_type || a.secret) {
        if (!a.url) throw new Error("Changing content_type/secret needs `url` too (the config is replaced as a whole).");
        body.config = { url: a.url, content_type: a.content_type || "json", insecure_ssl: "0", ...(a.secret ? { secret: a.secret } : {}) };
      }
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      return mapHook(await gh(t, "PATCH", `${R(a)}/hooks/${a.hook_id}`, body));
    },
  ),

  tool(
    "delete_webhook",
    "Delete a repository webhook. Cannot be undone.",
    { owner: OWNER, repo: REPO, hook_id: HOOK_ID },
    ["owner", "repo", "hook_id"],
    async (a, t) => {
      need(a, "owner", "repo", "hook_id");
      await gh(t, "DELETE", `${R(a)}/hooks/${a.hook_id}`);
      return { deleted: true, hook_id: a.hook_id };
    },
    { destructiveHint: true },
  ),

  tool(
    "ping_webhook",
    "Send a ping event to a webhook to test that the receiver responds.",
    { owner: OWNER, repo: REPO, hook_id: HOOK_ID },
    ["owner", "repo", "hook_id"],
    async (a, t) => {
      need(a, "owner", "repo", "hook_id");
      await gh(t, "POST", `${R(a)}/hooks/${a.hook_id}/pings`);
      return { pinged: true, hook_id: a.hook_id };
    },
  ),

  tool(
    "list_webhook_deliveries",
    "List recent deliveries of a webhook (status code, event, redelivery flag) to debug a receiver.",
    { owner: OWNER, repo: REPO, hook_id: HOOK_ID, per_page: { type: "integer", description: "1-100, default 30." } },
    ["owner", "repo", "hook_id"],
    async (a, t) => {
      need(a, "owner", "repo", "hook_id");
      const list = await gh(t, "GET", `${R(a)}/hooks/${a.hook_id}/deliveries${qs({ per_page: pageQ(a).per_page })}`);
      return list.map((d) => ({ id: d.id, event: d.event, action: d.action, status: d.status, status_code: d.status_code, delivered_at: d.delivered_at, redelivery: d.redelivery, duration: d.duration }));
    },
    { readOnlyHint: true },
  ),

  /* -------------------------------------------------------- Branch protection */
  tool(
    "get_branch_protection",
    "Read the classic branch protection rules of a branch (404 'Branch not protected' means there are none).",
    { owner: OWNER, repo: REPO, branch: BR },
    ["owner", "repo", "branch"],
    async (a, t) => {
      need(a, "owner", "repo", "branch");
      const p = await gh(t, "GET", `${R(a)}/branches/${ep(a.branch)}/protection`);
      return {
        required_status_checks: p.required_status_checks && { strict: p.required_status_checks.strict, contexts: p.required_status_checks.contexts },
        enforce_admins: p.enforce_admins?.enabled,
        required_pull_request_reviews: p.required_pull_request_reviews && {
          required_approving_review_count: p.required_pull_request_reviews.required_approving_review_count,
          dismiss_stale_reviews: p.required_pull_request_reviews.dismiss_stale_reviews,
          require_code_owner_reviews: p.required_pull_request_reviews.require_code_owner_reviews,
        },
        restrictions: p.restrictions && { users: (p.restrictions.users || []).map((u) => u.login), teams: (p.restrictions.teams || []).map((x) => x.slug), apps: (p.restrictions.apps || []).map((x) => x.slug) },
        required_linear_history: p.required_linear_history?.enabled,
        allow_force_pushes: p.allow_force_pushes?.enabled,
        allow_deletions: p.allow_deletions?.enabled,
        required_conversation_resolution: p.required_conversation_resolution?.enabled,
      };
    },
    { readOnlyHint: true },
  ),

  tool(
    "update_branch_protection",
    "SET the branch protection of a branch. This REPLACES the whole protection config: anything you don't pass is turned off. Read it first with get_branch_protection if you only want to tweak one thing.",
    {
      owner: OWNER,
      repo: REPO,
      branch: BR,
      required_approving_reviews: { type: ["integer", "null"], description: "Require a pull request with this many approvals (0-6). Omit/null = no PR required." },
      dismiss_stale_reviews: { type: "boolean", description: "New commits dismiss existing approvals (needs required_approving_reviews)." },
      require_code_owner_reviews: { type: "boolean", description: "Needs required_approving_reviews." },
      required_status_checks: { type: "object", description: 'Require checks to pass: {"strict": true, "contexts": ["build", "test"]}. Omit = none.', properties: { strict: { type: "boolean" }, contexts: STR_ARR("Check names.") } },
      enforce_admins: { type: "boolean", description: "Apply the rules to admins too." },
      required_linear_history: { type: "boolean" },
      allow_force_pushes: { type: "boolean" },
      allow_deletions: { type: "boolean" },
      required_conversation_resolution: { type: "boolean" },
      restrictions: { type: "object", description: "Who may push (organization repos only): {users:[], teams:[], apps:[]}. Omit = anyone with write access.", properties: { users: STR_ARR("Usernames."), teams: STR_ARR("Team slugs."), apps: STR_ARR("App slugs.") } },
    },
    ["owner", "repo", "branch"],
    async (a, t) => {
      need(a, "owner", "repo", "branch");
      const sc = obj(a.required_status_checks, "required_status_checks");
      const rs = obj(a.restrictions, "restrictions");
      const reviews = a.required_approving_reviews;
      const body = {
        required_status_checks: sc ? { strict: sc.strict !== false, contexts: arr(sc.contexts) || [] } : null,
        enforce_admins: !!a.enforce_admins,
        required_pull_request_reviews:
          reviews === undefined || reviews === null
            ? null
            : { required_approving_review_count: reviews, dismiss_stale_reviews: !!a.dismiss_stale_reviews, require_code_owner_reviews: !!a.require_code_owner_reviews },
        restrictions: rs ? { users: arr(rs.users) || [], teams: arr(rs.teams) || [], apps: arr(rs.apps) || [] } : null,
        required_linear_history: !!a.required_linear_history,
        allow_force_pushes: !!a.allow_force_pushes,
        allow_deletions: !!a.allow_deletions,
        required_conversation_resolution: !!a.required_conversation_resolution,
      };
      await gh(t, "PUT", `${R(a)}/branches/${ep(a.branch)}/protection`, body);
      return { branch: a.branch, protected: true, applied: body };
    },
    { destructiveHint: true },
  ),

  tool(
    "delete_branch_protection",
    "Remove ALL classic branch protection from a branch.",
    { owner: OWNER, repo: REPO, branch: BR },
    ["owner", "repo", "branch"],
    async (a, t) => {
      need(a, "owner", "repo", "branch");
      await gh(t, "DELETE", `${R(a)}/branches/${ep(a.branch)}/protection`);
      return { branch: a.branch, protected: false };
    },
    { destructiveHint: true },
  ),

  /* ----------------------------------------------------------------- Rulesets */
  tool(
    "list_rulesets",
    "List the repository rulesets (the newer replacement for branch protection).",
    { owner: OWNER, repo: REPO, include_parents: { type: "boolean", description: "Also include org-level rulesets that apply. Default true." } },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const list = await gh(t, "GET", `${R(a)}/rulesets${qs({ includes_parents: a.include_parents === false ? "false" : undefined, per_page: 100 })}`);
      return list.map((x) => ({ id: x.id, name: x.name, target: x.target, enforcement: x.enforcement, source_type: x.source_type }));
    },
    { readOnlyHint: true },
  ),

  tool(
    "get_ruleset",
    "Get one ruleset in full (conditions and rules).",
    { owner: OWNER, repo: REPO, ruleset_id: { type: "integer" } },
    ["owner", "repo", "ruleset_id"],
    async (a, t) => {
      need(a, "owner", "repo", "ruleset_id");
      const x = await gh(t, "GET", `${R(a)}/rulesets/${a.ruleset_id}`);
      return pick(x, ["id", "name", "target", "enforcement", "conditions", "rules", "bypass_actors", "source_type"]);
    },
    { readOnlyHint: true },
  ),

  tool(
    "create_ruleset",
    'Create a repository ruleset. `ruleset` is the GitHub ruleset object. Example (protect the default branch: no deletion, no force-push, PR with 1 approval): {"name":"protect-main","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"pull_request","parameters":{"required_approving_review_count":1,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}}]}. enforcement: active | evaluate | disabled.',
    { owner: OWNER, repo: REPO, ruleset: { type: "object", description: "Ruleset definition (object or JSON string): name, target (branch|tag|push), enforcement, conditions, rules, bypass_actors." } },
    ["owner", "repo", "ruleset"],
    async (a, t) => {
      need(a, "owner", "repo", "ruleset");
      const body = obj(a.ruleset, "ruleset");
      if (!body.name || !body.enforcement) throw new Error("ruleset needs at least `name` and `enforcement`.");
      const x = await gh(t, "POST", `${R(a)}/rulesets`, { target: "branch", ...body });
      return pick(x, ["id", "name", "target", "enforcement", "conditions", "rules"]);
    },
  ),

  tool(
    "update_ruleset",
    "Update a ruleset: pass the fields to change (e.g. enforcement, rules). `rules` and `conditions`, if given, replace the existing ones entirely.",
    { owner: OWNER, repo: REPO, ruleset_id: { type: "integer" }, ruleset: { type: "object", description: "Fields to change (object or JSON string)." } },
    ["owner", "repo", "ruleset_id", "ruleset"],
    async (a, t) => {
      need(a, "owner", "repo", "ruleset_id", "ruleset");
      const body = obj(a.ruleset, "ruleset");
      if (!Object.keys(body).length) throw new Error("Nothing to update.");
      const x = await gh(t, "PUT", `${R(a)}/rulesets/${a.ruleset_id}`, body);
      return pick(x, ["id", "name", "target", "enforcement", "conditions", "rules"]);
    },
    { destructiveHint: true },
  ),

  tool(
    "delete_ruleset",
    "Delete a ruleset. Cannot be undone.",
    { owner: OWNER, repo: REPO, ruleset_id: { type: "integer" } },
    ["owner", "repo", "ruleset_id"],
    async (a, t) => {
      need(a, "owner", "repo", "ruleset_id");
      await gh(t, "DELETE", `${R(a)}/rulesets/${a.ruleset_id}`);
      return { deleted: true, ruleset_id: a.ruleset_id };
    },
    { destructiveHint: true },
  ),

  /* ----------------------------------------------------------------- Security */
  tool(
    "list_security_alerts",
    "List security alerts of a repository: Dependabot (vulnerable dependencies), secret scanning (leaked secrets) or code scanning (CodeQL etc.). Errors if that feature is disabled for the repo — enable it with set_security_features.",
    {
      owner: OWNER,
      repo: REPO,
      kind: { type: "string", enum: ["dependabot", "secret_scanning", "code_scanning"] },
      state: { type: "string", description: "dependabot: open|dismissed|fixed|auto_dismissed. secret_scanning: open|resolved. code_scanning: open|closed|dismissed|fixed. Default open." },
      severity: { type: "string", description: "dependabot: low|medium|high|critical. code_scanning: critical|high|medium|low|warning|note|error." },
      package: { type: "string", description: "Dependabot only: package name(s), comma-separated." },
      ...PAGE_PROPS,
    },
    ["owner", "repo", "kind"],
    async (a, t) => {
      need(a, "owner", "repo", "kind");
      const path = { dependabot: "dependabot/alerts", secret_scanning: "secret-scanning/alerts", code_scanning: "code-scanning/alerts" }[a.kind];
      if (!path) throw new Error("kind must be dependabot, secret_scanning or code_scanning.");
      const q = qs({ state: a.state || "open", severity: a.kind === "secret_scanning" ? undefined : a.severity, package: a.kind === "dependabot" ? a.package : undefined, ...pageQ(a) });
      const list = await gh(t, "GET", `${R(a)}/${path}${q}`);
      return { kind: a.kind, count: list.length, has_more: list.length === pageQ(a).per_page, alerts: list.map(mapAlert) };
    },
    { readOnlyHint: true },
  ),

  tool(
    "update_security_alert",
    "Dismiss/resolve or reopen a security alert. dependabot & code_scanning: state open|dismissed + dismissed_reason. secret_scanning: state open|resolved + resolution.",
    {
      owner: OWNER,
      repo: REPO,
      kind: { type: "string", enum: ["dependabot", "secret_scanning", "code_scanning"] },
      number: { type: "integer", description: "Alert number." },
      state: { type: "string", enum: ["open", "dismissed", "resolved"] },
      reason: { type: "string", description: "dependabot: fix_started|inaccurate|no_bandwidth|not_used|tolerable_risk. code_scanning: false positive|won't fix|used in tests. secret_scanning: false_positive|wont_fix|revoked|used_in_tests." },
      comment: { type: "string", description: "Optional explanation." },
    },
    ["owner", "repo", "kind", "number", "state"],
    async (a, t) => {
      need(a, "owner", "repo", "kind", "number", "state");
      const base = { dependabot: "dependabot/alerts", secret_scanning: "secret-scanning/alerts", code_scanning: "code-scanning/alerts" }[a.kind];
      if (!base) throw new Error("kind must be dependabot, secret_scanning or code_scanning.");
      let body;
      if (a.kind === "secret_scanning") {
        body = { state: a.state === "dismissed" ? "resolved" : a.state, ...(a.reason ? { resolution: a.reason } : {}), ...(a.comment ? { resolution_comment: a.comment } : {}) };
      } else {
        body = { state: a.state === "resolved" ? "dismissed" : a.state, ...(a.reason ? { dismissed_reason: a.reason } : {}), ...(a.comment ? { dismissed_comment: a.comment } : {}) };
      }
      return mapAlert(await gh(t, "PATCH", `${R(a)}/${base}/${a.number}`, body));
    },
    { destructiveHint: true },
  ),

  tool(
    "set_security_features",
    "Turn repository security features on/off: Dependabot alerts, Dependabot security updates (auto fix PRs), secret scanning, push protection for secrets. Pass only what you want to change.",
    {
      owner: OWNER,
      repo: REPO,
      dependabot_alerts: { type: "boolean" },
      dependabot_security_updates: { type: "boolean", description: "Needs dependabot_alerts enabled." },
      secret_scanning: { type: "boolean", description: "Free for public repos; private repos need GitHub Advanced Security." },
      secret_scanning_push_protection: { type: "boolean" },
    },
    ["owner", "repo"],
    async (a, t) => {
      need(a, "owner", "repo");
      const applied = {};
      if (a.dependabot_alerts !== undefined) {
        await gh(t, a.dependabot_alerts ? "PUT" : "DELETE", `${R(a)}/vulnerability-alerts`);
        applied.dependabot_alerts = a.dependabot_alerts;
      }
      if (a.dependabot_security_updates !== undefined) {
        await gh(t, a.dependabot_security_updates ? "PUT" : "DELETE", `${R(a)}/automated-security-fixes`);
        applied.dependabot_security_updates = a.dependabot_security_updates;
      }
      const sa = {};
      if (a.secret_scanning !== undefined) sa.secret_scanning = { status: a.secret_scanning ? "enabled" : "disabled" };
      if (a.secret_scanning_push_protection !== undefined) sa.secret_scanning_push_protection = { status: a.secret_scanning_push_protection ? "enabled" : "disabled" };
      if (Object.keys(sa).length) {
        await gh(t, "PATCH", R(a), { security_and_analysis: sa });
        if (a.secret_scanning !== undefined) applied.secret_scanning = a.secret_scanning;
        if (a.secret_scanning_push_protection !== undefined) applied.secret_scanning_push_protection = a.secret_scanning_push_protection;
      }
      if (!Object.keys(applied).length) throw new Error("Nothing to change: pass at least one feature.");
      return { repo: `${a.owner}/${a.repo}`, applied };
    },
    { destructiveHint: true },
  ),
];
