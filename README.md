# Github Remote Repository (GitHub MCP Server cho Gemini Custom Connector)

MCP server (Streamable HTTP) kèm OAuth 2.0 để Gemini quản lý repo GitHub tự chủ: duyệt, đọc, tạo/sửa/xoá file, tạo branch, commit, push. Không có dependency ngoài.

Chạy được 2 nơi, cùng một lõi `src/app.js`:

| Entry point | Chạy ở đâu |
|---|---|
| `worker.js` | **Cloudflare Workers** (free, không bị ngủ, deploy hoàn toàn bằng Dashboard) |
| `server.js` | Node >= 20: Render, Railway, Fly, Docker, máy local + tunnel |

## Tools

| Tool | Chức năng |
|---|---|
| `list_repos` | Liệt kê repository (của bạn, cộng tác, hoặc của 1 org) |
| `create_repo` | Tạo repository mới (của bạn hoặc trong org). Mặc định **private** và có README để dùng được ngay |
| `list_files` | Duyệt cây thư mục (1 cấp hoặc `recursive`) |
| `read_file` | Đọc nội dung file (hỗ trợ `start_line`/`end_line`, file > 1MB, binary base64) |
| `create_file` | Tạo file, commit thẳng lên branch (chạy được cả repo rỗng) |
| `update_file` | Sửa file (tự lấy `sha` nếu không truyền) |
| `delete_file` | Xoá file (tự lấy `sha` nếu không truyền) |
| `create_branch` | Tạo branch từ branch khác hoặc từ commit SHA |
| `commit_changes` | Tạo **1 commit** gồm nhiều thay đổi (upsert/delete nhiều file). Chưa di chuyển branch |
| `push_changes` | Đẩy commit lên branch (tạo branch nếu chưa có). Fast-forward, hoặc `force=true` |
| `get_commit` | Xem commit: message, parent, stats, file đổi, patch |

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
| `GITHUB_SCOPES` | | Mặc định `repo`. Thêm `workflow` nếu cần sửa `.github/workflows` |
| `ALLOWED_REDIRECT_URIS` | | Danh sách (phẩy) prefix redirect URI cho phép. Trống = mọi https |
| `PORT` | | Chỉ cho `server.js`, mặc định 3000 |

## Test

```bash
npm test
```

Dựng GitHub giả in-memory, chạy server thật, đi hết luồng OAuth (PKCE) và gọi đủ 11 tool. Muốn thử bản Worker trên runtime thật: chạy `wrangler dev` với các `--var` trỏ `GITHUB_API_URL`/`GITHUB_WEB_URL` về `http://127.0.0.1:<MOCK_PORT>`, rồi `SMOKE_BASE=http://127.0.0.1:<port> MOCK_PORT=<MOCK_PORT> node test/smoke.mjs`.

## Bảo mật

- Quyền thực tế = quyền của tài khoản GitHub bạn đăng nhập, trong phạm vi scope `repo`. Scope `repo` cho phép ghi **mọi** repo của bạn, nên chỉ chia sẻ `MCP_CLIENT_SECRET` với Gemini.
- Auth code sống 5 phút, state 10 phút; token không hết hạn (như token OAuth App của GitHub). Muốn thu hồi: Settings → Applications → Authorized OAuth Apps → Revoke, hoặc đổi `SESSION_SECRET`.
- `force=true` ở `push_changes` ghi đè lịch sử branch, chỉ dùng khi chắc chắn.
