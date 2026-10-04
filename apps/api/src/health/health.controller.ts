import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Database } from "@zvenko/db";
import { sql } from "drizzle-orm";
import { DATABASE } from "../database/database.module.js";
import { Public } from "../tenancy/access.js";

/**
 * Проверки для балансировщика и оркестратора (REL-01). Без входа и без подробностей:
 * ответ не раскрывает устройство системы.
 */
@Public()
@Controller("health")
export class HealthController implements BeforeApplicationShutdown {
  private shuttingDown = false;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Процесс жив. Перезапуск — только если не отвечает этот адрес. */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Готов принимать запросы: есть связь с БД и не идёт остановка. */
  @Get("ready")
  async ready(): Promise<{ status: "ok" }> {
    if (this.shuttingDown) throw new ServiceUnavailableException();
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException();
    }
    return { status: "ok" };
  }

  /** При остановке сначала снимаем экземпляр с балансировки, затем закрываем соединения. */
  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }
}
