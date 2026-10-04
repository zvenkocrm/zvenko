import {
  HttpStatus,
  RequestMethod,
  StandardSchemaValidationPipe,
  VersioningType,
} from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { LogController } from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "./config/config.js";
import { createHostMatcher } from "./http/allowed-hosts.js";
import { ProblemException } from "./http/problem.js";
import { ProblemFilter } from "./http/problem.filter.js";
import { requestId } from "./http/request-id.js";

/** Тело JSON-запроса — до 1 МБ. Файлы загружаются в хранилище напрямую, по подписанным ссылкам. */
const BODY_LIMIT = 1024 * 1024;

const trustHops =
  (hops: number) =>
  (_address: string, hop: number): boolean =>
    hop < hops;

export function createAdapter(config: Config, logger: Logger): FastifyAdapter {
  return new FastifyAdapter({
    loggerInstance: logger,
    genReqId: requestId,
    // Свою строку лога на запрос пишем сами (onResponse) — без query-строки, где могут быть ПДн.
    logController: new LogController({
      requestIdLogLabel: "requestId",
      disableRequestLogging: true,
    }),
    // Число прокси — функцией: так же считает proxy-addr внутри Fastify.
    trustProxy:
      typeof config.TRUST_PROXY === "number" ? trustHops(config.TRUST_PROXY) : config.TRUST_PROXY,
    bodyLimit: BODY_LIMIT,
  });
}

/**
 * Общая настройка приложения — для запуска (main.ts) и для тестов, чтобы тесты проверяли
 * ровно то, что работает в продакшене.
 */
export function configureApp(app: NestFastifyApplication, config: Config): void {
  // Сообщения проверки данных — по-русски.
  z.config(z.locales.ru());

  // API отдаёт только JSON: его нельзя встроить в страницу или исполнить как скрипт (SEC-10).
  app.useSecurityHeaders({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: "'none'",
        frameAncestors: "'none'",
        baseUri: "'none'",
        formAction: "'none'",
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
    xFrameOptions: { action: "deny" },
  });
  // Изменяющие запросы с чужих сайтов отклоняются по Sec-Fetch-Site и Origin (CSRF, SEC-10).
  app.enableCsrfProtection();

  app.setGlobalPrefix("api", {
    exclude: [
      { path: "health/live", method: RequestMethod.GET },
      { path: "health/ready", method: RequestMethod.GET },
    ],
  });
  app.enableVersioning({ type: VersioningType.URI });

  app.useGlobalFilters(new ProblemFilter());
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new ProblemException(
          HttpStatus.BAD_REQUEST,
          "Проверьте поля запроса",
          issues.map((issue) => ({
            path: (issue.path ?? [])
              .map((segment) => String(typeof segment === "object" ? segment.key : segment))
              .join("."),
            message: issue.message,
          })),
        ),
    }),
  );

  const fastify = app.getHttpAdapter().getInstance();
  // Профиль доступа выставляет AccessGuard; поле объявлено заранее — так Fastify быстрее.
  fastify.decorateRequest("access", null);
  fastify.addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });
  // API отвечает только на своих адресах: подменённый Host не попадёт в ссылки из писем
  // и в кэши (защита от атак через заголовок Host). Проверки здоровья балансировщик зовёт по IP.
  const isAllowedHost = createHostMatcher(config.AUTH_ORIGINS);
  fastify.addHook("onRequest", (request, _reply, done) => {
    if (request.url.startsWith("/api/") && !isAllowedHost(request.host)) {
      done(new ProblemException(HttpStatus.MISDIRECTED));
      return;
    }
    done();
  });
  fastify.addHook("onResponse", (request, reply, done) => {
    if (!request.url.startsWith("/health/")) {
      request.log.info(
        {
          method: request.method,
          route: request.routeOptions.url,
          status: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
        },
        "запрос",
      );
    }
    done();
  });
}
