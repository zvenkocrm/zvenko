import { hash, verify } from "@node-rs/argon2";

/**
 * Algorithm.Argon2id из @node-rs/argon2 — `const enum`, его нельзя импортировать при
 * verbatimModuleSyntax. Значение 2 — Argon2id в этом перечислении; тест сверяет префикс хэша.
 */
const ARGON2ID = 2;

/**
 * Хэширование паролей — argon2id с параметрами не ниже рекомендаций OWASP: 19 МиБ памяти,
 * 2 прохода, 1 поток (SEC-01). Соль генерируется для каждого пароля и хранится в самом хэше.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Длина пароля по SEC-01 и NIST 800-63B: от 12 символов, без требований к составу. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** Неверный формат хэша — это «пароль не подошёл», а не ошибка сервера. */
export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  try {
    return await verify(data.hash, data.password);
  } catch {
    return false;
  }
}
