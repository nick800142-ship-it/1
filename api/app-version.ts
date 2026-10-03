import type { IncomingMessage, ServerResponse } from "node:http";

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.end(JSON.stringify(payload));
}

export default function handler(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return json(response, 405, { error: "Method not allowed" });
  }

  const version = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA;
  if (!version) return json(response, 503, { error: "Deployment version is unavailable" });

  return json(response, 200, { version });
}
