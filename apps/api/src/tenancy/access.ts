import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AccessContext } from "@zvenko/db";
import type { FastifyRequest } from "fastify";
import { PROBLEM_TYPES, ProblemException } from "../http/problem.js";
import { AuthPort } from "../identity/auth.port.js";
import { AccessResolver } from "./access.resolver.js";
import { ROLES_REQUIRING_TWO_FACTOR } from "./roles.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Профиль доступа пользователя — выставляет AccessGuard. */
    access: AccessContext | null;
  }
}

const PUBLIC = Symbol("public");

/**
 * Адрес без входа: проверки здоровья, приём заявок с сайтов. Ставится осознанно —
 * каждый такой адрес есть в реестре тестов изоляции.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/**
 * Проверка доступа на каждом запросе (SEC-05): по умолчанию «запрещено».
 * Нет сессии — 401; нет активной компании или пользователь в ней не работает — 403.
 * Владелец и администратор без 2FA к данным компании не допускаются (SEC-02).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthPort,
    private readonly resolver: AccessResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const session = await this.auth.getSession(request);
    if (!session) throw new UnauthorizedException();
    if (session.tenantId === null) throw new ForbiddenException();

    const resolved = await this.resolver.resolve(session.userId, session.tenantId);
    if (!resolved) throw new ForbiddenException();
    if (ROLES_REQUIRING_TWO_FACTOR.has(resolved.role) && !session.twoFactorEnabled) {
      throw new ProblemException(
        HttpStatus.FORBIDDEN,
        "Включите двухфакторную аутентификацию: без неё владельцу и администраторам доступ закрыт",
        undefined,
        PROBLEM_TYPES.twoFactorRequired,
      );
    }
    request.access = resolved.context;
    return true;
  }
}

/** Профиль доступа текущего пользователя — аргумент обработчика. */
export const Access = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const { access } = context.switchToHttp().getRequest<FastifyRequest>();
  // Без профиля обработчик не должен выполняться: это ошибка в коде, а не запрос пользователя.
  if (!access) throw new Error("Профиль доступа не установлен — адрес помечен @Public()?");
  return access;
});
