# GitHub MCP Server cho Gemini Custom Connector

MCP server (Streamable HTTP) kèm OAuth 2.0 để Gemini quản lý repo GitHub tự chủ: duyệt, đọc, tạo/sửa/xoá file, tạo branch, commit, push. Không có dependency ngoài, cần Node >= 20.

## Tools

| Tool | Chức năng |
|---|---|
| `list_repos` | Liệt kê repository (của bạn, cộng tác, hoặc của 1 org) |
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

### 1. Tạo GitHub OAuth App
GitHub → Settings → Developer settings → OAuth Apps → New OAuth App

- Homepage URL: `PUBLIC_URL` (URL https của server, bước 3)
- Authorization callback URL: `PUBLIC_URL/oauth/callback`

Lấy **Client ID** và bấm Generate a new client secret → `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

### 2. Sinh cặp OAuth để điền vào Gemini

```bash
npm run gen-creds
```

Ra 3 dòng `MCP_CLIENT_ID`, `MCP_CLIENT_SECRET`, `SESSION_SECRET`. Cặp ID/secret này là thứ bạn điền vào Gemini, **không phải** cặp của GitHub.

### 3. Deploy (cần URL https công khai)

**Render / Railway / Fly…** (Node): Build `npm install`, Start `npm start`, rồi set env:

```
PUBLIC_URL=https://ten-app.onrender.com
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
MCP_CLIENT_ID=...
MCP_CLIENT_SECRET=...
SESSION_SECRET=...
```

Server không lưu state (token/code đều mã hoá trong chính chuỗi), nên restart hay free-tier ngủ đều không mất kết nối. Chỉ cần giữ nguyên `SESSION_SECRET` + `MCP_CLIENT_SECRET`.

**Chạy máy local + tunnel:**

```bash
cp .env.example .env      # điền giá trị
cloudflared tunnel --url http://localhost:3000   # lấy URL https, gán vào PUBLIC_URL
npm run dev
```

(nhớ cập nhật callback URL của OAuth App nếu URL tunnel đổi)

### 4. Điền vào Gemini (Kết nối với máy chủ MCP)

| Ô | Giá trị |
|---|---|
| URL của máy chủ MCP | `PUBLIC_URL/mcp` |
| Mã ứng dụng khách | `MCP_CLIENT_ID` |
| Khoá bí mật của ứng dụng khách | `MCP_CLIENT_SECRET` |

Bấm **Tiếp theo** → đăng nhập GitHub → Authorize. Xong là Gemini dùng được các tool.

## Biến môi trường

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | ✓ | OAuth App của GitHub |
| `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` | ✓ | Cặp bạn điền vào Gemini |
| `SESSION_SECRET` | khuyến nghị | Khoá mã hoá token. Đổi = phải kết nối lại |
| `PUBLIC_URL` | khuyến nghị | URL https công khai, không có `/` cuối. Bỏ trống thì suy từ header |
| `GITHUB_SCOPES` | | Mặc định `repo`. Thêm `workflow` nếu cần sửa `.github/workflows` |
| `ALLOWED_REDIRECT_URIS` | | Danh sách (phẩy) prefix redirect URI cho phép. Trống = mọi https |
| `PORT` | | Mặc định 3000 |

## Test

```bash
npm test
```

Dựng GitHub giả in-memory, chạy server thật, đi hết luồng OAuth (PKCE) và gọi đủ 10 tool.

## Bảo mật

- Quyền thực tế = quyền của tài khoản GitHub bạn đăng nhập, trong phạm vi scope `repo`. Scope `repo` cho phép ghi **mọi** repo của bạn, nên chỉ chia sẻ `MCP_CLIENT_SECRET` với Gemini.
- Auth code sống 5 phút, state 10 phút; token không hết hạn (như token OAuth App của GitHub). Muốn thu hồi: Settings → Applications → Authorized OAuth Apps → Revoke, hoặc đổi `SESSION_SECRET`.
- `force=true` ở `push_changes` ghi đè lịch sử branch — chỉ dùng khi chắc chắn.
