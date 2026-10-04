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
