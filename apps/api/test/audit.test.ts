import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { auditSource } from "../src/audit/audit.service.js";

const request = (ip: string, userAgent?: string): FastifyRequest =>
  ({
    ip,
    id: "req-12345678",
    headers: userAgent === undefined ? {} : { "user-agent": userAgent },
  }) as unknown as FastifyRequest;

describe("источник записи журнала (F-AUD-02)", () => {
  it("IP и ID запроса — те, что увидел сервер", () => {
    expect(auditSource(request("203.0.113.7", "Mozilla/5.0"))).toEqual({
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      requestId: "req-12345678",
    });
  });

  it.each([
    ["IPv6", "2001:db8::1", "2001:db8::1"],
    ["IPv4 внутри IPv6", "::ffff:192.0.2.1", "::ffff:192.0.2.1"],
    ["IPv6 с зоной — без зоны", "fe80::1%eth0", "fe80::1"],
    ["не адрес (ошибка настройки прокси) — не пишется", "unknown, 10.0.0.1", null],
  ])("IP: %s", (_case, ip, expected) => {
    expect(auditSource(request(ip)).ip).toBe(expected);
  });

  it("управляющие символы и смена направления текста из User-Agent убираются", () => {
    const userAgent = "Mozilla\u0000/5.0\r\n\u001b[31m ‮текст⁦ \u0085конец";
    expect(auditSource(request("192.0.2.1", userAgent)).userAgent).toBe(
      "Mozilla/5.0[31m текст конец",
    );
  });

  it("длинный User-Agent обрезается до 512 символов, не разрезая символ", () => {
    const userAgent = "🎄".repeat(600);
    const result = auditSource(request("192.0.2.1", userAgent)).userAgent ?? "";
    expect(Array.from(result)).toHaveLength(512);
    expect(result).toBe("🎄".repeat(512));
  });

  it("без заголовка User-Agent — пусто", () => {
    expect(auditSource(request("192.0.2.1")).userAgent).toBeNull();
  });
});
