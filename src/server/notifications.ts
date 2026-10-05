/**
 * Уведомления.
 *
 * Сообщения кладутся в таблицу `notifications` и отправляются фоновым
 * обработчиком. Очередь, а не прямая отправка: сбой почтового сервера не
 * должен срывать регистрацию заявки или переход по этапу, а неотправленное
 * сообщение должно быть видно и повторяемо.
 *
 * ТЗ №9 — уведомление Заказчику о принятии заявки с регистрационным номером.
 * Регламент — уведомления по эскалации (п. 100), напоминания по оплате (п. 88)
 * и по предоставлению оборудования (п. 56).
 */

import nodemailer from 'nodemailer';
import type { Db } from '../db/client.ts';
import { applyTemplate } from './templates.ts';

export type NotificationChannel = 'email' | 'in_app';

export type NewNotification = {
  eventKey: string;
  recipient: string;
  subject: string;
  body: string;
  channel?: NotificationChannel;
  payload?: Record<string, unknown>;
};

/**
 * Постановка в очередь. Вызывается в той же транзакции, что и действие.
 *
 * Письмо пользователю системы дублируется в «колокольчик» (таблица inbox). Если
 * получатель сегодня отсутствует и назначил замещающего (А3), письмо и отметка
 * в системе уходят и замещающему: задача не ждёт возвращения из отпуска.
 */
export async function enqueue(db: Db, original: NewNotification): Promise<void> {
  if (!original.recipient?.trim()) return;
  const recipient = original.recipient.trim();
  // Текст письма из справочника (А5), если ОР ПСД или СУА его настроили.
  const text = await applyTemplate(db, original.eventKey, original.subject, original.body, original.payload);
  // Ссылка в карточку: из письма и «колокольчика» человек попадает сразу в свою задачу.
  const link = await linkFor(db, original, text.subject);
  const message = {
    ...original, subject: humanDates(text.subject), body: humanDates(text.body),
    payload: link ? { ...(original.payload ?? {}), link } : original.payload,
  };
  await insert(db, message, recipient, message.subject);
  if ((message.channel ?? 'email') !== 'email') return;
  const user = await db.one<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM users WHERE lower(email) = lower($1) AND is_active`, [recipient]);
  if (!user) return;
  await toInbox(db, user.id, message, message.subject, link);
  const substitutes = await db.query<{ id: string; email: string }>(
    `SELECT u.id, u.email FROM user_absences a JOIN users u ON u.id = a.substitute_id
      WHERE a.user_id = $1 AND current_date BETWEEN a.date_from AND a.date_to AND u.is_active`, [user.id]);
  for (const s of substitutes) {
    if (s.email.toLowerCase() === recipient.toLowerCase()) continue;
    const subject = `[за ${user.full_name}] ${message.subject}`;
    await insert(db, { ...message, payload: { ...(message.payload ?? {}), onBehalfOf: user.id } }, s.email, subject);
    await toInbox(db, s.id, message, subject, link);
  }
}

/**
 * Куда ведёт уведомление. Явная ссылка (допуски) — как есть; заявка ОР ПСД — по requestId или по номеру
 * в теме; регистрация организации — экран «Пользователи».
 */
async function linkFor(db: Db, m: NewNotification, subject: string): Promise<string | null> {
  const p = m.payload ?? {};
  if (typeof p.link === 'string') return p.link;
  if (typeof p.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(p.requestId)) {
    const r = await db.one<{ number: string }>('SELECT number FROM requests WHERE id = $1', [p.requestId]);
    if (r) return `/#${r.number}`;
  }
  const number = /ЗК-\d{4}-\d{4}/.exec(`${subject} ${m.body}`)?.[0];
  if (number) return `/#${number}`;
  if (m.eventKey === 'registration_pending') return '/#/users';
  return null;
}

/** Даты в письмах — как пишут люди: 05.10.2026, а не 2026-10-05. */
export function humanDates(text: string): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3.$2.$1');
}

