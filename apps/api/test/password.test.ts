import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/identity/password.js";

describe("пароли — argon2id (SEC-01)", () => {
  it("хэш argon2id с параметрами OWASP: 19 МиБ, 2 прохода, 1 поток", async () => {
    const hash = await hashPassword("правильная лошадь батарейка");
    expect(hash.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
  });

  it("одинаковые пароли дают разные хэши — у каждого своя соль", async () => {
    const [a, b] = await Promise.all([
      hashPassword("один и тот же"),
      hashPassword("один и тот же"),
    ]);
    expect(a).not.toBe(b);
  });

  it("проверка: верный пароль подходит, неверный — нет", async () => {
    const hash = await hashPassword("правильная лошадь батарейка");
    expect(await verifyPassword({ hash, password: "правильная лошадь батарейка" })).toBe(true);
    expect(await verifyPassword({ hash, password: "правильная лошадь батарейкА" })).toBe(false);
  });

  it("испорченный хэш — «не подошёл», а не ошибка сервера", async () => {
    expect(await verifyPassword({ hash: "not-a-hash", password: "что угодно" })).toBe(false);
  });
});
