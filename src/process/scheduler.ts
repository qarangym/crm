/**
 * Фоновые задания: то, что Регламент требует делать по времени, а не по
 * действию пользователя.
 *
 * Каждое задание соответствует правилу автоматизации (src/process/rules.ts)
 * и несёт ссылку на пункт. Задания идемпотентны: повторный запуск не создаёт
 * дубликатов — уже отправленная эскалация не отправляется заново, уже закрытая
 * заявка не закрывается повторно.
 *
 * Запуск: внутри приложения по интервалу либо отдельной командой `npm run jobs`.
 */

import type { Db } from '../db/client.ts';
import { enqueue } from '../server/notifications.ts';
import * as repo from '../db/repo.ts';
import * as docs from '../db/documents.ts';
import { today, workingDaysBetween } from '../domain/calendar.ts';
import { toIsoDate } from '../domain/dates.ts';
import type { WorkCalendar } from '../domain/types.ts';
import { stage } from './stages.ts';

export type JobResult = { job: string; regulationRef: string; affected: number; details?: string[] };

/** Дата из PostgreSQL — см. src/domain/dates.ts о сдвиге часового пояса. */
const isoDate = (value: unknown): string => toIsoDate(value) ?? '';

/**
 * Эскалация (п. 100): первый уровень — в день выявления нарушения срока,
 * второй — если нарушение не устранено в течение 2 рабочих дней.
 */
export async function runEscalations(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const now = today();
  const rows = await db.query<{
    id: string; request_id: string; stage_code: string; due_at: string;
    escalation_level: number; number: string; branch_id: string;
    curator_email: string | null; director_email: string | null;
  }>(
    `SELECT s.id, s.request_id, s.stage_code, s.due_at, s.escalation_level,
            r.number, r.branch_id,
            cu.email AS curator_email, di.email AS director_email
       FROM request_stages s
       JOIN requests r ON r.id = s.request_id
       JOIN branches b ON b.id = r.branch_id
       LEFT JOIN users cu ON cu.id = b.curator_id
       LEFT JOIN users di ON di.id = b.director_id
      WHERE s.left_at IS NULL AND s.due_at IS NOT NULL AND s.due_at < current_date
        AND s.escalation_level < 2`);

  const details: string[] = [];
  let affected = 0;

  for (const row of rows) {
    const overdue = workingDaysBetween(isoDate(row.due_at), now, calendar);
    const level = overdue >= 2 ? 2 : 1;
    if (level <= row.escalation_level) continue;

    await db.tx(async (t) => {
      await t.query('UPDATE request_stages SET escalation_level = $2 WHERE id = $1', [row.id, level]);
      const reason = level === 1
        ? `Нарушен срок этапа «${stage(row.stage_code as never).name}» по заявке ${row.number}`
        : `Нарушение срока по заявке ${row.number} не устранено в течение 2 рабочих дней`;
      await t.query(
        `INSERT INTO escalations (request_id, request_stage_id, level, reason) VALUES ($1,$2,$3,$4)`,
        [row.request_id, row.id, level, reason]);

      const to = level === 1 ? row.curator_email : row.director_email;
      await enqueue(t, {
        eventKey: `escalation_level_${level}`,
        recipient: to ?? '',
        subject: `Эскалация ${level}-го уровня: заявка ${row.number}`,
        body: `${reason}.\n\nОснование: пункт 100 Регламента ОРПСД-Р-01.\n` +
          `Просрочка: ${overdue} рабочих дн.`,
      });
      await repo.logEvent(t, {
        actorName: 'Система', action: `Эскалация ${level}-го уровня`, entity: 'request',
        entityId: row.request_id, detail: reason, regulationRef: 'п. 100',
      });
    });
    affected++;
    details.push(`${row.number}: уровень ${level}`);
  }
  return { job: 'Эскалация нарушенных сроков', regulationRef: 'п. 100', affected, details };
}