async function insert(db: Db, message: NewNotification, recipient: string, subject: string): Promise<void> {
  await db.query(
    `INSERT INTO notifications (event_key, channel, recipient, subject, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [message.eventKey, message.channel ?? 'email', recipient, subject.slice(0, 255),
     JSON.stringify({ body: message.body, ...(message.payload ?? {}) })],
  );
}

async function toInbox(db: Db, userId: string, message: NewNotification, subject: string, link: string | null): Promise<void> {
  await db.query(
    `INSERT INTO inbox (user_id, event_key, subject, body, link) VALUES ($1,$2,$3,$4,$5)`,
    [userId, message.eventKey, subject.slice(0, 255), message.body.slice(0, 8000), link?.slice(0, 255) ?? null]);
}

export type MailConfig = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  /**
   * Не включать STARTTLS, даже если сервер его предлагает — как Django при
   * EMAIL_USE_TLS=False. Нужно для локального почтового сервера (localhost:25)
   * с самоподписанным сертификатом; для сервера в сети не включайте.
   */
  ignoreTls: boolean;
  from: string;
};

export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
  return {
    enabled: env.SMTP_ENABLED === 'true',
    host: env.SMTP_HOST ?? 'localhost',
    port: Number(env.SMTP_PORT ?? 25),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || undefined,
    password: env.SMTP_PASSWORD || undefined,
    ignoreTls: env.SMTP_IGNORE_TLS === 'true',
    from: env.SMTP_FROM ?? 'CRM ОР ПСД <no-reply@localhost>',
  };
}

export type Mailer = {
  send(to: string, subject: string, text: string): Promise<void>;
};

export function createMailer(config: MailConfig): Mailer | null {
  if (!config.enabled) return null;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ignoreTLS: !config.secure && config.ignoreTls,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
  });
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from: config.from, to, subject, text });
    },
  };
}

/** Максимум попыток отправки: дальше сообщение помечается сбойным и видно администратору. */
const MAX_ATTEMPTS = 5;

/**
 * Обработка очереди. Возвращает счётчики, чтобы вызывающий мог записать их
 * в журнал и проследить, что почта действительно уходит.
 */
export async function processQueue(
  db: Db, mailer: Mailer | null, limit = 50, appOrigin: string = process.env.APP_ORIGIN ?? '',
): Promise<{ sent: number; failed: number; skipped: number }> {
  // Адрес системы для ссылки в конце письма: «Открыть в системе: https://…/#ЗК-2026-0001».
  const origin = appOrigin.replace(/\/+$/, '');
  const rows = await db.query<{ id: string; recipient: string; subject: string; payload: any; attempts: number }>(
    `SELECT id, recipient, subject, payload, attempts FROM notifications
      WHERE status = 'queued' AND channel = 'email' AND attempts < $2
      ORDER BY created_at LIMIT $1`, [limit, MAX_ATTEMPTS]);

  let sent = 0, failed = 0;
  for (const row of rows) {
    if (!mailer) {
      // Отправка не настроена: сообщения остаются в очереди, ничего не теряется.
      return { sent: 0, failed: 0, skipped: rows.length };
    }
    try {
      const link = typeof row.payload?.link === 'string' ? row.payload.link : '';
      const body = String(row.payload?.body ?? '') + (origin && link ? `\n\nОткрыть в системе: ${origin}${link}` : '');
      await mailer.send(row.recipient, row.subject, body);
      await db.query(
        `UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL
          WHERE id = $1`, [row.id]);
      sent++;
    } catch (error) {
      // Статус вычисляется в коде: повторное использование одного параметра
      // и как значения колонки, и в сравнении не даёт PostgreSQL вывести тип.
      const attempts = row.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
      await db.query(
        `UPDATE notifications SET attempts = $2, error = $3, status = $4 WHERE id = $1`,
        [row.id, attempts, (error as Error).message.slice(0, 500), status]);
      failed++;
    }
  }
  return { sent, failed, skipped: 0 };
}

/** Непрочитанные сообщения в интерфейсе — для получателей внутри системы. */
export function inAppFor(db: Db, recipient: string, limit = 50) {
  return db.query(
    `SELECT id, event_key, subject, payload, created_at FROM notifications
      WHERE channel = 'in_app' AND recipient = $1 AND status = 'queued'
      ORDER BY created_at DESC LIMIT $2`, [recipient, limit]);
}
