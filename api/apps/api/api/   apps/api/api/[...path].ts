import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../apps/api/src/main.js";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const originalUrl = req.url ?? "/";
  req.url = originalUrl.replace(/^\/api(?=\/|$)/, "") || "/";
  return handleRequest(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "INVALID_REQUEST" }));
    } else {
      res.end();
    }
  });
}
