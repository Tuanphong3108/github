# Github Remote Repository (GitHub MCP Server cho Gemini Custom Connector)

MCP server (Streamable HTTP) kèm OAuth 2.0 để Gemini quản lý repo GitHub tự chủ: duyệt, đọc, tạo/sửa/xoá file, tạo branch, commit, push. Không có dependency ngoài.

Chạy được 2 nơi, cùng một lõi `src/app.js`:

| Entry point | Chạy ở đâu |
|---|---|
| `worker.js` | **Cloudflare Workers** (free, không bị ngủ, deploy hoàn toàn bằng Dashboard) |
| `server.js` | Node >= 20: Render, Railway, Fly, Docker, máy local + tunnel |

## Tools (73)

Chia 4 nhóm, bật/tắt bằng biến `TOOL_GROUPS` (xem bên dưới). Mặc định bật tất cả.

### `core` — repo, file, branch, commit (13)

| Tool | Chức năng |
|---|---|
| `list_repos` | Liệt kê repository (của bạn, cộng tác, hoặc của 1 org) |
| `fork_repo` | Fork repo của người khác về tài khoản của bạn (hoặc org) để tạo PR từ fork |
| `create_repo` | Tạo repository mới (của bạn hoặc trong org). Mặc định **private** và có README |
| `list_files` | Duyệt cây thư mục (1 cấp hoặc `recursive`) |
| `read_file` | Đọc nội dung file (hỗ trợ `start_line`/`end_line`, file > 1MB, binary base64) |
| `create_file` | Tạo file, commit thẳng lên branch (chạy được cả repo rỗng) |
| `update_file` | Sửa file (tự lấy `sha` nếu không truyền) |
| `delete_file` | Xoá file (tự lấy `sha` nếu không truyền) |
| `create_branch` | Tạo branch từ branch khác hoặc từ commit SHA |
| `commit_changes` | Tạo **1 commit** gồm nhiều thay đổi (upsert/delete nhiều file). Chưa di chuyển branch |
| `push_changes` | Đẩy commit lên branch (tạo branch nếu chưa có). Fast-forward, hoặc `force=true` |
| `list_commits` | Danh sách commit (mới nhất trước, hoặc từ commit đầu với `from_start=true`, lọc `since`/`until`, `path`, `author`) |
| `get_commit` | Chi tiết 1 commit: message, parent, stats, file đổi, patch |

### `issues` — Issues & Pull Requests (26)

| Tool | Chức năng |
|---|---|
| `list_issues` / `get_issue` | Liệt kê (lọc state, nhãn, assignee, ngày) / xem 1 issue kèm comment |
| `create_issue` / `update_issue` | Tạo / sửa, **đóng–mở lại**, đặt nhãn, assignee, milestone |
| `add_labels` / `remove_label` / `list_labels` | Gắn / gỡ / xem nhãn |
| `add_assignees` / `remove_assignees` | Thêm / bỏ người phụ trách |
| `add_issue_comment` / `list_issue_comments` / `edit_issue_comment` / `delete_issue_comment` | Bình luận issue hoặc thảo luận của PR |
| `list_pull_requests` / `get_pull_request` | Danh sách PR / chi tiết (mergeable, size, reviewer) |
| `create_pull_request` / `update_pull_request` | Tạo PR (base mặc định = default branch) / sửa, **đóng PR không merge** |
| `merge_pull_request` | Gộp nhánh: `merge`, `squash` hoặc `rebase`, có thể kèm `sha` làm chốt an toàn |
| `list_pull_request_files` / `get_pull_request_diff` | File đổi / diff đầy đủ |
| `create_pull_request_review` | Review: approve / request changes / comment, kèm **bình luận từng dòng** trong 1 lần |
| `add_pull_request_comment` / `reply_to_review_comment` / `list_pull_request_comments` | Bình luận 1 dòng của diff / trả lời / xem |
| `list_pull_request_reviews` / `request_reviewers` | Xem review / yêu cầu review |

### `actions` — GitHub Actions & Releases (15)

