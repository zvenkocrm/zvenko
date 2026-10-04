import type { FastifyReply, FastifyRequest } from "fastify";
import { CLIENT_IP_HEADER } from "./auth.js";

/**
 * Заголовки, которые не передаём в Better Auth: заголовки соединения, длина старого тела
 * (тело собираем заново) и всё, чем клиент мог бы подменить свой IP или адрес сайта.
 */
const DROPPED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  CLIENT_IP_HEADER,
]);

/** Заголовки запроса для Better Auth. IP клиента — тот, что вычислил Fastify с учётом TRUST_PROXY. */
export function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set(CLIENT_IP_HEADER, request.ip);
  return headers;
}

/** Запрос Fastify → Fetch API Request для Better Auth. Тело уже разобрано Fastify как JSON. */
export function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, `${request.protocol}://${request.host}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body != null;
  return new Request(url, {
    method: request.method,
    headers: toWebHeaders(request),
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

/** Ответ Better Auth → ответ Fastify. Несколько Set-Cookie передаются отдельными заголовками. */
export async function sendWebResponse(reply: FastifyReply, response: Response): Promise<void> {
  void reply.status(response.status);
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie" && name !== "content-length") void reply.header(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) void reply.header("set-cookie", cookies);
  // Ответы о сессии и входе не кэшируются ни браузером, ни прокси.
  void reply.header("cache-control", "no-store");
  const body = response.body === null ? null : Buffer.from(await response.arrayBuffer());
  await reply.send(body);
}
