import { Injectable } from "@nestjs/common";
import type { Transaction } from "@zvenko/db";
import type { DeliveredEvent } from "./events.js";

/** Повторы после сбоя обработчика: число попыток и пауза перед первой (дальше — удвоение). */
export interface RetryPolicy {
  readonly limit: number;
  readonly delaySeconds: number;
}

/**
 * Подписчик на события (F-EVT-02): роботы, уведомления, аналитика, вебхуки.
 *
 * Доставка — «хотя бы один раз»: событие может прийти повторно. Обработчик вызывается
 * в транзакции компании события вместе с отметкой «обработано», поэтому повтор не повторяет
 * действие в БД. Внешние действия (вебхук, письмо) должны быть идемпотентны сами — по ID события.
 */
export interface EventSubscriber {
  /** Имя подписчика — оно же имя его очереди: строчная латиница, цифры, `.`, `_`, `-`. */
  readonly name: string;
  /** Типы событий, например `deal.stage_changed`. */
  readonly events: readonly string[];
  readonly retry?: RetryPolicy;
  handle(tx: Transaction, event: DeliveredEvent): Promise<void>;
}

/** По умолчанию: 5 повторов с паузой 5 с, 10 с, 20 с… не больше 10 минут. */
export const DEFAULT_RETRY: RetryPolicy = { limit: 5, delaySeconds: 5 };

const SUBSCRIBER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Реестр подписчиков. Модули регистрируют подписчиков при инициализации (onModuleInit),
 * фоновые задачи подключают их при запуске приложения.
 */
@Injectable()
export class EventSubscribers {
  private readonly subscribers = new Map<string, EventSubscriber>();

  register(subscriber: EventSubscriber): void {
    if (!SUBSCRIBER_NAME.test(subscriber.name)) {
      throw new Error(`имя подписчика «${subscriber.name}» не подходит для очереди`);
    }
    if (this.subscribers.has(subscriber.name)) {
      throw new Error(`подписчик «${subscriber.name}» уже зарегистрирован`);
    }
    this.subscribers.set(subscriber.name, subscriber);
  }

  all(): readonly EventSubscriber[] {
    return [...this.subscribers.values()];
  }
}