| Tool | Chức năng |
|---|---|
| `list_workflows` / `list_workflow_runs` / `get_workflow_run` | Workflow, các lần chạy (lọc branch, event, trạng thái), chi tiết 1 lần chạy |
| `list_run_jobs` | Job + từng step của 1 lần chạy, chỉ ra step bị fail |
| `get_job_logs` | Đọc log của 1 job: mặc định 200 dòng cuối (bỏ timestamp/màu), hoặc `grep` regex kèm ngữ cảnh |
| `rerun_workflow` | Chạy lại tất cả / chỉ job lỗi / 1 job |
| `cancel_workflow_run` | Huỷ (có `force`) |
| `dispatch_workflow` | Kích hoạt `workflow_dispatch` với `inputs` |
| `list_releases` / `get_release` | Xem release (theo id, tag, hoặc mới nhất) kèm asset |
| `create_release` / `update_release` / `delete_release` | Tạo (có tự sinh release notes, draft, pre-release) / sửa (đặt `draft=false` để publish) / xoá (tuỳ chọn xoá luôn tag) |
| `upload_release_asset` / `delete_release_asset` | Đính kèm file build (text hoặc base64) / xoá asset |

### `admin` — webhook, bảo vệ branch, bảo mật, cài đặt repo (19)

Cần tài khoản GitHub của bạn có quyền **admin** trên repo.

| Tool | Chức năng |
|---|---|
| `get_repo_settings` / `update_repo_settings` | Xem / đổi mô tả, visibility, default branch, kiểu merge, tự xoá branch sau merge, topics, archive, đổi tên |
| `list_webhooks` / `create_webhook` / `update_webhook` / `delete_webhook` | Quản lý webhook (secret không bao giờ được trả ra, chỉ có `has_secret`) |
| `ping_webhook` / `list_webhook_deliveries` | Gửi ping thử / xem lịch sử giao hàng để debug |
| `get_branch_protection` / `update_branch_protection` / `delete_branch_protection` | Branch protection cổ điển (số approval, status check, enforce admin, force-push…). `update` **thay toàn bộ** cấu hình |
| `list_rulesets` / `get_ruleset` / `create_ruleset` / `update_ruleset` / `delete_ruleset` | Ruleset (bản thay thế mới của branch protection) |
| `list_security_alerts` / `update_security_alert` | Cảnh báo Dependabot, secret scanning, code scanning: xem / dismiss–resolve–mở lại |
| `set_security_features` | Bật/tắt Dependabot alerts, Dependabot security updates, secret scanning, push protection |

GitHub API không có "local commit" thật, nên: `commit_changes` tạo commit object (chưa trỏ branch nào) và trả về `commit_sha`; `push_changes` mới trỏ branch vào commit đó. Muốn gộp 1 bước thì `commit_changes` với `push: true`. Muốn nối nhiều commit trước khi push thì truyền `parent_sha` = `commit_sha` của commit trước.

`create_file` / `update_file` / `delete_file` là 1 commit riêng đẩy thẳng lên branch (không qua bước push).

## Cài đặt

### 1. Sinh cặp OAuth để điền vào Gemini

Không có terminal thì mở Console của Chrome (`Ctrl+Shift+J`, gõ `allow pasting` nếu bị chặn) rồi dán:

```js
const r=n=>[...crypto.getRandomValues(new Uint8Array(n))].map(b=>b.toString(16).padStart(2,'0')).join('');console.log('MCP_CLIENT_ID=gh-mcp-'+r(6)+'\nMCP_CLIENT_SECRET='+r(32)+'\nSESSION_SECRET='+r(32))
```

Hoặc có Node thì `npm run gen-creds`. Cặp `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` là thứ điền vào Gemini, **không phải** cặp của GitHub.

### 2a. Deploy lên Cloudflare Workers (bằng Dashboard)

1. Dashboard → **Workers & Pages** → **Create** → **Import a repository** → chọn repo này.
2. Tên project/Worker để đúng `github-mcp` (khớp `name` trong `wrangler.toml`). Build command để trống, Deploy command `npx wrangler deploy`. Bấm **Save and Deploy**.
3. Lấy URL dạng `https://github-mcp.<subdomain>.workers.dev` (chưa chạy được đến khi có biến, mở thử sẽ báo `misconfigured`, bình thường).
4. Tạo GitHub OAuth App (bước 3 bên dưới) với URL vừa lấy.
5. Worker → **Settings → Variables and Secrets** → thêm (chọn type **Secret**):
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `MCP_CLIENT_ID`, `MCP_CLIENT_SECRET`, `SESSION_SECRET`.
   Không cần `PUBLIC_URL` (tự suy từ URL của Worker). Dùng custom domain thì vẫn chạy bình thường.
