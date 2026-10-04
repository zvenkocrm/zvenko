const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Проверка заголовка Host по адресам приложения (AUTH_ORIGINS). `*.zvenko.ru` — ровно один
 * уровень поддомена: адрес компании вида `neva.zvenko.ru`. Не мягче проверки Better Auth —
 * что пропускаем мы, пропустит и она.
 */
export function createHostMatcher(origins: readonly string[]): (host: string) => boolean {
  const matchers = origins.map((origin) => {
    const pattern = origin.replace(/^https?:\/\//, "").toLowerCase();
    if (!pattern.startsWith("*.")) return (host: string) => host === pattern;
    const regexp = new RegExp(`^[a-z0-9-]+${escapeRegExp(pattern.slice(1))}$`);
    return (host: string) => regexp.test(host);
  });
  return (host) => {
    const normalized = host.toLowerCase();
    return matchers.some((matches) => matches(normalized));
  };
}