/**
 * Закрытие по истечении срока оферты (табл. 1): оплата не поступила
 * в течение 10 рабочих дней — заявка закрывается с письменным уведомлением.
 */
export async function runOfferExpiry(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const rows = await db.query<{
    id: string; number: string; due_at: string; email: string | null;
  }>(
    `SELECT r.id, r.number, s.due_at, cp.email
       FROM requests r
       JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'awaiting_payment' AND s.due_at < current_date
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.request_id = r.id AND c.paid_at IS NOT NULL)`);

  const details: string[] = [];
  for (const row of rows) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE requests SET stage_code = 'closed_expired', customer_status = 'rejected',
                closed_at = now(), closed_reason = $2, version = version + 1, updated_at = now()
          WHERE id = $1 AND stage_code = 'awaiting_payment'`,
        [row.id, 'Оплата не поступила в течение срока оферты (10 рабочих дней)']);
      await t.query(
        `UPDATE request_stages SET left_at = now(), breached = true
          WHERE request_id = $1 AND left_at IS NULL`, [row.id]);
      await enqueue(t, {
        eventKey: 'offer_expired',
        recipient: row.email ?? '',
        subject: `Заявка ${row.number} закрыта: истёк срок оферты`,
        body: 'Оплата по выставленному счёту не поступила в течение 10 рабочих дней. ' +
          'Заявка закрыта (таблица 1 Регламента ОРПСД-Р-01). Для возобновления подайте новую заявку.',
      });
      await repo.logEvent(t, {
        actorName: 'Система', action: 'Заявка закрыта по истечении срока оферты',
        entity: 'request', entityId: row.id, detail: row.number, regulationRef: 'табл. 1',
      });
    });
    details.push(row.number);
  }
  return { job: 'Закрытие по истечении оферты', regulationRef: 'табл. 1, п. 88', affected: rows.length, details };
}

/**
 * Приёмка по молчанию (п. 94): если Заказчик не подтвердил АВР и не направил
 * мотивированные замечания в течение 10 рабочих дней, работы считаются
 * принятыми в полном объёме.
 */
export async function runAvrSilence(db: Db): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; email: string | null }>(
    `SELECT r.id, r.number, cp.email
       FROM requests r
       JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'closing' AND s.due_at < current_date
        AND NOT EXISTS (SELECT 1 FROM request_remarks m WHERE m.request_id = r.id AND m.resolved_at IS NULL)`);

  for (const row of rows) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE requests SET stage_code = 'closed_done', customer_status = 'done',
                closing_confirmed = true, closed_at = now(), closed_reason = $2,
                version = version + 1, updated_at = now()
          WHERE id = $1 AND stage_code = 'closing'`,
        [row.id, 'Работы приняты без замечаний по истечении 10 рабочих дней (п. 94)']);
      await t.query(
        `UPDATE request_stages SET left_at = now() WHERE request_id = $1 AND left_at IS NULL`, [row.id]);
      await enqueue(t, {
        eventKey: 'avr_accepted_by_silence',
        recipient: row.email ?? '',
        subject: `Заявка ${row.number}: работы приняты`,
        body: 'Мотивированные замечания по акту выполненных работ не поступили в течение ' +
          '10 рабочих дней. Работы считаются принятыми в полном объёме без замечаний ' +
          '(пункт 94 Регламента ОРПСД-Р-01).',
      });
      await repo.logEvent(t, {
        actorName: 'Система', action: 'Работы приняты без замечаний по истечении срока',
        entity: 'request', entityId: row.id, detail: row.number, regulationRef: 'пп. 94–95',
      });
    });
  }
  return { job: 'Приёмка по молчанию Заказчика', regulationRef: 'пп. 94–95', affected: rows.length };
}

/**
 * Напоминание о предоставлении оборудования (п. 56): за 10 календарных дней
 * до истечения срока направляется уведомление-напоминание Заказчику.
 */