6. Mở `<URL>/health` thấy `{"ok":true,...}` là xong.

`wrangler.toml` đã có `nodejs_compat` và `keep_vars = true`, nên deploy lại không làm mất biến.

### 2b. Hoặc deploy lên Node host (Render, Railway…)

Build `npm install`, Start `npm start`, set env:

```
PUBLIC_URL=https://ten-app.onrender.com
GITHUB_CLIENT_ID=...  GITHUB_CLIENT_SECRET=...
MCP_CLIENT_ID=...     MCP_CLIENT_SECRET=...
SESSION_SECRET=...
```

Chạy local + tunnel: `cp .env.example .env`, điền giá trị, `cloudflared tunnel --url http://localhost:3000` rồi gán URL https vào `PUBLIC_URL`, `npm run dev`.

### 3. Tạo GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App

- Homepage URL: URL của server (https, không có `/` cuối)
- Authorization callback URL: `<URL>/oauth/callback`

Lấy **Client ID**, bấm *Generate a new client secret* → `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

### 4. Điền vào Gemini (Kết nối với máy chủ MCP)

| Ô | Giá trị |
|---|---|
| URL của máy chủ MCP | `<URL>/mcp` |
| Mã ứng dụng khách | `MCP_CLIENT_ID` |
| Khoá bí mật của ứng dụng khách | `MCP_CLIENT_SECRET` |

Bấm **Tiếp theo** → đăng nhập GitHub → Authorize.

## Biến môi trường

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | ✓ | OAuth App của GitHub |
| `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` | ✓ | Cặp bạn điền vào Gemini |
| `SESSION_SECRET` | khuyến nghị | Khoá mã hoá token. Đổi = phải kết nối lại |
| `PUBLIC_URL` | | URL https công khai, không có `/` cuối. Bỏ trống thì suy từ request (Workers: không cần) |
| `GITHUB_SCOPES` | | Mặc định `repo` (đủ cho cả 72 tool). Thêm `workflow` nếu cần **sửa file** trong `.github/workflows` |
| `TOOL_GROUPS` | | Nhóm tool bật, phân cách bằng phẩy: `core`, `issues`, `actions`, `admin`, hoặc `all` (mặc định). VD `core,issues` để Gemini chỉ thấy ít tool hơn |
| `GITHUB_UPLOADS_URL` | | Chỉ để test/GitHub Enterprise, mặc định `https://uploads.github.com` |
| `ALLOWED_REDIRECT_URIS` | | Danh sách (phẩy) prefix redirect URI cho phép. Trống = mọi https |
| `PORT` | | Chỉ cho `server.js`, mặc định 3000 |

## Test

```bash
npm test
```

- `test/smoke.mjs`: dựng GitHub giả in-memory, chạy server thật, đi hết luồng OAuth (PKCE) và các tool `core`.
- `test/tools.mjs`: mock GitHub kiểm tra các tool `issues` / `actions` / `admin` gọi **đúng method, đường dẫn, query, body** và xử lý kết quả/lỗi. Muốn thử bản Worker trên runtime thật: chạy `wrangler dev` với các `--var` trỏ `GITHUB_API_URL`/`GITHUB_WEB_URL` về `http://127.0.0.1:<MOCK_PORT>`, rồi `SMOKE_BASE=http://127.0.0.1:<port> MOCK_PORT=<MOCK_PORT> node test/smoke.mjs`.

## Bảo mật

- Quyền thực tế = quyền của tài khoản GitHub bạn đăng nhập, trong phạm vi scope `repo`. Scope `repo` cho phép ghi **mọi** repo của bạn, nên chỉ chia sẻ `MCP_CLIENT_SECRET` với Gemini.
- Auth code sống 5 phút, state 10 phút; token không hết hạn (như token OAuth App của GitHub). Muốn thu hồi: Settings → Applications → Authorized OAuth Apps → Revoke, hoặc đổi `SESSION_SECRET`.
- Nhiều tool có thể **không hoàn tác** (`merge_pull_request`, `delete_*`, `update_branch_protection`, `update_repo_settings`, `push_changes force`). Chúng được đánh dấu `destructiveHint` để client có thể hỏi xác nhận, và nên dặn Gemini hỏi lại trước khi chạy.
- `force=true` ở `push_changes` ghi đè lịch sử branch, chỉ dùng khi chắc chắn.
