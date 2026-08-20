import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { checkConfig } from "./lib/config";

const http = httpRouter();

// HTTP actions are served from <deployment>.convex.site — NOT .convex.cloud.
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    const { ok } = checkConfig();
    // Return configOk ONLY. Never the missing variable names, never the
    // deployment URL, never dependency versions. A leaky health endpoint
    // is a real finding.
    return new Response(JSON.stringify({ status: "ok", configOk: ok }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

// Phase 1 adds: POST /webhooks/telegram
// Phase 3 adds: GET  /oauth/google/start, GET /oauth/google/callback
// Phase 8 adds: POST /webhooks/gmail

export default http;
