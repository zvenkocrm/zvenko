import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { Config } from "./config.js";

export const CONFIG = Symbol("CONFIG");
export const LOGGER = Symbol("LOGGER");

/** Конфигурация и логгер, созданные при старте, — для всех модулей приложения. */
@Global()
@Module({})
export class ConfigModule {
  static register(config: Config, logger: Logger): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [CONFIG, LOGGER],
    };
  }
}
