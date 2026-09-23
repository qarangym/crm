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

export type NotificationChannel = 'email' | 'in_app';

export type NewNotification = {
  eventKey: string;
  recipient: string;
  subject: string;
  body: string;
  channel?: NotificationChannel;
  payload?: Record<string, unknown>;
};

/** Постановка в очередь. Вызывается в той же транзакции, что и действие. */
export async function enqueue(db: Db, message: NewNotification): Promise<void> {
  if (!message.recipient?.trim()) return;
  await db.query(
    `INSERT INTO notifications (event_key, channel, recipient, subject, payload)
     VALUES ($1,$2,$3,$4,$5)`,
    [message.eventKey, message.channel ?? 'email', message.recipient.trim(),
     message.subject.slice(0, 255),
     JSON.stringify({ body: message.body, ...(message.payload ?? {}) })],
  );
}

export type MailConfig = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
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
  db: Db, mailer: Mailer | null, limit = 50,
): Promise<{ sent: number; failed: number; skipped: number }> {
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
      await mailer.send(row.recipient, row.subject, String(row.payload?.body ?? ''));
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
