import { sql, type SQL } from "drizzle-orm";
import { pgPolicy, pgRole, type AnyPgColumn, type PgPolicy } from "drizzle-orm/pg-core";

/**
 * Роль приложения: без BYPASSRLS, не владелец таблиц. Создаётся инфраструктурой (IaC),
 * миграции только выдают ей права. Все политики ниже действуют для неё.
 */
export const appRole = pgRole("zvenko_app").existing();

// Настройки транзакции, которые выставляет withAccess(). Обёртка в подзапрос — чтобы PostgreSQL
// вычислил значение один раз на запрос, а не на каждую строку.
// nullif(…, ''): после конца транзакции PostgreSQL возвращает для настройки не NULL, а пустую
// строку — без nullif запрос упал бы на ''::uuid. Пустой контекст = NULL = доступа нет.
export const currentTenantId = sql`(select nullif(current_setting('app.tenant_id', true), '')::uuid)`;
export const currentUserId = sql`(select nullif(current_setting('app.user_id', true), '')::uuid)`;
// Внешнее ::uuid[] обязательно: без него any((select …)) PostgreSQL читает как сравнение
// с подзапросом (uuid = uuid[]), а не с массивом.
const currentTeamIds = sql`(select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[]`;

/**
 * Изоляция компаний — RESTRICTIVE: складывается с остальными политиками через И.
 * Обычные (permissive) политики PostgreSQL объединяются через ИЛИ — без RESTRICTIVE
 * строка чужой компании прошла бы по политике «видит всё» (ADR-0002, data-model).
 */
export const tenantIsolation = (tenantId: AnyPgColumn): PgPolicy =>
  pgPolicy("tenant_isolation", {
    as: "restrictive",
    for: "all",
    to: appRole,
    using: sql`${tenantId} = ${currentTenantId}`,
    withCheck: sql`${tenantId} = ${currentTenantId}`,
  });

/**
 * Доступ ко всем строкам своей компании — для сущностей без областей видимости (отделы, сотрудники).
 * Кто из сотрудников может их менять, решают права роли в приложении (F-ROLE).
 */
export const tenantWideAccess = (table: string): PgPolicy =>
  pgPolicy(`${table}_tenant_wide`, {
    for: "all",
    to: appRole,
    using: sql`true`,
    withCheck: sql`true`,
  });

/** Сущности с областями видимости «свои / отдела / все» (F-ROLE). */
export type ScopedEntity = "deals";
type ScopeMode = "read" | "write";

const scopeCondition = (
  entity: ScopedEntity,
  mode: ScopeMode,
  owner: AnyPgColumn,
  team: AnyPgColumn,
): SQL => {
  // Имя настройки собирается из литеральных типов, не из пользовательских данных.
  const scope = sql.raw(`(select current_setting('app.scope_${entity}_${mode}', true))`);
  return sql`(${scope} = 'all' or (${scope} = 'team' and ${team} = any(${currentTeamIds})) or ${owner} = ${currentUserId})`;
};

/**
 * Разрешающие политики по областям видимости: чтение — по области чтения,
 * создание, изменение и удаление — по области записи.
 */
export const scopedAccess = (
  entity: ScopedEntity,
  owner: AnyPgColumn,
  team: AnyPgColumn,
): PgPolicy[] => {
  const read = scopeCondition(entity, "read", owner, team);
  const write = scopeCondition(entity, "write", owner, team);
  return [
    pgPolicy(`${entity}_read`, { for: "select", to: appRole, using: read }),
    pgPolicy(`${entity}_insert`, { for: "insert", to: appRole, withCheck: write }),
    pgPolicy(`${entity}_update`, { for: "update", to: appRole, using: write, withCheck: write }),
    pgPolicy(`${entity}_delete`, { for: "delete", to: appRole, using: write }),
  ];
};
