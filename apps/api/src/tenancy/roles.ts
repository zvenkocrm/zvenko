import type { AccessContext } from "@zvenko/db";

/** Роли по умолчанию (F-USR-02). Конструктор своих ролей появится в P1. */
export const ROLES = ["owner", "admin", "head", "manager"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Области видимости роли: свои / отдела / все (F-USR-03).
 * Владелец и администратор видят всё, руководитель — свой отдел, менеджер — свои сделки.
 */
export const ROLE_SCOPES: Readonly<Record<Role, AccessContext["scopes"]>> = {
  owner: { deals: { read: "all", write: "all" } },
  admin: { deals: { read: "all", write: "all" } },
  head: { deals: { read: "team", write: "team" } },
  manager: { deals: { read: "own", write: "own" } },
};

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);
