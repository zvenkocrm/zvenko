import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import type { AuthEvents, AuthRequestSource } from "./auth-events.js";
import { CLIENT_IP_HEADER, REQUEST_ID_HEADER } from "./request-headers.js";

/** Cookie второго шага входа (плагин twoFactor): по ней находим, чей это вход. */
const TWO_FACTOR_COOKIE = "two_factor";

/** Модель второго фактора в адаптере БД Better Auth. */
const TWO_FACTOR_MODEL = "twoFactor";

type SecurityChange = "two_factor_disabled" | "backup_codes_generated" | "password_changed";

/** Изменения безопасности учётной записи — пишутся в журналы всех её компаний (D30). */
const SECURITY_CHANGES: Readonly<Record<string, SecurityChange>> = {
  "/two-factor/disable": "two_factor_disabled",
  "/two-factor/generate-backup-codes": "backup_codes_generated",
  "/change-password": "password_changed",
};

const REVOKE_SCOPES: Readonly<Record<string, "one" | "all" | "others">> = {
  "/revoke-session": "one",
  "/revoke-sessions": "all",
  "/revoke-other-sessions": "others",
};

/** Успех — ответ эндпоинта; ошибки Better Auth приходят в хук как APIError. */
const isSuccess = (returned: unknown): boolean =>
  typeof returned === "object" && returned !== null && !isAPIError(returned);

function errorCode(returned: unknown): string | null {
  if (!isAPIError(returned)) return null;
  const code: unknown = returned.body?.code;
  return typeof code === "string" ? code : null;
}

function emailOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("email" in body)) return null;
  return typeof body.email === "string" ? body.email.toLowerCase() : null;
}

/**
 * «Доверенное устройство» пропускает второй фактор до 30 дней. Нам нужен второй фактор
 * при каждом входе (SEC-02), поэтому такие запросы отклоняются — в том числе с сервера.
 */
function rejectTrustedDevice(path: string, body: unknown): void {
  if (
    path.startsWith("/two-factor/verify") &&
    typeof body === "object" &&
    body !== null &&
    "trustDevice" in body &&
    body.trustDevice === true
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "TRUSTED_DEVICES_DISABLED",
      message: "Доверенные устройства отключены: второй фактор нужен при каждом входе",
    });
  }
}

/**
 * Хуки Better Auth: запрет доверенных устройств и события для журнала аудита (F-AUD-01).
 *
 * Наш хук «после» выполняется раньше хуков плагинов. Поэтому после пароля у пользователя
 * с 2FA он ещё видит временную сессию — её удалит плагин twoFactor, и вход завершится
 * только кодом второго фактора.
 */
export function createAuthHooks(events: AuthEvents) {
  const before = createAuthMiddleware(async (ctx) => {
    rejectTrustedDevice(ctx.path, ctx.body);
    // Выход удаляет сессию — запоминаем её заранее, чтобы знать, чей это выход.
    if (ctx.path === "/sign-out") {
      const token = await ctx.getSignedCookie(
        ctx.context.authCookies.sessionToken.name,
        ctx.context.secret,
      );
      if (token) ctx.context.session = await ctx.context.internalAdapter.findSession(token);
    }
  });

  const after = createAuthMiddleware(async (ctx) => {
    const returned: unknown = ctx.context.returned;
    const source: AuthRequestSource = {
      host: ctx.headers?.get("host") ?? null,
      ip: ctx.headers?.get(CLIENT_IP_HEADER) ?? null,
      userAgent: ctx.headers?.get("user-agent") ?? null,
      requestId: ctx.headers?.get(REQUEST_ID_HEADER) ?? null,
    };

    /** Вход завершён. Без записи в журнал входа нет: сессия удаляется. */
    const signedIn = async (session: { id: string; token: string }, userId: string) => {
      try {
        await events.signedIn({ userId, sessionId: session.id }, source);
      } catch {
        await ctx.context.internalAdapter.deleteSession(session.token);
        throw new APIError("INTERNAL_SERVER_ERROR", {
          code: "AUDIT_UNAVAILABLE",
          message: "Вход не выполнен: не удалось записать его в журнал аудита",
        });
      }
    };

    /** Чей это второй шаг входа — по cookie, которую плагин выдал после пароля. */
    const pendingUser = async (): Promise<string | null> => {
      const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
      const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
      if (!challenge) return null;
      const verification = await ctx.context.internalAdapter.findVerificationValue(challenge);
      return verification?.value ?? null;
    };

    /** Аккаунт заблокирован прямо сейчас — после этой попытки. */
    const lockedNow = async (userId: string): Promise<boolean> => {
      const row = await ctx.context.adapter.findOne<{ lockedUntil: Date | null }>({
        model: TWO_FACTOR_MODEL,
        where: [{ field: "userId", value: userId }],
      });
      return row?.lockedUntil != null && new Date(row.lockedUntil).getTime() > Date.now();
    };

    switch (ctx.path) {
      case "/sign-in/email": {
        if (errorCode(returned) === "INVALID_EMAIL_OR_PASSWORD") {
          // Поиск — и для существующей почты, и для неизвестной: время ответа одинаковое.
          const email = emailOf(ctx.body);
          const found =
            email === null ? null : await ctx.context.internalAdapter.findUserByEmail(email);
          if (found) {
            events.record(
              { type: "sign_in_failed", userId: found.user.id, reason: "password" },
              source,
            );
          }
          return;
        }
        const created = ctx.context.newSession;
        if (isSuccess(returned) && created && created.user.twoFactorEnabled !== true) {
          await signedIn(created.session, created.user.id);
        }
        return;
      }

      case "/two-factor/verify-totp":
      case "/two-factor/verify-backup-code": {
        // Сессия до запроса. Нет её — это второй шаг входа; есть — подтверждение при включении 2FA.
        const current = ctx.context.session;
        if (isAPIError(returned)) {
          if (current) return;
          const userId = await pendingUser();
          if (userId === null) return;
          const locked = errorCode(returned) === "ACCOUNT_TEMPORARILY_LOCKED";
          events.record(
            { type: "sign_in_failed", userId, reason: locked ? "locked" : "second_factor" },
            source,
          );
          if (!locked && (await lockedNow(userId))) {
            events.record({ type: "account_locked", userId }, source);
          }
          return;
        }
        const created = ctx.context.newSession;
        if (!isSuccess(returned) || !created) return;
        if (!current) {
          await signedIn(created.session, created.user.id);
        } else if (
          current.user.twoFactorEnabled !== true &&
          created.user.twoFactorEnabled === true
        ) {
          events.record({ type: "two_factor_enabled", userId: created.user.id }, source);
        }
        return;
      }

      case "/sign-out": {
        const ended = ctx.context.session;
        if (isSuccess(returned) && ended) {
          const tenantId: unknown = ended.session.activeTenantId;
          events.record(
            {
              type: "signed_out",
              userId: ended.user.id,
              sessionId: ended.session.id,
              tenantId: typeof tenantId === "string" ? tenantId : null,
            },
            source,
          );
        }
        return;
      }

      default: {
        const user = ctx.context.session?.user;
        if (!user || !isSuccess(returned)) return;
        const change = SECURITY_CHANGES[ctx.path];
        const scope = REVOKE_SCOPES[ctx.path];
        if (change) {
          events.record({ type: change, userId: user.id }, source);
        } else if (scope) {
          events.record({ type: "sessions_revoked", userId: user.id, scope }, source);
        }
      }
    }
  });

  return { before, after };
}
