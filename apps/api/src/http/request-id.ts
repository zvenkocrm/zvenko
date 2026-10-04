import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** ID от балансировщика принимаем, только если он безопасен для логов: без пробелов и спецсимволов. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Сквозной ID запроса (OBS-01): берём из X-Request-Id, если его выставил балансировщик,
 * иначе создаём. Возвращается клиенту в заголовке X-Request-Id и есть в каждой строке лога.
 */
export function requestId(request: IncomingMessage): string {
  const incoming = request.headers["x-request-id"];
  return typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
