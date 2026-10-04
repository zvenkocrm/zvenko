import { Module } from "@nestjs/common";
import { DealsController } from "./deals.controller.js";
import { DealsService } from "./deals.service.js";

@Module({ controllers: [DealsController], providers: [DealsService] })
export class CrmModule {}
