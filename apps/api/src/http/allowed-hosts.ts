/** Одна метка домена: буквы, цифры, дефис. */
const LABEL = /^[a-z0-9-]+$/;

/**
 * Проверка заголовка Host по адресам приложения (AUTH_ORIGINS). `*.zvenko.ru` — ровно один
 * уровень поддомена: адрес компании вида `neva.zvenko.ru`. Не мягче проверки Better Auth —
 * что пропускаем мы, пропустит и она. Без регулярных выражений из конфигурации (ReDoS).
 */
export function createHostMatcher(origins: readonly string[]): (host: string) => boolean {
  const matchers = origins.map((origin) => {
    const pattern = origin.replace(/^https?:\/\//, "").toLowerCase();
    if (!pattern.startsWith("*.")) return (host: string) => host === pattern;
    const suffix = pattern.slice(1);
    return (host: string) =>
      host.endsWith(suffix) && LABEL.test(host.slice(0, host.length - suffix.length));
  });
  return (host) => {
    const normalized = host.toLowerCase();
    return matchers.some((matches) => matches(normalized));
  };
}

/**
 * Поддомен из адреса по маскам AUTH_ORIGINS: `neva.zvenko.ru` → `neva` для `*.zvenko.ru`.
 * Для адресов без маски (локальная разработка) — null.
 */
export function createSubdomainExtractor(
  origins: readonly string[],
): (host: string) => string | null {
  const suffixes = origins
    .map((origin) => origin.replace(/^https?:\/\//, "").toLowerCase())
    .filter((pattern) => pattern.startsWith("*."))
    .map((pattern) => pattern.slice(1));
  return (host) => {
    const normalized = host.toLowerCase();
    for (const suffix of suffixes) {
      if (!normalized.endsWith(suffix)) continue;
      const label = normalized.slice(0, normalized.length - suffix.length);
      if (LABEL.test(label)) return label;
    }
    return null;
  };
}
