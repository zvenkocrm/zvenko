import type { FastifyRequest } from "fastify";

/** Сессия: кто вошёл и в какой компании работает. */
export interface Session {
  readonly sessionId: string;
  readonly userId: string;
  /** Активная компания сессии (F-AUTH-06); null — компания ещё не выбрана. */
  readonly tenantId: string | null;
  /** Включена ли у пользователя 2FA. Если да — эта сессия прошла второй фактор при входе. */
  readonly twoFactorEnabled: boolean;
}

/**
 * Вход и сессии — за этим интерфейсом (ADR-0006): код продукта не зависит от библиотеки
 * аутентификации, её можно заменить новым адаптером.
 */
export abstract class AuthPort {
  /** Сессия по запросу или null, если пользователь не вошёл или сессия недействительна. */
  abstract getSession(request: FastifyRequest): Promise<Session | null>;
}
