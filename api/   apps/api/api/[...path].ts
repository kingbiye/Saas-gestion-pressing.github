import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../../src/main";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handleRequest(req, res).catch(() => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "INVALID_REQUEST" }));
  });
}
