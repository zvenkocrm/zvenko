import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { configureApp, createAdapter } from "./app.js";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config/config.js";
import { createLogger, NestPinoLogger } from "./logging/logger.js";

const config = loadConfig(process.env);
const logger = createLogger(config.LOG_LEVEL);

// Состояние процесса после таких ошибок не определено: пишем в лог и перезапускаемся.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "необработанный отказ промиса");
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "необработанное исключение");
  process.exit(1);
});

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register(config, logger),
  createAdapter(config, logger),
  { logger: new NestPinoLogger(logger) },
);
configureApp(app);
// SIGTERM от оркестратора: дождаться текущих запросов, закрыть соединения с БД.
app.enableShutdownHooks();
await app.listen({ host: config.HOST, port: config.PORT });
