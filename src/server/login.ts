/**
 * Вход, регистрация и восстановление пароля — без корпоративного провайдера.
 *
 * Одна схема для всех (решение 29.09.2026, как в наброске ТЗ v1.2): почта и
 * пароль, затем одноразовый код на почту. Сотрудников заводит ДИТ и
 * присылает приглашение — сотрудник сам задаёт пароль по ссылке. Заказчик
 * регистрируется сам по БИН; представитель уже известной организации ждёт
 * подтверждения ДИТ, иначе любой, кто знает БИН, увидел бы чужие заявки.
 *
 * Что защищает:
 *  - пароль — только свёртка scrypt (passwords.ts); код и ключ сессии — только свёртки;
 *  - подбор пароля — ограничение частоты по адресу и по почте, блокировка на 15 минут
 *    после 10 неудачных попыток; каждая попытка — в журнале;
 *  - подбор кода — 6 цифр, 10 минут, 5 попыток, одноразовый;
 *  - перебор адресов — одинаковые ответы для существующей и несуществующей почты;
 *  - кража сессии — cookie HttpOnly, SameSite=Lax, Secure; 30 минут бездействия,
 *    не более 12 часов; смена пароля и отключение учётной записи закрывают все сессии.
 */

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Db } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import { formatPhone, validBin, validEmail, validPhone } from '../domain/validation.ts';
import { ApiError } from './errors.ts';
import type { Ctx, Router } from './http.ts';
import { roleRecipients, notify } from './notify.ts';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.ts';
import { RateLimiter } from './ratelimit.ts';
import type { Actor } from './rbac.ts';
import type { Audit } from './context.ts';

export type SendMail = (to: string, subject: string, text: string) => Promise<void>;

export type LocalAuthOptions = {
  /** Секрет для свёрток кодов, не короче 32 символов (AUTH_SECRET). */
  secret: string;
  /** Флаг Secure у cookie; выключается только для разработки по http. */
  cookieSecure: boolean;
  /** Отправка письма сразу, минуя очередь: код живёт 10 минут. */
  sendMail?: SendMail | null;
  /** Самостоятельная регистрация Заказчиков (AUTH_SELF_REGISTRATION). */
  selfRegistration: boolean;
  /** Адрес системы для ссылок в письмах. */
  appOrigin?: string;
  /** Первый администратор: «Забыли пароль» на этот адрес создаёт его, если администраторов нет. */
  bootstrapAdminEmail?: string;
  /** Пределы частоты за 15 минут (с одного адреса и на одну почту); регистраций — за час. Меняются для тестов. */
  limits?: { perIp?: number; perEmail?: number; registrations?: number };
  /**
   * Демонстрационный стенд (DEMO_MODE): код входа возвращается в ответе и показывается на экране,
   * страница входа перечисляет демонстрационные учётные записи. Второго фактора на таком стенде
   * фактически нет — только для показа на вымышленных данных (npm run seed:scenario).
   */
  demoMode?: boolean;
  /** Общий пароль демонстрационных учётных записей (DEMO_PASSWORD) — подсказка на странице входа. */
  demoPassword?: string;
};

export const SESSION_COOKIE = 'qtr_session';
const SESSION_IDLE_MIN = 30;
const SESSION_MAX_HOURS = 12;
const CODE_TTL_MIN = 10;
const CODE_ATTEMPTS = 5;
const RESET_TTL_MIN = 30;
const INVITE_TTL_HOURS = 72;
const LOCK_AFTER = 10;
const LOCK_MIN = 15;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/* --------------------------------- сессии -------------------------------- */

