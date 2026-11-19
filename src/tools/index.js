/**
 * Đăng ký các nhóm tool. Chọn nhóm bằng biến môi trường TOOL_GROUPS (phẩy):
 *   core    - repo, file, branch, commit, push, lịch sử commit
 *   issues  - Issues & Pull Requests
 *   actions - GitHub Actions & Releases
 *   admin   - Webhook, branch protection, ruleset, bảo mật, cài đặt repo
 * Mặc định "all" (tất cả).
 */
import { CORE_TOOLS } from "./core.js";
import { ISSUE_TOOLS } from "./issues.js";
import { ACTIONS_TOOLS } from "./actions.js";
import { ADMIN_TOOLS } from "./admin.js";

export const GROUPS = { core: CORE_TOOLS, issues: ISSUE_TOOLS, actions: ACTIONS_TOOLS, admin: ADMIN_TOOLS };

/** Trả danh sách tool cho các nhóm được chọn (không trùng tên). */
export function getTools(groups = ["all"]) {
  const want = groups.includes("all") ? Object.keys(GROUPS) : groups.filter((g) => {
    if (GROUPS[g]) return true;
    console.warn(`[config] TOOL_GROUPS: unknown group "${g}" (valid: ${Object.keys(GROUPS).join(", ")}, all)`);
    return false;
  });
  const seen = new Set();
  const out = [];
  for (const g of want.length ? want : ["core"]) {
    for (const tl of GROUPS[g]) {
      if (seen.has(tl.name)) throw new Error(`Duplicate tool name: ${tl.name}`);
      seen.add(tl.name);
      out.push(tl);
    }
  }
  return out;
}