export async function runEquipmentReminders(db: Db): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; email: string | null; due_at: string }>(
    `SELECT r.id, r.number, cp.email, s.due_at
       FROM requests r
       JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'smr_prep'
        AND s.due_at BETWEEN current_date AND current_date + interval '10 days'
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.event_key = 'equipment_reminder' AND n.payload->>'requestId' = r.id::text)`);

  for (const row of rows) {
    await enqueue(db, {
      eventKey: 'equipment_reminder',
      recipient: row.email ?? '',
      subject: `Заявка ${row.number}: срок предоставления оборудования истекает`,
      body: `Оборудование и материалы предоставляются в срок не более 90 календарных дней ` +
        `(пункт 55 Регламента). Контрольная дата: ${isoDate(row.due_at)}.\n` +
        'При непредоставлении в срок направляется претензия (пункт 57).',
      payload: { requestId: row.id },
    });
  }
  return { job: 'Напоминание о предоставлении оборудования', regulationRef: 'пп. 55–57', affected: rows.length };
}

/**
 * Истечение сроков действия документов: ТУ — 6 месяцев (п. 31),
 * рабочий проект — 36 месяцев, условия установки — 3 месяца (п. 47).
 */
export async function runDocumentExpiry(db: Db, withinDays = 30): Promise<JobResult> {
  const rows = await docs.expiringDocuments(db, withinDays) as unknown as {
    id: string; kind: string; number: string; valid_until: string; owner_email: string | null;
  }[];

  for (const row of rows) {
    const already = await db.one(
      `SELECT id FROM notifications WHERE event_key = 'document_expiring' AND payload->>'documentId' = $1`,
      [row.id]);
    if (already) continue;
    await enqueue(db, {
      eventKey: 'document_expiring',
      recipient: row.owner_email ?? '',
      subject: `Истекает срок действия: ${row.kind} ${row.number}`,
      body: `Срок действия документа истекает ${isoDate(row.valid_until)}.\n` +
        'Технические условия действуют не более 6 месяцев (пункт 31), рабочий проект — ' +
        '36 месяцев; условия установки актуальны 3 месяца с даты получения ПСД (пункт 47).',
      payload: { documentId: row.id },
    });
  }
  return { job: 'Истечение сроков действия документов', regulationRef: 'пп. 31, 47', affected: rows.length };
}

/** Просроченные служебные записки в филиал (п. 10 — ответ не позднее 3 рабочих дней). */
export async function runMemoReminders(db: Db): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; email: string | null; due_at: string }>(
    `SELECT m.id, r.number, u.email, m.due_at
       FROM memos m
       JOIN requests r ON r.id = m.request_id
       LEFT JOIN users u ON u.id = m.addressee_id
      WHERE m.answered_at IS NULL AND m.due_at < current_date
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.event_key = 'memo_overdue' AND n.payload->>'memoId' = m.id::text)`);

  for (const row of rows) {
    await enqueue(db, {
      eventKey: 'memo_overdue',
      recipient: row.email ?? '',
      subject: `Просрочен ответ на служебную записку по заявке ${row.number}`,
      body: 'Филиал обязан рассмотреть запрос и предоставить ответ в срок не позднее ' +
        '3 рабочих дней с даты получения (пункт 10 Регламента ОРПСД-Р-01).',
      payload: { memoId: row.id },
    });
  }
  return { job: 'Напоминание по служебным запискам', regulationRef: 'п. 10', affected: rows.length };
}

/** Полный проход по заданиям. */
export async function runAllJobs(db: Db): Promise<JobResult[]> {
  const calendar = await repo.calendar(db);
  return [
    await runEscalations(db, calendar),
    await runOfferExpiry(db, calendar),
    await runAvrSilence(db),
    await runEquipmentReminders(db),
    await runDocumentExpiry(db),
    await runMemoReminders(db),
  ];
}
