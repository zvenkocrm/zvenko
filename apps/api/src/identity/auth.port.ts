import type { FastifyRequest } from "fastify";

/** Сессия: кто вошёл и в какой компании работает. */
export interface Session {
  readonly sessionId: string;
  readonly userId: string;
  /** Активная компания сессии (F-AUTH-06); null — компания ещё не выбрана. */
  readonly tenantId: string | null;
}

/**
 * Вход и сессии — за этим интерфейсом (ADR-0006): код продукта не зависит от библиотеки
 * аутентификации, её можно заменить новым адаптером.
 */
export abstract class AuthPort {
  /** Сессия по запросу или null, если пользователь не вошёл или сессия недействительна. */
  abstract getSession(request: FastifyRequest): Promise<Session | null>;
}

/**
 * Адаптер до подключения модуля входа: не пускает никого. Так API безопасен
 * в любой момент разработки — забытая настройка не открывает доступ.
 */
export class DenyAllAuth extends AuthPort {
  getSession(): Promise<Session | null> {
    return Promise.resolve(null);
  }
}
