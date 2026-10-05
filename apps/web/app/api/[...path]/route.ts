import { handleRequest, handleRequestError, type ApiRequest, type ApiResponse } from "../../../../api/src/main";

export const runtime = "nodejs";

async function dispatch(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  requestUrl.pathname = requestUrl.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const contentLength = Number(request.headers.get("content-length"));
  if (request.headers.has("content-length") && Number.isFinite(contentLength) && contentLength > 1_500_000) {
    return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
  }
  const authorization = request.headers.get("authorization") ?? undefined;
  let body: Buffer | undefined;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_500_000) {
        await reader.cancel();
        return Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
      }
      chunks.push(value);
    }
    body = Buffer.concat(chunks, size);
  }
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
    handleRequestError(error, apiResponse);
  }

  return new Response(responseBody, { status, headers });
}

export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
