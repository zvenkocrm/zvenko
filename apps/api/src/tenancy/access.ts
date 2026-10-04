import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AccessContext } from "@zvenko/db";
import type { FastifyRequest } from "fastify";
import { PROBLEM_TYPES, ProblemException } from "../http/problem.js";
import { AuthPort, type Session } from "../identity/auth.port.js";
import { AccessResolver } from "./access.resolver.js";
import { ROLES_REQUIRING_TWO_FACTOR } from "./roles.js";
import { TenantDirectory } from "./tenant-directory.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Сессия пользователя — выставляет AccessGuard. */
    session: Session | null;
    /** Профиль доступа пользователя в компании — выставляет AccessGuard. */
    access: AccessContext | null;
  }
}

const PUBLIC = Symbol("public");
const SESSION_ONLY = Symbol("session-only");

/**
 * Адрес без входа: проверки здоровья, приём заявок с сайтов. Ставится осознанно —
 * каждый такой адрес есть в реестре тестов изоляции.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

/**
 * Адрес для вошедшего пользователя без данных компании — например, выбор компании.
 * Каждый такой адрес есть в реестре тестов изоляции с видом `session`.
 */
export const SessionOnly = (): MethodDecorator & ClassDecorator => SetMetadata(SESSION_ONLY, true);

/**
 * Проверка доступа на каждом запросе (SEC-05): по умолчанию «запрещено».
 * - Нет сессии — 401.
 * - Компания — по адресу сайта (`neva.zvenko.ru`), а без поддомена — выбранная в сессии.
 *   Неизвестный поддомен — 404; компания не выбрана или пользователь в ней не работает — 403.
 * - Владелец и администратор без 2FA к данным компании не допускаются (SEC-02).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthPort,
    private readonly resolver: AccessResolver,
    private readonly directory: TenantDirectory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    // Сначала сессия: без входа нельзя даже узнать, есть ли компания на этом адресе.
    const session = await this.auth.getSession(request);
    if (!session) throw new UnauthorizedException();
    request.session = session;
    if (this.reflector.getAllAndOverride<boolean | undefined>(SESSION_ONLY, targets) === true) {
      return true;
    }

    const host = await this.directory.resolve(request.host);
    if (host.kind === "unknown") throw new NotFoundException();
    const tenantId = host.kind === "tenant" ? host.tenantId : session.tenantId;
    if (tenantId === null) throw new ForbiddenException();

    const resolved = await this.resolver.resolve(session.userId, tenantId);
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

/** Сессия текущего пользователя — аргумент обработчика адресов @SessionOnly(). */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const { session } = context.switchToHttp().getRequest<FastifyRequest>();
  if (!session) throw new Error("Сессия не установлена — адрес помечен @Public()?");
  return session;
});
