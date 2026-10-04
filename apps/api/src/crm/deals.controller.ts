import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import type { AccessContext } from "@zvenko/db";
import { z } from "zod";
import { Access } from "../tenancy/access.js";
import { type DealView, DealsService } from "./deals.service.js";

/**
 * Сделки — чтение. Здесь минимум для проверки фундамента: доступ, изоляция компаний,
 * области видимости. Создание, этапы и карточку добавит модуль CRM (P1).
 */
@Controller({ path: "deals", version: "1" })
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  async list(@Access() access: AccessContext): Promise<{ items: DealView[] }> {
    return { items: await this.deals.list(access) };
  }

  @Get(":id")
  async get(
    @Access() access: AccessContext,
    @Param("id", { schema: z.uuid() }) id: string,
  ): Promise<DealView> {
    const deal = await this.deals.get(access, id);
    // Чужая и несуществующая сделка неразличимы: 404, а не 403 (SEC-05).
    if (!deal) throw new NotFoundException();
    return deal;
  }
}
