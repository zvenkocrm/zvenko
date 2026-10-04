import { Inject, Injectable } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { type Auth, SESSION_ABSOLUTE_MS } from "./auth.js";
import { AuthPort, type Session } from "./auth.port.js";
import { AUTH } from "./tokens.js";
import { toWebHeaders } from "./web-request.js";

/**
 * Сессия из cookie через Better Auth. Простой (12 ч) проверяет сама библиотека,
 * абсолютный срок (30 дней, D20) — этот адаптер: такая сессия завершается и удаляется.
 */
@Injectable()
export class BetterAuthAdapter extends AuthPort {
  constructor(@Inject(AUTH) private readonly auth: Auth) {
    super();
  }

  async getSession(request: FastifyRequest): Promise<Session | null> {
    const result = await this.auth.api.getSession({ headers: toWebHeaders(request) });
    if (!result) return null;

    const { session, user } = result;
    if (Date.now() - session.createdAt.getTime() > SESSION_ABSOLUTE_MS) {
      const context = await this.auth.$context;
      await context.internalAdapter.deleteSession(session.token);
      return null;
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      tenantId: session.activeTenantId ?? null,
      twoFactorEnabled: user.twoFactorEnabled === true,
    };
  }
}
