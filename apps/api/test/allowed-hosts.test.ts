import { describe, expect, it } from "vitest";
import { createHostMatcher, createSubdomainExtractor } from "../src/http/allowed-hosts.js";

describe("проверка адреса сайта", () => {
  const matches = createHostMatcher(["https://*.zvenko.ru", "http://localhost:3000"]);

  it.each(["neva.zvenko.ru", "NEVA.Zvenko.RU", "localhost:3000"])("%s — наш адрес", (host) => {
    expect(matches(host)).toBe(true);
  });

  it.each([
    "zvenko.ru",
    "a.b.zvenko.ru",
    "neva.zvenko.ru.evil.example",
    "evilzvenko.ru",
    "neva-zvenko.ru",
    "localhost:3001",
    "localhost",
  ])("%s — чужой адрес", (host) => {
    expect(matches(host)).toBe(false);
  });
});

describe("поддомен компании из адреса", () => {
  const subdomainOf = createSubdomainExtractor(["https://*.zvenko.ru", "http://localhost:3000"]);

  it.each([
    ["neva.zvenko.ru", "neva"],
    ["NEVA.zvenko.ru", "neva"],
    ["zvenko.ru", null],
    ["a.b.zvenko.ru", null],
    ["neva.zvenko.ru.evil.example", null],
    ["localhost:3000", null],
  ] as const)("%s → %s", (host, expected) => {
    expect(subdomainOf(host)).toBe(expected);
  });
});
