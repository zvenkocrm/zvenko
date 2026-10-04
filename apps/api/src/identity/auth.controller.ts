import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public } from "../tenancy/access.js";
import type { Auth } from "./auth.js";
import { AUTH } from "./tokens.js";
import { sendWebResponse, toWebRequest } from "./web-request.js";

/**
 * Эндпоинты Better Auth: вход, выход, сессии. Без проверки доступа NestJS — вход
 * и есть способ получить сессию; защита от CSRF и заголовки безопасности действуют как везде.
 */
@Public()
@Controller("auth")
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  @Get("*")
  get(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  @Post("*")
  post(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    return this.forward(request, reply);
  }

  private async forward(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const response = await this.auth.handler(toWebRequest(request));
    await sendWebResponse(reply, response);
  }
}
