import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AccessContext } from "@zvenko/db";
import type { FastifyRequest } from "fastify";
import { AuthPort } from "../identity/auth.port.js";
import { AccessResolver } from "./access.resolver.js";

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

    const access = await this.resolver.resolve(session.userId, session.tenantId);
    if (!access) throw new ForbiddenException();
    request.access = access;
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