export function sessionToken(headers: IncomingHttpHeaders): string | null {
  const raw = headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** Пользователь действующей сессии; продлевает сессию не чаще раза в минуту. */
export async function sessionUser(db: Db, token: string): Promise<string | null> {
  const row = await db.one<{ id: string; user_id: string; stale: boolean }>(
    `SELECT id, user_id, last_seen_at < now() - interval '1 minute' AS stale
       FROM auth_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
        AND last_seen_at > now() - ($2 || ' minutes')::interval`, [sha256(token), String(SESSION_IDLE_MIN)]);
  if (!row) return null;
  if (row.stale) await db.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
  return row.user_id;
}

async function openSession(db: Db, userId: string, ctx: Ctx): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval, $4::inet, $5)`,
    [sha256(token), userId, String(SESSION_MAX_HOURS), ctx.ip, String(ctx.req.headers['user-agent'] ?? '').slice(0, 500)]);
  return token;
}

/** Закрыть все сессии пользователя: смена пароля, отключение учётной записи, «выйти везде». */
export async function revokeSessions(db: Db, userId: string): Promise<number> {
  const rows = await db.query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId]);
  return rows.length;
}

function cookie(value: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/* ------------------------------ коды и ссылки ----------------------------- */

type Purpose = 'login' | 'verify' | 'reset' | 'invite';

/** Маска почты для ответа: «ivanov@qtr.kz» → «iv***@qtr.kz». */
const mask = (email: string) => email.replace(/^(.{1,2})[^@]*(@.*)$/, '$1***$2');

export function createLoginRoutes(db: Db, options: LocalAuthOptions, helpers: {
  guardOrigin(ctx: Ctx): void;
  audit(ctx: Ctx, actor: Actor | null): Audit;
  actor(ctx: Ctx): Promise<Actor>;
  originOf(ctx: Ctx): string;
}) {
  const secretHash = (challengeId: string, secret: string) =>
    createHmac('sha256', options.secret).update(`${challengeId}:${secret}`).digest('hex');

  const perIp = new RateLimiter({ windowMs: 15 * 60_000, max: options.limits?.perIp ?? 40 });
  const perEmail = new RateLimiter({ windowMs: 15 * 60_000, max: options.limits?.perEmail ?? 10 });
  const registrations = new RateLimiter({ windowMs: 60 * 60_000, max: options.limits?.registrations ?? 5 });

  function limit(limiter: RateLimiter, key: string) {
    const verdict = limiter.check(key);
    if (!verdict.allowed) {
      throw new ApiError(`Слишком много попыток. Повторите через ${Math.ceil(verdict.retryAfterSec / 60)} мин.`, 429, 'too_many_attempts');
    }
  }

  async function deliver(to: string, subject: string, text: string): Promise<void> {
    if (options.sendMail) {
      try {
        await options.sendMail(to, subject, text);
      } catch (error) {
        console.error('[вход] письмо не отправлено:', (error as Error).message);
        throw new ApiError('Не удалось отправить письмо. Повторите через несколько минут.', 503, 'mail_unavailable');
      }
      return;
    }
    // Почта не подключена (стенд, разработка): письмо — в журнал сервера, не в базу.
    console.log(`[вход] почта выключена (SMTP_ENABLED). Письмо для ${to}: ${subject}\n${text}`);
  }

  async function challenge(userId: string, purpose: Purpose, ctx: Ctx): Promise<{ id: string; secret: string }> {
    // Прежние неиспользованные коды того же назначения гаснут: действует только последний.
    await db.query(
      `UPDATE auth_challenges SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
      [userId, purpose]);
    const link = purpose === 'reset' || purpose === 'invite';
    const secret = link ? randomBytes(32).toString('base64url') : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const ttl = purpose === 'invite' ? `${INVITE_TTL_HOURS} hours` : purpose === 'reset' ? `${RESET_TTL_MIN} minutes` : `${CODE_TTL_MIN} minutes`;
    const id = randomUUID();
    await db.query(
      `INSERT INTO auth_challenges (id, user_id, purpose, secret_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, $4, now() + $5::interval, $6::inet)`,
      [id, userId, purpose, secretHash(id, secret), ttl, ctx.ip]);
    return { id, secret };
  }

  /** Проверка кода или ссылки. Ошибка — всегда одинаковая: «неверный или истёк». */
  async function consume(id: string, secret: string, purposes: Purpose[]) {
    const bad = () => ApiError.badRequest('Код неверный или устарел', { code: 'Проверьте код или запросите новый' });
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw bad();
    const row = await db.one<{ user_id: string; purpose: Purpose; secret_hash: string; attempts: number }>(
      `UPDATE auth_challenges SET attempts = attempts + 1
        WHERE id = $1 AND used_at IS NULL AND expires_at > now() AND purpose = ANY($2::text[])
        RETURNING user_id, purpose, secret_hash, attempts`, [id, purposes]);
    if (!row) throw bad();
    if (row.attempts > CODE_ATTEMPTS) {
      await db.query('UPDATE auth_challenges SET used_at = now() WHERE id = $1', [id]);
      throw new ApiError('Код больше не действует: слишком много попыток. Запросите новый.', 429, 'too_many_attempts');
    }
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(secretHash(id, String(secret ?? '').trim()), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw bad();
    await db.query('UPDATE auth_challenges SET used_at = now() WHERE id = $1', [id]);
    return row;
  }

  async function sendCode(user: { id: string; email: string }, purpose: 'login' | 'verify', ctx: Ctx) {
    const c = await challenge(user.id, purpose, ctx);
    await deliver(user.email, purpose === 'verify' ? `Код подтверждения почты: ${c.secret}` : `Код входа: ${c.secret}`, [
      purpose === 'verify' ? 'Код подтверждения адреса почты:' : 'Код для входа в систему:',
      '',
      `    ${c.secret}`,
      '',
      `Код действует ${CODE_TTL_MIN} минут. Если вы не запрашивали код — ничего не делайте и смените пароль.`,
    ].join('\n'));
    return { challengeId: c.id, sentTo: mask(user.email), ...(options.demoMode ? { demoCode: c.secret } : {}) };
  }

  async function sendLink(user: { id: string; email: string; full_name?: string }, purpose: 'reset' | 'invite', ctx: Ctx) {
    const c = await challenge(user.id, purpose, ctx);
    const url = `${options.appOrigin || helpers.originOf(ctx)}/login.html?${purpose}=${c.id}.${c.secret}`;
    await deliver(user.email, purpose === 'invite' ? 'Приглашение в систему АО «Казтелерадио»' : 'Восстановление пароля', [
      purpose === 'invite'
        ? `Для вас заведена учётная запись в системе заявок АО «Казтелерадио»${user.full_name ? ` (${user.full_name})` : ''}.`
        : 'Запрошено восстановление пароля.',
      '',
      purpose === 'invite' ? 'Задайте пароль по ссылке:' : 'Задайте новый пароль по ссылке:',
      url,
      '',
      purpose === 'invite'
        ? `Ссылка действует ${INVITE_TTL_HOURS} часа и только один раз.`
        : `Ссылка действует ${RESET_TTL_MIN} минут и только один раз. Если вы не запрашивали восстановление — ничего не делайте.`,
    ].join('\n'));
  }

  type UserRow = {
    id: string; email: string; full_name: string; password_hash: string | null; is_active: boolean;
    email_verified_at: string | null; locked_until: string | null; locked: boolean; registration_pending: boolean;
  };
  const findUser = (email: string) => db.one<UserRow>(
    `SELECT id, email, full_name, password_hash, is_active, email_verified_at, locked_until,
            coalesce(locked_until > now(), false) AS locked, registration_pending
       FROM users WHERE email = $1`, [email]);

  const log = (ctx: Ctx, e: { action: string; userId?: string | null; email: string; result?: 'success' | 'denied' | 'error'; detail?: string }) =>
    repo.logEvent(db, {
      ...helpers.audit(ctx, null), actorId: e.userId ?? null, actorName: e.email,
      action: e.action, entity: 'user', entityId: e.userId ?? e.email, detail: e.detail ?? '', result: e.result ?? 'success',
    });

  function register(router: Router) {
    /**
     * Демонстрационный стенд: учётные записи для показа (их записывает npm run seed:scenario
     * в настройку demo.accounts). На рабочем контуре маршрута нет — 404.
     */
    router.get('/api/v1/auth/demo', async () => {
      if (!options.demoMode) throw ApiError.notFound('Маршрут не найден');
      const setting = await db.one<{ value: unknown }>(`SELECT value FROM settings WHERE key = 'demo.accounts'`);
      const listed = Array.isArray(setting?.value) ? setting!.value as { email: string; title: string }[] : [];
      const rows = listed.length ? await db.query<{ email: string; full_name: string }>(
        `SELECT email, full_name FROM users WHERE is_active AND email = ANY($1::text[])`, [listed.map((a) => a.email)]) : [];
      const names = new Map(rows.map((r) => [r.email, r.full_name]));
      return {
        password: options.demoPassword ?? '',
        accounts: listed.filter((a) => names.has(a.email)).map((a) => ({ ...a, fullName: names.get(a.email) })),
      };
    });

    /** Шаг 1: почта и пароль. Верно — код на почту. */
    router.post('/api/v1/auth/login', async (ctx) => {
      helpers.guardOrigin(ctx);
      const body = await ctx.body<{ email?: string; password?: string }>();
      const email = String(body.email ?? '').trim().toLowerCase();
      limit(perIp, `login:${ctx.ip}`);
      limit(perEmail, `login:${email}`);
      const user = email ? await findUser(email) : null;
      const ok = await verifyPassword(String(body.password ?? ''), user?.password_hash ?? null);
      if (user?.locked) {
        await log(ctx, { action: 'Вход отклонён: учётная запись временно заблокирована', userId: user.id, email, result: 'denied' });
        throw new ApiError(`Слишком много неудачных попыток. Вход заблокирован на ${LOCK_MIN} минут.`, 429, 'too_many_attempts');
      }
      if (!user || !ok) {
        if (user) {
          const row = await db.one<{ failed_logins: number }>(
            `UPDATE users SET failed_logins = failed_logins + 1,
                    locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval END
              WHERE id = $1 RETURNING failed_logins`, [user.id, LOCK_AFTER, String(LOCK_MIN)]);
          if ((row?.failed_logins ?? 0) >= LOCK_AFTER) await db.query('UPDATE users SET failed_logins = 0 WHERE id = $1', [user.id]);
        }
        await log(ctx, { action: 'Неудачный вход', userId: user?.id, email, result: 'denied', detail: user ? 'неверный пароль' : 'адрес не найден' });
        throw new ApiError('Неверная почта или пароль', 401, 'bad_credentials');
      }
      if (!user.is_active) {
        await log(ctx, { action: 'Вход отклонён: учётная запись не активна', userId: user.id, email, result: 'denied' });
        throw ApiError.forbidden(user.registration_pending
          ? 'Регистрация ожидает подтверждения ДИТ. Мы сообщим на почту, когда доступ будет открыт.'
          : 'Учётная запись отключена. Обратитесь в ДИТ.');
      }
      return sendCode(user, user.email_verified_at ? 'login' : 'verify', ctx);
    });

    /** Шаг 2: код из письма — открывается сессия. */
    router.post('/api/v1/auth/login/code', async (ctx) => {
      helpers.guardOrigin(ctx);
      limit(perIp, `code:${ctx.ip}`);
      const body = await ctx.body<{ challengeId?: string; code?: string }>();
      const c = await consume(String(body.challengeId ?? ''), String(body.code ?? ''), ['login', 'verify']);
      const user = await db.one<{ id: string; email: string; is_active: boolean; registration_pending: boolean }>(
        `UPDATE users SET failed_logins = 0, locked_until = NULL,
                email_verified_at = coalesce(email_verified_at, now())
          WHERE id = $1 RETURNING id, email, is_active, registration_pending`, [c.user_id]);
      if (!user) throw ApiError.badRequest('Код неверный или устарел');
      if (!user.is_active) {
        await log(ctx, { action: 'Почта подтверждена, регистрация ждёт подтверждения ДИТ', userId: user.id, email: user.email });
        return { pending: true };
      }
      const token = await openSession(db, user.id, ctx);
      await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await log(ctx, { action: c.purpose === 'verify' ? 'Почта подтверждена, вход в систему' : 'Вход в систему', userId: user.id, email: user.email });
      ctx.res.setHeader('Set-Cookie', cookie(token, SESSION_MAX_HOURS * 3600, options.cookieSecure));
      return { ok: true };
    });

    router.post('/api/v1/auth/logout', async (ctx) => {
      helpers.guardOrigin(ctx);
      const token = sessionToken(ctx.req.headers);
      if (token) {
        const row = await db.one<{ user_id: string }>(
          `UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id`, [sha256(token)]);
        if (row) await log(ctx, { action: 'Выход из системы', userId: row.user_id, email: '' });
      }
      ctx.res.setHeader('Set-Cookie', cookie('', 0, options.cookieSecure));
      return { ok: true };
    });

    /** «Выйти на всех устройствах». */
    router.post('/api/v1/auth/logout-all', async (ctx) => {
      helpers.guardOrigin(ctx);
      const actor = await helpers.actor(ctx);
      const n = await revokeSessions(db, actor.id);
      await repo.logEvent(db, { ...helpers.audit(ctx, actor), action: 'Выход на всех устройствах', entity: 'user', entityId: actor.id, detail: `закрыто сессий: ${n}` });
      ctx.res.setHeader('Set-Cookie', cookie('', 0, options.cookieSecure));
      return { ok: true, closed: n };
    });

    /**
     * Самостоятельная регистрация по БИН: Заказчик услуг ОР ПСД или подрядчик портала допусков.
     * Подрядчик допускается на объекты связи, поэтому его регистрацию всегда подтверждает
     * ДИТ по данным СУА; Заказчик новой организации получает доступ сразу.
     */
    router.post('/api/v1/auth/register', async (ctx) => {
      helpers.guardOrigin(ctx);
      if (!options.selfRegistration) throw ApiError.forbidden('Самостоятельная регистрация выключена. Обратитесь в ДИТ.');
      const b = await ctx.body<Record<string, unknown>>();
      const v = {
        company: String(b.company ?? '').trim(), bin: String(b.bin ?? '').trim(),
        fullName: String(b.fullName ?? '').trim(), position: String(b.position ?? '').trim(),
        phone: formatPhone(b.phone), email: String(b.email ?? '').trim().toLowerCase(),
        password: String(b.password ?? ''),
        role: b.kind === 'contractor' ? 'contractor' as const : 'customer' as const,
      };
      const fields: Record<string, string> = {};
      const LETTERS = 'A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі';
      if (v.company.length < 3 || v.company.length > 255 || !new RegExp(`[${LETTERS}]{2}`).test(v.company)) {
        fields.company = 'Укажите наименование организации';
      }
      if (!validBin(v.bin)) fields.bin = 'БИН: 12 цифр, проверьте контрольный разряд';
      const words = v.fullName.split(/\s+/).filter(Boolean);
      if (words.length < 2 || v.fullName.length > 150 || !words.every((w) => new RegExp(`^[${LETTERS}][${LETTERS}'’.-]*$`).test(w))) {
        fields.fullName = 'Фамилия и имя — буквами, через пробел';
      }
      if (v.position.length > 150) fields.position = 'Не длиннее 150 символов';
      if (!validPhone(v.phone)) fields.phone = 'Номер Казахстана: +7 7XX XXX XX XX';
      if (!validEmail(v.email)) fields.email = 'Проверьте адрес почты';
      const weak = passwordProblem(v.password, v.email);
      if (weak) fields.password = weak;
      if (b.consent !== true) fields.consent = 'Нужно согласие на обработку персональных данных';
      if (Object.keys(fields).length) throw ApiError.badRequest('Проверьте заполнение формы', fields);
      limit(registrations, `register:${ctx.ip}`);

      const existing = await findUser(v.email);
      if (existing) {
        // Ответ тот же, что при новой регистрации: по форме нельзя узнать, чей адрес занят.
        await deliver(v.email, 'Попытка повторной регистрации', [
          'Кто-то попытался зарегистрироваться в системе заявок АО «Казтелерадио» с вашим адресом.',
          'Адрес уже зарегистрирован. Войдите с паролем или восстановите пароль на странице входа.',
          'Если это были не вы — ничего не делайте.',
        ].join('\n'));
        await log(ctx, { action: 'Повторная регистрация занятого адреса', userId: existing.id, email: v.email, result: 'denied' });
        return { challengeId: randomUUID(), sentTo: mask(v.email) };
      }

      const known = await db.one<{ id: string }>('SELECT id FROM counterparties WHERE bin = $1', [v.bin]);
      const counterpartyId = known?.id ?? (await repo.resolveCounterparty(db, {
        bin: v.bin, company: v.company, email: v.email, phone: v.phone, contact: v.fullName,
      })).id;
      // Организация уже есть, а подрядчика на объекты в любом случае допускает СУА — подтверждает ДИТ.
      const pending = !!known || v.role === 'contractor';
      const passwordHash = await hashPassword(v.password);
      const user = await db.tx(async (t) => {
        const row = await t.one<{ id: string; email: string }>(
          `INSERT INTO users (email, full_name, position, phone, counterparty_id, is_active, registration_pending,
                              password_hash, password_changed_at, personal_data_consent_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now()) RETURNING id, email`,
          [v.email, v.fullName, v.position, v.phone, counterpartyId, !pending, pending, passwordHash]);
        await t.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [row!.id, v.role]);
        return row!;
      });
      await log(ctx, {
        action: v.role === 'contractor' ? 'Самостоятельная регистрация подрядчика' : 'Самостоятельная регистрация Заказчика',
        userId: user.id, email: v.email,
        detail: `${v.company}, БИН ${v.bin}${pending ? '; ждёт подтверждения ДИТ' : ''}`,
      });
      if (pending) {
        await notify(db, await roleRecipients(db, v.role === 'contractor' ? ['admin', 'permits'] : ['admin']), {
          eventKey: 'registration_pending',
          subject: `Регистрация ${v.role === 'contractor' ? 'подрядчика' : 'представителя'}: ${v.company}`,
          body: `${v.fullName} (${v.email}, ${v.phone}) зарегистрировался как ${v.role === 'contractor' ? 'подрядчик (портал допусков)' : 'представитель Заказчика'} ` +
            `организации ${v.company}, БИН ${v.bin}.\n` +
            (v.role === 'contractor' ? 'Проверьте организацию и включите учётную запись на экране «Пользователи» (ДИТ).'
              : 'Организация уже есть в системе. Проверьте полномочия и включите учётную запись на экране «Пользователи».'),
          payload: { userId: user.id },
        });
      }
      return sendCode(user, 'verify', ctx);
    });

    /** Восстановление пароля: ответ всегда одинаковый. */
    router.post('/api/v1/auth/password/forgot', async (ctx) => {
      helpers.guardOrigin(ctx);
      const body = await ctx.body<{ email?: string }>();
      const email = String(body.email ?? '').trim().toLowerCase();
      limit(perIp, `forgot:${ctx.ip}`);
      limit(perEmail, `forgot:${email}`);
      if (validEmail(email)) {
        if (options.bootstrapAdminEmail && email === options.bootstrapAdminEmail.toLowerCase()) {
          // Первичная настройка: первый администратор задаёт пароль через «Забыли пароль».
          await repo.bootstrapAdmin(db, email, email);
        }
        const user = await findUser(email);
        if (user?.is_active) {
          await sendLink(user, user.password_hash ? 'reset' : 'invite', ctx);
          await log(ctx, { action: 'Запрошено восстановление пароля', userId: user.id, email });
        }
      }
      return { ok: true };
    });

    /** Новый пароль по ссылке из письма: восстановление или приглашение. */
    router.post('/api/v1/auth/password/reset', async (ctx) => {
      helpers.guardOrigin(ctx);
      limit(perIp, `reset:${ctx.ip}`);
      const body = await ctx.body<{ token?: string; password?: string }>();
      const [id, secret] = String(body.token ?? '').split('.');
      const pending = await db.one<{ email: string }>(
        `SELECT u.email FROM auth_challenges c JOIN users u ON u.id = c.user_id WHERE c.id::text = $1`, [/^[0-9a-f-]{36}$/i.test(id ?? '') ? id : '']);
      const weak = passwordProblem(body.password, pending?.email ?? '');
      if (weak) throw ApiError.badRequest('Пароль не подходит', { password: weak });
      const c = await consume(id ?? '', secret ?? '', ['reset', 'invite']);
      const user = await db.one<{ id: string; email: string }>(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = NULL,
                email_verified_at = coalesce(email_verified_at, now())
          WHERE id = $1 RETURNING id, email`, [c.user_id, await hashPassword(String(body.password))]);
      const closed = await revokeSessions(db, c.user_id);
      await log(ctx, { action: c.purpose === 'invite' ? 'Задан пароль по приглашению' : 'Пароль изменён по ссылке', userId: c.user_id, email: user!.email, detail: `закрыто сессий: ${closed}` });
      if (c.purpose === 'reset') {
        await deliver(user!.email, 'Пароль изменён', 'Пароль к системе заявок АО «Казтелерадио» изменён. Все открытые сеансы закрыты.\n' +
          'Если это были не вы — сразу восстановите пароль и сообщите в ДИТ.').catch(() => undefined);
      }
      return { ok: true };
    });

    /** Приглашение сотруднику: ссылка на первый пароль (ДИТ). */
    router.post('/api/v1/users/:id/invite', async (ctx) => {
      helpers.guardOrigin(ctx);
      const actor = await helpers.actor(ctx);
      if (!actor.roles.includes('admin')) throw ApiError.forbidden();
      const user = await db.one<{ id: string; email: string; full_name: string; is_active: boolean }>(
        'SELECT id, email, full_name, is_active FROM users WHERE id = $1', [ctx.params.id]);
      if (!user) throw ApiError.notFound('Пользователь не найден');
      if (!user.is_active) throw ApiError.conflict('Учётная запись отключена — сначала включите её');
      await sendLink(user, 'invite', ctx);
      await repo.logEvent(db, { ...helpers.audit(ctx, actor), action: 'Отправлено приглашение в систему', entity: 'user', entityId: user.id, detail: user.email });
      return { ok: true, sentTo: mask(user.email) };
    });
  }

  return { register, deliverForTests: deliver };
}
