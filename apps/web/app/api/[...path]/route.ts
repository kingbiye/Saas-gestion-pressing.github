import { handleRequest, type ApiRequest, type ApiResponse } from "../../../../api/src/main";

export const runtime = "nodejs";

async function dispatch(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  requestUrl.pathname = requestUrl.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const authorization = request.headers.get("authorization") ?? undefined;
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const apiRequest: ApiRequest = {
    method: request.method,
    url: `${requestUrl.pathname}${requestUrl.search}`,
    headers: { authorization },
    async *[Symbol.asyncIterator]() {
      if (body) yield body;
    },
  };

  let status = 200;
  let headers: Record<string, string> = {};
  let responseBody: string | undefined;
  const apiResponse: ApiResponse = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders ?? {};
      return apiResponse;
    },
    end(chunk?: string) {
      responseBody = chunk;
      return apiResponse;
    },
  };

  try {
    await handleRequest(apiRequest, apiResponse);
  } catch (error) {
    console.error("API request failed:", error);
    status = 500;
    headers = { "content-type": "application/json" };
    responseBody = JSON.stringify({ error: "INTERNAL_SERVER_ERROR" });
  }

  return new Response(responseBody, { status, headers });
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
