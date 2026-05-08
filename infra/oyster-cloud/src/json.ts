export function jsonError(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { error: code, ...extra };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(payload: object, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.set(k, v));
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
