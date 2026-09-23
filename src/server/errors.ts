/**
 * Ошибки API.
 *
 * Отдельный класс нужен, чтобы отличать нарушение бизнес-правила Регламента
 * (его показываем пользователю дословно, со ссылкой на пункт) от внутреннего
 * сбоя, подробности которого наружу не выдаём.
 */

export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  status: number;
  code: string;
  /** Ошибки по полям формы — для подсветки в интерфейсе (ТЗ №4). */
  fields?: FieldErrors;
  /** Нарушенные условия перехода со ссылками на пункты Регламента. */
  failures?: { code: string; message: string; regulationRef: string }[];

  constructor(message: string, status = 400, code = 'bad_request') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  static badRequest(message: string, fields?: FieldErrors) {
    const e = new ApiError(message, 422, 'validation_failed');
    e.fields = fields;
    return e;
  }
  static unauthorized(message = 'Для работы войдите в систему') {
    return new ApiError(message, 401, 'unauthorized');
  }
  static forbidden(message = 'Недостаточно прав для этого действия') {
    return new ApiError(message, 403, 'forbidden');
  }
  static notFound(message = 'Запись не найдена') {
    return new ApiError(message, 404, 'not_found');
  }
  static conflict(message: string) {
    return new ApiError(message, 409, 'conflict');
  }
  /** Нарушены условия Регламента для перехода. */
  static regulation(failures: { code: string; message: string; regulationRef: string }[]) {
    const e = new ApiError(
      failures.map((f) => `${f.message} (${f.regulationRef})`).join('; '),
      422,
      'regulation_violation',
    );
    e.failures = failures;
    return e;
  }
}
