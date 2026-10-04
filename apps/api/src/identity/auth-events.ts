/** Откуда пришёл запрос ко входу — как его увидел сервер. Значения не очищены. */
export interface AuthRequestSource {
  /** Адрес сайта: на адресе компании (`neva.zvenko.ru`) вход и выход относятся к ней. */
  readonly host: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

/**
 * События учётной записи (F-AUD-01). Кроме выхода, все они пишутся в журналы всех компаний
 * пользователя (D30): учётная запись одна, и её взлом угрожает каждой компании.
 */
export type AccountEvent =
  | {
      readonly type: "sign_in_failed";
      readonly userId: string;
      /** Неверный пароль, неверный второй фактор или аккаунт заблокирован. */
      readonly reason: "password" | "second_factor" | "locked";
    }
  | {
      readonly type:
        | "account_locked"
        | "two_factor_enabled"
        | "two_factor_disabled"
        | "backup_codes_generated"
        | "password_changed";
      readonly userId: string;
    }
  | {
      readonly type: "sessions_revoked";
      readonly userId: string;
      /** Одна сессия, все или все, кроме текущей. */
      readonly scope: "one" | "all" | "others";
    }
  | {
      readonly type: "signed_out";
      readonly userId: string;
      readonly sessionId: string;
      /** Компания, выбранная в сессии, — если выход не на адресе компании. */
      readonly tenantId: string | null;
    };

/**
 * События входа для журнала аудита (ADR-0006, ADR-0009). Модуль входа сообщает о них,
 * а пишет в журналы модуль audit: модулю входа не нужно знать о компаниях.
 */
export abstract class AuthEvents {
  /** Вход завершён — после пароля и, если включена, 2FA. Ошибка записи отменяет вход. */
  abstract signedIn(
    event: { readonly userId: string; readonly sessionId: string },
    source: AuthRequestSource,
  ): Promise<void>;

  /**
   * Остальные события пишутся в фоне, после ответа:
   * - ошибка записи не отменяет действие — выход нельзя блокировать;
   * - время ответа на неудачный вход не выдаёт, есть ли такая почта.
   */
  abstract record(event: AccountEvent, source: AuthRequestSource): void;

  /** Ждёт фоновые записи — при остановке приложения и в тестах. */
  abstract settled(): Promise<void>;
}
