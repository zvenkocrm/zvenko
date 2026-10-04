import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";

const REQUIRED = {
  DATABASE_URL: "postgres://zvenko_app:s3cr3t-value@db.internal:5432/zvenko",
  IDENTITY_DATABASE_URL: "postgres://zvenko_identity:s3cr3t-value@db.internal:5432/zvenko",
  AUTH_SECRET: "s3cr3t-value-0123456789-0123456789",
  AUTH_ORIGINS: "http://127.0.0.1:3000",
};

describe("конфигурация", () => {
  it("значения по умолчанию безопасны: только локальный интерфейс, прокси не доверяем", () => {
    const config = loadConfig(REQUIRED);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 3000,
      LOG_LEVEL: "info",
      DATABASE_POOL_MAX: 10,
      TRUST_PROXY: false,
      AUTH_ORIGINS: ["http://127.0.0.1:3000"],
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each(Object.keys(REQUIRED))("без %s приложение не запускается", (name) => {
    const env = Object.fromEntries(Object.entries(REQUIRED).filter(([key]) => key !== name));
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it("в сообщении об ошибке нет значений переменных — там могут быть секреты", () => {
    let message = "";
    try {
      loadConfig({
        ...REQUIRED,
        DATABASE_URL: "mysql://root:s3cr3t-value@db.internal/zvenko",
        PORT: "70000",
        AUTH_SECRET: "s3cr3t-value",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/PORT/);
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).not.toContain("s3cr3t-value");
  });

  it.each([
    ["false", false],
    ["2", 2],
    ["10.0.0.0/8", ["10.0.0.0/8"]],
    ["10.0.0.1, 192.168.0.0/16, ::1", ["10.0.0.1", "192.168.0.0/16", "::1"]],
  ] as const)("TRUST_PROXY=%s", (value, expected) => {
    expect(loadConfig({ ...REQUIRED, TRUST_PROXY: value }).TRUST_PROXY).toEqual(expected);
  });

  it.each(["true", "*", "10.0.0.0/33", "example.com", "10.0.0.1/8/1"])(
    "TRUST_PROXY=%s отклоняется: доверие всем подделывает IP клиента",
    (value) => {
      expect(() => loadConfig({ ...REQUIRED, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    },
  );
});

describe("адреса приложения для входа (AUTH_ORIGINS)", () => {
  it("список через запятую, поддомены компаний — маской", () => {
    const config = loadConfig({
      ...REQUIRED,
      NODE_ENV: "production",
      AUTH_ORIGINS: "https://*.zvenko.ru, https://app.zvenko.ru/",
    });
    expect(config.AUTH_ORIGINS).toEqual(["https://*.zvenko.ru", "https://app.zvenko.ru"]);
  });

  it("в продакшене — только https: cookie сессии не уходят по открытому каналу", () => {
    expect(() =>
      loadConfig({ ...REQUIRED, NODE_ENV: "production", AUTH_ORIGINS: "http://app.zvenko.ru" }),
    ).toThrow(/AUTH_ORIGINS/);
  });

  it.each(["app.zvenko.ru", "https://app.zvenko.ru/login", "ftp://app.zvenko.ru", "https://*"])(
    "%s отклоняется",
    (value) => {
      expect(() => loadConfig({ ...REQUIRED, AUTH_ORIGINS: value })).toThrow(/AUTH_ORIGINS/);
    },
  );
});
