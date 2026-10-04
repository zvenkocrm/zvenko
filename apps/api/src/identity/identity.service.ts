import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { accounts, type Database, eq, newId, sessions, users } from "@zvenko/db";
import { z } from "zod";
import { ProblemException } from "../http/problem.js";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password.js";
import { IDENTITY_DB } from "./tokens.js";

const newUserSchema = z.object({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export type NewUser = z.input<typeof newUserSchema>;

/**
 * Публичный интерфейс модуля входа для других модулей. Пользователей создаёт сервер:
 * регистрации нет, люди приходят по приглашению (D15, F-USR-01).
 */
@Injectable()
export class IdentityService {
  constructor(@Inject(IDENTITY_DB) private readonly db: Database) {}

  /**
   * Активная компания сессии (F-AUTH-06). Членство проверяет вызывающий модуль tenancy:
   * модуль входа данных компаний не видит.
   */
  async setActiveTenant(sessionId: string, tenantId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ activeTenantId: tenantId, updatedAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }

  /** Пользователь с паролем — одной транзакцией: без пароля учётная запись не появится. */
  async createUser(input: NewUser): Promise<{ id: string }> {
    const parsed = newUserSchema.safeParse(input);
    if (!parsed.success) {
      throw new ProblemException(
        HttpStatus.BAD_REQUEST,
        "Проверьте почту, имя и пароль",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      );
    }
    const { email, name, password } = parsed.data;
    // Хэш — до транзакции: argon2id намеренно медленный, транзакция не должна его ждать.
    const hash = await hashPassword(password);
    const id = newId();
    await this.db.transaction(async (tx) => {
      // Почта подтверждена: пользователя создают по приглашению, пришедшему на эту почту.
      await tx.insert(users).values({ id, email, name, emailVerified: true });
      await tx.insert(accounts).values({
        id: newId(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: hash,
      });
    });
    return { id };
  }
}
