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
import { addWorkingDays, today } from '../domain/calendar.ts';
import { toIsoDate } from '../domain/dates.ts';
import type { WorkCalendar } from '../domain/types.ts';
import { stage } from './stages.ts';
import { nextEscalationLevel } from './engine.ts';
import { offerServices, paidAtFor } from './transitions.ts';

export type JobResult = { job: string; regulationRef: string; affected: number; details?: string[] };

/** Дата из PostgreSQL — см. src/domain/dates.ts о сдвиге часового пояса. */
const isoDate = (value: unknown): string => toIsoDate(value) ?? '';

/** Адресаты эскалации по филиалу (п. 100, Приложение 7). */
type BranchContacts = {
  curator_email: string | null;
  director_email: string | null;
  board_email: string | null;
  curator_id: string | null;
  director_id: string | null;
  board_id: string | null;
};

const BRANCH_CONTACTS = `
  cu.email AS curator_email, di.email AS director_email, bo.email AS board_email,
  b.curator_id, b.director_id, b.board_curator_id AS board_id`;
const BRANCH_JOINS = `
  LEFT JOIN users cu ON cu.id = b.curator_id
  LEFT JOIN users di ON di.id = b.director_id
  LEFT JOIN users bo ON bo.id = b.board_curator_id`;

/**
 * Эскалация (п. 100) — только по срокам, за которые отвечает филиал:
 * этапы с ответственной стороной «филиал» и служебные записки в филиал (п. 10).
 *
 * Уровень 1 — в день выявления нарушения: курирующему заместителю директора
 * филиала с копией директору филиала. Уровень 2 — если нарушение не устранено
 * в течение 2 рабочих дней с даты уведомления первого уровня: курирующему
 * члену Правления. Просрочки Заказчика, ОР ПСД и бухгалтерии сюда не попадают —
 * их показывает разбивка просрочек по ответственной стороне.
 */
export async function runEscalations(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const now = today();
  const details: string[] = [];
  let affected = 0;

  const stages = await db.query<BranchContacts & {
    id: string; request_id: string; stage_code: string; due_at: string; escalation_level: number;
    number: string; level1_at: string | null;
  }>(
    `SELECT s.id, s.request_id, s.stage_code, s.due_at, s.escalation_level, r.number,
            (SELECT min(e.created_at)::date FROM escalations e
              WHERE e.request_stage_id = s.id AND e.level = 1) AS level1_at,
            ${BRANCH_CONTACTS}
       FROM request_stages s
       JOIN requests r ON r.id = s.request_id
       JOIN branches b ON b.id = r.branch_id
       ${BRANCH_JOINS}
      WHERE s.left_at IS NULL AND s.owner_party = 'branch'
        AND s.due_at IS NOT NULL AND s.due_at < current_date AND s.escalation_level < 2`);

  for (const row of stages) {
    const level = nextEscalationLevel({
      dueAt: isoDate(row.due_at), closed: false, branchDeadline: true,
      level: row.escalation_level, level1At: row.level1_at ? isoDate(row.level1_at) : null,
    }, now, calendar);
    if (level === 0) continue;
    const name = stage(row.stage_code as never).name;
    const reason = level === 1
      ? `Филиал нарушил срок этапа «${name}» по заявке ${row.number} (срок ${isoDate(row.due_at)})`
      : `Нарушение срока этапа «${name}» по заявке ${row.number} не устранено в течение 2 рабочих дней`;
    await db.tx(async (t) => {
      await t.query('UPDATE request_stages SET escalation_level = $2 WHERE id = $1', [row.id, level]);
      await escalate(t, { requestId: row.request_id, stageRecordId: row.id, memoId: null, level, reason, number: row.number, contacts: row });
    });
    affected++;
    details.push(`${row.number}: этап «${name}», уровень ${level}`);
  }

  const memos = await db.query<BranchContacts & {
    id: string; request_id: string; due_at: string; escalation_level: number; number: string;
    subject: string; level1_at: string | null;
  }>(
    `SELECT m.id, m.request_id, m.due_at, m.escalation_level, r.number, m.subject,
            (SELECT min(e.created_at)::date FROM escalations e
              WHERE e.memo_id = m.id AND e.level = 1) AS level1_at,
            ${BRANCH_CONTACTS}
       FROM memos m
       JOIN requests r ON r.id = m.request_id
       JOIN branches b ON b.id = m.branch_id
       ${BRANCH_JOINS}
      WHERE m.answered_at IS NULL AND m.due_at < current_date AND m.escalation_level < 2`);

  for (const row of memos) {
    const level = nextEscalationLevel({
      dueAt: isoDate(row.due_at), closed: false, branchDeadline: true,
      level: row.escalation_level, level1At: row.level1_at ? isoDate(row.level1_at) : null,
    }, now, calendar);
    if (level === 0) continue;
    const reason = level === 1
      ? `Филиал не ответил на служебную записку по заявке ${row.number} в срок 3 рабочих дней (до ${isoDate(row.due_at)})`
      : `Ответ филиала на служебную записку по заявке ${row.number} не получен в течение 2 рабочих дней после эскалации`;
    await db.tx(async (t) => {
      await t.query('UPDATE memos SET escalation_level = $2 WHERE id = $1', [row.id, level]);
      await escalate(t, { requestId: row.request_id, stageRecordId: null, memoId: row.id, level, reason, number: row.number, contacts: row });
    });
    affected++;
    details.push(`${row.number}: служебная записка, уровень ${level}`);
  }

  return { job: 'Эскалация нарушенных филиалом сроков', regulationRef: 'пп. 10, 100', affected, details };
}

