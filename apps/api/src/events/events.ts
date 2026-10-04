import { Injectable } from "@nestjs/common";
import { newId, outbox, type Transaction } from "@zvenko/db";
import { z } from "zod";

export type EventJson =
  string | number | boolean | null | readonly EventJson[] | { readonly [key: string]: EventJson };

/** Кто изменил данные: пользователь, сотрудник поддержки или система (робот, импорт). */
export type EventActor =
  { readonly type: "user" | "support"; readonly id: string } | { readonly type: "system" };

/** Событие предметной области (F-EVT-01): что случилось, с каким объектом, кто автор. */
export interface DomainEvent {
  /** `сущность.событие`, например `deal.stage_changed`. */
  readonly type: string;
  readonly object: { readonly type: string; readonly id: string };
  readonly actor: EventActor;
  /** Изменённые поля и значения, нужные подписчикам. */
  readonly data?: Readonly<Record<string, EventJson>>;
}

/** Событие так, как его получает подписчик: с ID, компанией и временем. */
export interface DeliveredEvent extends DomainEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly occurredAt: string;
}

/**
 * Проверка события из очереди. Неверное событие — ошибка обработки: после повторов оно
 * уходит в мёртвую очередь, а не ломает обработчик.
 */
export const deliveredEventSchema = z.object({
  id: z.uuid(),
  tenantId: z.uuid(),
  type: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/),
  object: z.object({ type: z.string().regex(/^[a-z][a-z_]{0,31}$/), id: z.uuid() }),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.enum(["user", "support"]), id: z.uuid() }),
    z.object({ type: z.literal("system") }),
  ]),
  data: z.record(z.string(), z.json()),
  occurredAt: z.iso.datetime(),
});

/**
 * Публикация событий (ADR-0005). Событие пишется в outbox в транзакции изменения:
 * его доставят, только если транзакция зафиксируется, — и доставят, даже если сразу
 * после фиксации процесс упадёт.
 */
@Injectable()
export class EventBus {
  /** Публикует событие компании в транзакции `TenantDb`. Возвращает ID события. */
  async publish(tx: Transaction, tenantId: string, event: DomainEvent): Promise<string> {
    const id = newId();
    await tx.insert(outbox).values({
      tenantId,
      id,
      type: event.type,
      objectType: event.object.type,
      objectId: event.object.id,
      actorType: event.actor.type,
      actorId: "id" in event.actor ? event.actor.id : null,
      data: event.data ?? {},
    });
    return id;
  }
}
