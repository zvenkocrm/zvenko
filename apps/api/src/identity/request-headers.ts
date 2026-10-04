/**
 * Служебные заголовки, которые сервер передаёт в Better Auth. Значения ставит только сервер,
 * присланные клиентом отбрасываются (см. web-request.ts).
 *
 * - IP клиента — из request.ip с учётом TRUST_PROXY: для лимитов, списка сессий и журнала.
 * - ID запроса — для журнала аудита и поиска в логах (OBS-01).
 */
export const CLIENT_IP_HEADER = "x-zvenko-client-ip";
export const REQUEST_ID_HEADER = "x-zvenko-request-id";
