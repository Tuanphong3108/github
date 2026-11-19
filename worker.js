/**
 * Entry point Cloudflare Workers. Logic nằm ở src/app.js (dùng chung với server.js).
 * Cấu hình qua Variables and Secrets trong Dashboard (xem README), cần flag nodejs_compat.
 */
import { configure, handle } from "./src/app.js";

export default {
  async fetch(request, env) {
    try {
      configure(env);
    } catch (e) {
      return new Response(JSON.stringify({ error: "misconfigured", message: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handle(request);
  },
};
