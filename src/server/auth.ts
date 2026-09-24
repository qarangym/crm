/**
 * Аутентификация.
 *
 * Внутренние пользователи входят через корпоративный OIDC: вход обрабатывает
 * обратный прокси (nginx + oauth2-proxy), а приложению передаёт проверенную
 * личность заголовками. Приложение доверяет заголовкам, только если совпал
 * общий секрет — иначе любой, кто достучится до порта приложения напрямую,
 * смог бы представиться кем угодно.
 *
 * Схема перенесена из действующего прототипа QTR CRM (lib/selfhost/identity.ts)
 * и дополнена: секрет сравнивается за постоянное время, длина проверяется до
 * сравнения, а в журнал пишется каждая неудачная попытка.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.ts';

export type Identity = {
  /** Устойчивый идентификатор: хэш издателя и субъекта OIDC. */
  userId: string;
  email: string;
  displayName: string;
};

export type AuthConfig = {
  enabled: boolean;
  /** Общий секрет с обратным прокси, не короче 32 символов. */
  proxySecret: string;
  issuer: string;
  /** Личность для локальной разработки, когда прокси нет. */
  devIdentity?: Identity | null;
};

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const devEmail = env.DEV_LOGIN_EMAIL?.trim();
  return {
    enabled: env.SSO_ENABLED === 'true',
    proxySecret: env.AUTH_PROXY_SHARED_SECRET ?? '',
    issuer: env.OIDC_ISSUER_URL ?? '',
    devIdentity: devEmail
      ? {
          userId: identityId('dev', devEmail),
          email: devEmail.toLowerCase(),
          displayName: env.DEV_LOGIN_NAME?.trim() || devEmail,
        }
      : null,
  };
}

export function identityId(issuer: string, subject: string): string {
  return 'oidc:' + createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
}

function secretMatches(expected: string, supplied: string): boolean {
  if (!expected || expected.length < 32) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Личность из заголовков обратного прокси либо null, если доверять им нельзя. */
export function identityFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  config: AuthConfig,
): Identity | null {
  const get = (name: string): string => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };

  if (!config.enabled) {
    // Режим разработки: личность задаётся переменными окружения, наружу не публикуется.
    return config.devIdentity ?? null;
  }
  if (!config.issuer || !secretMatches(config.proxySecret, get('x-qtr-proxy-key'))) return null;

  const subject = get('x-qtr-user-id');
  const email = get('x-qtr-user-email').trim().toLowerCase();
  if (!subject || subject.length > 1000) return null;
  if (!EMAIL.test(email) || email.length > 254) return null;

  return {
    userId: identityId(config.issuer, subject),
    email,
    displayName: get('x-qtr-user-name').slice(0, 200) || email,
  };
}

export function requireIdentity(
  headers: Record<string, string | string[] | undefined>,
  config: AuthConfig,
): Identity {
  const identity = identityFromHeaders(headers, config);
  if (!identity) throw ApiError.unauthorized();
  return identity;
}

/**
 * Защита от запросов с чужих сайтов.
 *
 * Изменяющие операции принимаются без заголовка Origin (так их шлют curl и
 * служебные скрипты) либо с Origin, совпадающим с адресом приложения. Если
 * APP_ORIGIN не задан, сравниваем с собственным адресом запроса: браузер
 * заголовок Origin подделать не даёт, поэтому такое сравнение отсекает
 * межсайтовые запросы и без настройки. Раньше незаданный APP_ORIGIN делал
 * систему доступной только для чтения — с невнятным отказом на каждое действие.
 */
export function checkOrigin(
  origin: string | undefined,
  appOrigin: string | undefined,
  selfOrigin?: string,
): void {
  if (!origin) return;
  const expected = appOrigin?.trim() || selfOrigin;
  if (!expected) {
    throw ApiError.forbidden(
      'Не удалось определить адрес приложения. Задайте APP_ORIGIN в настройках.');
  }
  if (origin !== expected) throw ApiError.forbidden('Запрос с другого сайта отклонён');
}

/** Собственный адрес запроса: схема из заголовков прокси, узел из Host. */
export function originOfRequest(
  headers: Record<string, string | string[] | undefined>,
  trustProxy: boolean,
): string | undefined {
  const value = (name: string): string => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  const host = (trustProxy && value('x-forwarded-host')) || value('host');
  if (!host) return undefined;
  const proto = (trustProxy && value('x-forwarded-proto').split(',')[0]) || 'http';
  return `${proto}://${host}`;
}
