import { HttpException, HttpStatus } from "@nestjs/common";

/** Ошибка поля в запросе: путь и причина, без значения — в значении могут быть ПДн. */
export interface FieldError {
  readonly path: string;
  readonly message: string;
}

/** Ответ об ошибке в формате RFC 9457 (application/problem+json). */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
}

const TITLES: Readonly<Record<number, string>> = {
  400: "Некорректный запрос",
  401: "Нужно войти",
  403: "Доступ запрещён",
  404: "Не найдено",
  405: "Метод не поддерживается",
  409: "Конфликт",
  413: "Слишком большой запрос",
  415: "Неподдерживаемый формат данных",
  421: "Неизвестный адрес сайта",
  422: "Данные не прошли проверку",
  429: "Слишком много запросов",
  500: "Внутренняя ошибка",
  503: "Сервис временно недоступен",
};

const titleFor = (status: number): string =>
  TITLES[status] ?? (status >= 500 ? "Внутренняя ошибка" : "Некорректный запрос");

/**
 * Ошибка, которую код приложения показывает клиенту как есть: `detail` и `errors`
 * пишутся для человека. Встроенные исключения NestJS отдают только заголовок —
 * их тексты на английском и могут раскрывать внутреннее устройство.
 */
export class ProblemException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly detail?: string,
    readonly errors?: readonly FieldError[],
  ) {
    super(titleFor(status), status);
  }
}

/** Ошибки Fastify (разбор тела, размер, формат) приходят с кодом статуса. */
function fastifyStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { statusCode, code } = error as { statusCode?: unknown; code?: unknown };
  return typeof statusCode === "number" && typeof code === "string" && code.startsWith("FST_")
    ? statusCode
    : undefined;
}

/** Любая ошибка → ответ клиенту. О внутренних ошибках клиент узнаёт только код 500 и ID запроса. */
export function toProblem(error: unknown): Problem {
  let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
  if (error instanceof HttpException) status = error.getStatus();
  else status = fastifyStatus(error) ?? status;

  const problem: Problem = { type: "about:blank", title: titleFor(status), status };
  if (error instanceof ProblemException && status < 500) {
    return {
      ...problem,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.errors === undefined ? {} : { errors: error.errors }),
    };
  }
  return problem;
}