/** Запись эскалации, уведомления адресатам по п. 100 и строка журнала. */
async function escalate(
  t: Db,
  e: {
    requestId: string; stageRecordId: string | null; memoId: string | null; level: 1 | 2;
    reason: string; number: string; contacts: BranchContacts;
  },
): Promise<void> {
  const c = e.contacts;
  const to = e.level === 1
    ? { id: c.curator_id, email: c.curator_email, role: 'курирующему заместителю директора филиала' }
    : { id: c.board_id, email: c.board_email, role: 'курирующему члену Правления' };
  const copy = e.level === 1 ? { id: c.director_id, email: c.director_email } : null;

  await t.query(
    `INSERT INTO escalations (request_id, request_stage_id, memo_id, level, notified_user_id, copy_user_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.requestId, e.stageRecordId, e.memoId, e.level, to.id, copy?.id ?? null, e.reason]);

  const body = `${e.reason}.\n\nОснование: пункт 100 Регламента ОРПСД-Р-01. ` +
    (e.level === 1
      ? 'Первый уровень эскалации: уведомление курирующему заместителю директора филиала с копией директору филиала.'
      : 'Второй уровень эскалации: нарушение не устранено в течение 2 рабочих дней с даты уведомления первого уровня.');
  await enqueue(t, {
    eventKey: `escalation_level_${e.level}`,
    recipient: to.email ?? '',
    subject: `Эскалация ${e.level}-го уровня: заявка ${e.number}`,
    body,
    payload: { requestId: e.requestId, level: e.level },
  });
  if (copy) {
    await enqueue(t, {
      eventKey: 'escalation_level_1_copy',
      recipient: copy.email ?? '',
      subject: `Копия: эскалация 1-го уровня, заявка ${e.number}`,
      body,
      payload: { requestId: e.requestId, level: 1 },
    });
  }
  await repo.logEvent(t, {
    actorName: 'Система', action: `Эскалация ${e.level}-го уровня`, entity: 'request',
    entityId: e.requestId,
    detail: `${e.reason}. Адресат: ${to.role}${to.email ? ` (${to.email})` : ' — не назначен в справочнике филиала'}` +
      (copy ? `; копия директору филиала${copy.email ? ` (${copy.email})` : ' — не назначен'}` : ''),
    regulationRef: 'п. 100',
  });
}

/**
 * Закрытие по истечении срока оферты (табл. 1): оплата не поступила
 * в течение 10 рабочих дней — заявка закрывается с письменным уведомлением.
 */
export async function runOfferExpiry(db: Db, _calendar?: WorkCalendar): Promise<JobResult> {
  const candidates = await db.query<{
    id: string; number: string; due_at: string; email: string | null;
  }>(
    `SELECT r.id, r.number, s.due_at, cp.email
       FROM requests r
       JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'awaiting_payment' AND s.due_at < current_date`);

  // Оплата проверяется по договорам текущего цикла: во втором цикле (СМР после
  // ПСД) оплаченный договор на ПСД не продлевает оферту по СМР.
  const rows: typeof candidates = [];
  for (const row of candidates) {
    const snapshot = await repo.getRequest(db, row.id);
    if (!snapshot) continue;
    if (offerServices(snapshot).some((s) => paidAtFor(snapshot, s))) continue;
    rows.push(row);
  }

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
 * мотивированные замечания в течение 10 рабочих дней **с даты получения АВР**,
 * работы считаются принятыми в полном объёме. Срок считается от даты
 * направления АВР и ЭСФ (пп. 91–92); замечания к форме заявки здесь не
 * учитываются — только мотивированные замечания к АВР.
 */
export async function runAvrSilence(db: Db, calendar?: WorkCalendar): Promise<JobResult> {
  const cal = calendar ?? await repo.calendar(db);
  const candidates = await db.query<{ id: string; number: string; email: string | null; avr_sent_at: string }>(
    `SELECT r.id, r.number, cp.email, r.avr_sent_at
       FROM requests r
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'closing' AND r.avr_sent_at IS NOT NULL
        AND r.avr_objection IS NULL AND NOT r.closing_confirmed`);
  const now = today();
  const rows = candidates.filter((row) => addWorkingDays(isoDate(row.avr_sent_at), 10, cal) < now);

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
          '10 рабочих дней с даты его получения. Работы считаются принятыми в полном объёме ' +
          'без замечаний (пункт 94 Регламента ОРПСД-Р-01).',
      });
      await repo.logEvent(t, {
        actorName: 'Система', action: 'Работы приняты без замечаний по истечении срока',
        entity: 'request', entityId: row.id,
        detail: `${row.number}; АВР направлен ${isoDate(row.avr_sent_at)}`, regulationRef: 'пп. 94–95',
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

/** Полный проход по заданиям. */
export async function runAllJobs(db: Db): Promise<JobResult[]> {
  const calendar = await repo.calendar(db);
  return [
    await runEscalations(db, calendar),
    await runOfferExpiry(db, calendar),
    await runAvrSilence(db, calendar),
    await runEquipmentReminders(db),
    await runDocumentExpiry(db),
  ];
}
