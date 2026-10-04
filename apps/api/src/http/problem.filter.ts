import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { toProblem } from "./problem.js";

/**
 * Все ошибки — в одном формате problem+json, включая ошибки Fastify до обработчика
 * (неверный JSON, размер тела) и неизвестные адреса: NestJS направляет их сюда же.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblem(exception);

    if (problem.status >= 500) {
      request.log.error({ err: exception }, "необработанная ошибка");
    }

    void reply
      .status(problem.status)
      .type("application/problem+json; charset=utf-8")
      .send({ ...problem, requestId: request.id });
  }
}
