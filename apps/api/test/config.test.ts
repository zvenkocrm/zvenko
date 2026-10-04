import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

const DATABASE_URL = "postgres://zvenko_app:s3cr3t-value@db.internal:5432/zvenko";

describe("конфигурация", () => {
  it("значения по умолчанию безопасны: только локальный интерфейс, прокси не доверяем", () => {
    const config = loadConfig({ DATABASE_URL });
    expect(config).toMatchObject({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      DATABASE_POOL_MAX: 10,
      TRUST_PROXY: false,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("без DATABASE_URL приложение не запускается", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("в сообщении об ошибке нет значений переменных — там могут быть секреты", () => {
    let message = "";
    try {
      loadConfig({ DATABASE_URL: "mysql://root:s3cr3t-value@db.internal/zvenko", PORT: "70000" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).not.toContain("s3cr3t-value");
  });

  it.each([
    ["false", false],
    ["2", 2],
    ["10.0.0.0/8", ["10.0.0.0/8"]],
    ["10.0.0.1, 192.168.0.0/16, ::1", ["10.0.0.1", "192.168.0.0/16", "::1"]],
  ] as const)("TRUST_PROXY=%s", (value, expected) => {
    expect(loadConfig({ DATABASE_URL, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it.each(["true", "*", "10.0.0.0/33", "example.com", "10.0.0.1/8/1"])(
    "TRUST_PROXY=%s отклоняется: доверие всем подделывает IP клиента",
    (value) => {
      expect(() => loadConfig({ DATABASE_URL, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );
});
