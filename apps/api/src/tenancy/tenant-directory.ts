import { Inject, Injectable } from "@nestjs/common";
import { type Database, eq, tenantDirectory } from "@zvenko/db";
import type { Config } from "../config/config.js";
import { CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { createSubdomainExtractor } from "../http/allowed-hosts.js";

/** Компания по адресу сайта: адрес без поддомена, поддомен компании или неизвестный поддомен. */
export type HostTenant =
  | { readonly kind: "none" }
  | { readonly kind: "tenant"; readonly tenantId: string }
  | { readonly kind: "unknown" };

/** Служебные поддомены платформы (F-TEN-01): это не адреса компаний. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "admin",
  "status",
  "mail",
  "in",
  "notify",
  "news",
  "cdn",
  "static",
  "help",
  "docs",
  "blog",
]);

/** Смена поддомена расходится по экземплярам за минуту — она бывает редко. */
const CACHE_TTL_MS = 60_000;
/** Предел записей: перебор случайных поддоменов не раздует память. */
const CACHE_MAX_ENTRIES = 10_000;

/**
 * Компания запроса по адресу: `neva.zvenko.ru` → Нева Макет (ADR-0002, F-AUTH-06).
 * Справочник — глобальный, без данных компаний и без ПДн, поэтому читается без контекста
 * доступа. Ответы кэшируются, в том числе «такого поддомена нет».
 */
@Injectable()
export class TenantDirectory {
  private readonly subdomainOf: (host: string) => string | null;
  private readonly cache = new Map<string, { tenantId: string | null; expiresAt: number }>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) config: Config,
  ) {
    this.subdomainOf = createSubdomainExtractor(config.AUTH_ORIGINS);
  }

  async resolve(host: string): Promise<HostTenant> {
    const subdomain = this.subdomainOf(host);
    if (subdomain === null || RESERVED_SUBDOMAINS.has(subdomain)) return { kind: "none" };
    const tenantId = await this.lookup(subdomain);
    return tenantId === null ? { kind: "unknown" } : { kind: "tenant", tenantId };
  }

  private async lookup(subdomain: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.cache.get(subdomain);
    if (cached && cached.expiresAt > now) return cached.tenantId;

    const [row] = await this.db
      .select({ tenantId: tenantDirectory.tenantId })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.subdomain, subdomain))
      .limit(1);
    const tenantId = row?.tenantId ?? null;

    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done !== true) this.cache.delete(oldest.value);
    }
    this.cache.set(subdomain, { tenantId, expiresAt: now + CACHE_TTL_MS });
    return tenantId;
  }
}
