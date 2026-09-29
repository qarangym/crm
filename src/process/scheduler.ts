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
import { roleRecipients, ruleEnabled } from '../server/notify.ts';
import { announce } from '../server/executors.ts';
import * as executors from '../db/executors.ts';
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

/**
 * Адресаты эскалации по филиалу (п. 100, Приложение 7) и исполнитель заявки
 * в ОР ПСД — ему уходит эскалация, если адресат в справочнике филиала не назначен.
 */
type BranchContacts = {
  curator_email: string | null;
  director_email: string | null;
  board_email: string | null;
  curator_id: string | null;
  director_id: string | null;
  board_id: string | null;
  assignee_email: string | null;
};

const BRANCH_CONTACTS = `
  cu.email AS curator_email, di.email AS director_email, bo.email AS board_email,
  b.curator_id, b.director_id, b.board_curator_id AS board_id, ex.email AS assignee_email`;
const BRANCH_JOINS = `
  LEFT JOIN users cu ON cu.id = b.curator_id
  LEFT JOIN users di ON di.id = b.director_id
  LEFT JOIN users bo ON bo.id = b.board_curator_id
  LEFT JOIN users ex ON ex.id = r.assignee_id AND ex.is_active`;

/**
 * Эскалация (п. 100) — только по срокам, за которые отвечает филиал:
 * этапы с ответственной стороной «филиал» и служебные записки в филиал (п. 10).
 *
 * Уровень 1 — в день выявления нарушения: курирующему заместителю директора
 * филиала с копией директору филиала. Уровень 2 — если нарушение не устранено
 * в течение 2 рабочих дней с даты уведомления первого уровня: курирующему
 * члену Правления. Просрочки Заказчика, ОР ПСД и бухгалтерии сюда не попадают —
 * их показывает разбивка просрочек по ответственной стороне.
 *
 * Пока Приложение 7 заполнено не полностью (список РТС с ответственными лицами
 * утверждает СУА), письмо без адресата уходит исполнителю заявки в ОР ПСД, а если
 * исполнитель не назначен — всем сотрудникам ОР ПСД: эскалацию по п. 100
 * осуществляет ОР ПСД, и нарушение не должно остаться незамеченным.
 * Выключенное правило 12 писем не рассылает; эскалация и запись в журнале остаются.
 */
export async function runEscalations(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const now = today();
  const details: string[] = [];
  let affected = 0;
  const mail = await ruleEnabled(db, 12);

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
      WHERE s.left_at IS NULL AND s.owner_party = 'branch' AND s.paused_at IS NULL
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
      await escalate(t, { requestId: row.request_id, stageRecordId: row.id, memoId: null, level, reason, number: row.number, contacts: row, mail });
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
      await escalate(t, { requestId: row.request_id, stageRecordId: null, memoId: row.id, level, reason, number: row.number, contacts: row, mail });
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
    reason: string; number: string; contacts: BranchContacts; mail: boolean;
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
  // Кого нет в справочнике филиала (Приложение 7): им письмо не уходит, эскалацию передаёт ОР ПСД.
  const missing = [
    ...(to.email ? [] : [to.role]),
    ...(copy && !copy.email ? ['директору филиала (копия)'] : []),
  ];
  const fallback = !missing.length ? []
    : c.assignee_email ? [c.assignee_email] : await roleRecipients(t, ['orpsd']);
  if (e.mail) {
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
    for (const recipient of fallback) {
      await enqueue(t, {
        eventKey: `escalation_level_${e.level}_unassigned`,
        recipient,
        subject: `Эскалация ${e.level}-го уровня без адресата: заявка ${e.number}`,
        body: `${body}\n\nВ справочнике филиала (Приложение 7) не назначены: ${missing.join('; ')}. ` +
          'Письмо им не отправлено — передайте уведомление ответственным лицам филиала и заполните справочник ' +
          '(«Справочники» → «Филиалы»).',
        payload: { requestId: e.requestId, level: e.level },
      });
    }
  }
  await repo.logEvent(t, {
    actorName: 'Система', action: `Эскалация ${e.level}-го уровня`, entity: 'request',
    entityId: e.requestId,
    detail: `${e.reason}. Адресат: ${to.role}${to.email ? ` (${to.email})` : ' — не назначен в справочнике филиала'}` +
      (copy ? `; копия директору филиала${copy.email ? ` (${copy.email})` : ' — не назначен'}` : '') +
      (!e.mail ? '. Письма не отправлены: правило 12 выключено'
        : fallback.length ? `. Передано в ОР ПСД: ${fallback.join(', ')}` : ''),
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
 * Приёмка по молчанию (п. 94): если Заказчик не подписал АВР и не направил
 * мотивированные замечания в течение 10 рабочих дней **с даты получения АВР**,
 * работы считаются принятыми в полном объёме (п. 95).
 *
 * АВР оформляется по каждому договору (В6): договор принимается по своему
 * сроку, в том числе раньше окончания заявки — например, выданные ТУ, пока
 * разрабатывается ПСД. Заявка на этапе приёмки закрывается, когда приняты
 * все её договоры. Замечания к форме заявки здесь не учитываются — только
 * мотивированные замечания к АВР.
 */
export async function runAvrSilence(db: Db, calendar?: WorkCalendar): Promise<JobResult> {
  const cal = calendar ?? await repo.calendar(db);
  const now = today();
  const details: string[] = [];

  const due = (await db.query<{
    id: string; number: string; service: string; avr_sent_at: string; request_id: string; request_number: string;
    counterparty_id: string;
  }>(
    `SELECT c.id, c.number, c.service, c.avr_sent_at, c.request_id, r.number AS request_number, r.counterparty_id
       FROM contracts c JOIN requests r ON r.id = c.request_id
      WHERE c.status <> 'terminated' AND c.avr_sent_at IS NOT NULL AND c.accepted_at IS NULL
        AND c.avr_objection IS NULL AND r.avr_objection IS NULL AND r.closed_at IS NULL`))
    .filter((c) => addWorkingDays(isoDate(c.avr_sent_at), 10, cal) < now);

  for (const c of due) {
    await db.tx(async (t) => {
      await t.query(
        `UPDATE contracts SET accepted_at = $2, accepted_by_silence = true, status = 'executed'
          WHERE id = $1 AND accepted_at IS NULL`, [c.id, now]);
      await repo.logEvent(t, {
        actorName: 'Система', action: 'Работы по договору приняты без замечаний по истечении срока',
        entity: 'request', entityId: c.request_id,
        detail: `${c.service}: договор ${c.number}; АВР направлен ${isoDate(c.avr_sent_at)}`, regulationRef: 'пп. 94–95',
      });
    });
    details.push(`${c.request_number}: договор ${c.number}`);
  }

  // Заявки на этапе приёмки: закрываются, когда приняты все договоры. Заявка без
  // договоров (отметки делались по заявке целиком) — по дате направления АВР.
  const candidates = await db.query<{ id: string; number: string; email: string | null; avr_sent_at: string | null; contracts: number; open: number }>(
    `SELECT r.id, r.number, cp.email, r.avr_sent_at,
            (SELECT count(*)::int FROM contracts c WHERE c.request_id = r.id AND c.status <> 'terminated') AS contracts,
            (SELECT count(*)::int FROM contracts c WHERE c.request_id = r.id AND c.status <> 'terminated'
                AND c.accepted_at IS NULL) AS open
       FROM requests r
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'closing' AND r.avr_objection IS NULL AND NOT r.closing_confirmed`);
  const rows = candidates.filter((row) => row.contracts > 0
    ? row.open === 0
    : !!row.avr_sent_at && addWorkingDays(isoDate(row.avr_sent_at), 10, cal) < now);

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
      await t.query(
        `UPDATE assignments SET status = 'done', closed_at = now(), close_note = 'Заявка исполнена'
          WHERE request_id = $1 AND status IN ('open','in_progress')`, [row.id]);
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
        detail: row.number, regulationRef: 'пп. 94–95, 127',
      });
    });
    details.push(`${row.number}: заявка исполнена`);
  }
  return { job: 'Приёмка по молчанию Заказчика', regulationRef: 'пп. 94–95', affected: due.length + rows.length, details };
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

/**
 * Напоминание филиалам об ежемесячном отчёте (п. 105): с 1-го по 5-е число
 * куратор филиала, не подтвердивший отчёт за прошедший месяц, получает
 * напоминание — один раз за период.
 */
export async function runBranchReportReminders(db: Db, now: string = today()): Promise<JobResult> {
  const day = Number(now.slice(8, 10));
  const [y, m] = now.split('-').map(Number);
  const period = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  if (day > 5) return { job: 'Напоминание об отчёте филиала', regulationRef: 'п. 105', affected: 0 };

  const rows = await db.query<{ id: string; name: string; email: string | null }>(
    `SELECT b.id, b.name, cu.email
       FROM branches b LEFT JOIN users cu ON cu.id = b.curator_id
      WHERE b.is_active
        AND NOT EXISTS (SELECT 1 FROM branch_reports br WHERE br.branch_id = b.id AND br.period = $1)
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_key = 'branch_report_due'
                         AND n.payload->>'branchId' = b.id::text AND n.payload->>'period' = $1)`, [period]);
  let affected = 0;
  for (const row of rows) {
    if (!row.email) continue;
    await enqueue(db, {
      eventKey: 'branch_report_due', recipient: row.email,
      subject: `${row.name}: отчёт об исполнении договоров за ${period}`,
      body: `Подтвердите ежемесячный отчёт об исполненных и неисполненных договорах за ${period} ` +
        'не позднее 5-го числа текущего месяца (пункт 105 Регламента ОРПСД-Р-01). ' +
        'Отчёт сформирован системой в разделе «Отчёты».',
      payload: { branchId: row.id, period },
    });
    affected++;
  }
  return { job: 'Напоминание об отчёте филиала', regulationRef: 'п. 105', affected };
}

/** Письмо, которое уже отправлялось по этому поводу, повторно не ставится. */
async function alreadySent(db: Db, eventKey: string, key: string, value: string): Promise<boolean> {
  return !!await db.one(
    `SELECT 1 FROM notifications WHERE event_key = $1 AND payload->>$2 = $3 LIMIT 1`, [eventKey, key, value]);
}

async function orpsdFor(db: Db, requestId: string): Promise<string[]> {
  // Ответственный ОР ПСД по заявке, а если его нет — исполнитель поручения ОР ПСД.
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM requests q JOIN users u ON u.id = q.assignee_id
      WHERE q.id = $1 AND u.is_active
     UNION
     SELECT u.email FROM assignments a JOIN users u ON u.id = a.assignee_id
      WHERE a.request_id = $1 AND a.kind = 'control' AND u.is_active
        AND NOT EXISTS (SELECT 1 FROM requests q JOIN users x ON x.id = q.assignee_id WHERE q.id = $1 AND x.is_active)`,
    [requestId]);
  if (rows.length) return rows.map((r) => r.email);
  return (await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.is_active AND r.role = 'orpsd'`)).map((r) => r.email);
}

async function sendAll(db: Db, recipients: string[], message: { eventKey: string; subject: string; body: string; payload: Record<string, unknown> }) {
  for (const recipient of new Set(recipients)) await enqueue(db, { ...message, recipient });
}

/**
 * Контрольная точка ПСД (п. 34.1; правило 8): на третий рабочий день разработки
 * исходные данные должны быть проверены. Не отмечено — напоминание ОР ПСД.
 */
export async function runPsdControlPoints(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; entered_at: string }>(
    `SELECT r.id, r.number, s.entered_at::date::text AS entered_at
       FROM requests r JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL AND s.stage_code = 'psd'
      WHERE r.stage_code = 'psd'
        AND NOT EXISTS (SELECT 1 FROM request_checkpoints c WHERE c.request_id = r.id AND c.code = 'psd_input_checked')`);
  const now = today();
  let affected = 0;
  for (const row of rows) {
    if (addWorkingDays(isoDate(row.entered_at), 3, calendar) > now) continue;
    if (await alreadySent(db, 'psd_control_point', 'requestId', row.id)) continue;
    await sendAll(db, await orpsdFor(db, row.id), {
      eventKey: 'psd_control_point', subject: `Заявка ${row.number}: проверка исходных данных ПСД`,
      body: 'Третий рабочий день разработки ПСД: исходные данные должны быть проверены на полноту и корректность (п. 34.1). ' +
        'При неполноте — запрос в филиал служебной запиской с уведомлением курирующего заместителя директора.',
      payload: { requestId: row.id },
    });
    await repo.logEvent(db, { actorName: 'Система', action: 'Напоминание: контрольная точка ПСД', entity: 'request', entityId: row.id, detail: row.number, regulationRef: 'п. 34.1' });
    affected++;
  }
  return { job: 'Контрольная точка ПСД', regulationRef: 'п. 34.1', affected };
}

/** До срока ПСД 5 рабочих дней, результат не передан — предложить продление (п. 33; правило 9). */
export async function runPsdDeadlineNear(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; due_at: string; extended_by: number }>(
    `SELECT r.id, r.number, s.due_at::text AS due_at, s.extended_by
       FROM requests r JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL AND s.stage_code = 'psd'
      WHERE r.stage_code = 'psd' AND NOT r.result_delivered AND s.due_at >= current_date`);
  const now = today();
  let affected = 0;
  for (const row of rows) {
    if (addWorkingDays(now, 5, calendar) < isoDate(row.due_at)) continue;
    if (await alreadySent(db, 'psd_deadline_near', 'requestId', row.id)) continue;
    await sendAll(db, await orpsdFor(db, row.id), {
      eventKey: 'psd_deadline_near', subject: `Заявка ${row.number}: срок разработки ПСД — ${isoDate(row.due_at)}`,
      body: `До срока разработки ПСД осталось не более 5 рабочих дней. Если объём не будет закрыт, срок продлевается ` +
        `не более чем на 15 рабочих дней с письменным уведомлением Заказчика (п. 33). Уже продлено: ${row.extended_by} р.д.`,
      payload: { requestId: row.id },
    });
    affected++;
  }
  return { job: 'Предложение продлить ПСД', regulationRef: 'п. 33', affected };
}

/** Напоминание об оплате за 3 рабочих дня до истечения оферты (п. 88; правило 6). */
export async function runPaymentReminders(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; due_at: string; counterparty_id: string; email: string | null }>(
    `SELECT r.id, r.number, s.due_at::text AS due_at, r.counterparty_id, cp.email
       FROM requests r JOIN request_stages s ON s.request_id = r.id AND s.left_at IS NULL
       JOIN counterparties cp ON cp.id = r.counterparty_id
      WHERE r.stage_code = 'awaiting_payment' AND s.due_at >= current_date`);
  const now = today();
  let affected = 0;
  for (const row of rows) {
    if (addWorkingDays(now, 3, calendar) < isoDate(row.due_at)) continue;
    const snapshot = await repo.getRequest(db, row.id);
    if (!snapshot || offerServices(snapshot).some((s) => paidAtFor(snapshot, s))) continue;
    if (await alreadySent(db, 'payment_reminder', 'requestId', row.id)) continue;
    const users = await db.query<{ email: string }>(
      `SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.counterparty_id = $1 AND u.is_active AND ur.role = 'customer'`, [row.counterparty_id]);
    await sendAll(db, [row.email ?? '', ...users.map((u) => u.email)].filter(Boolean), {
      eventKey: 'payment_reminder', subject: `Заявка ${row.number}: напоминание об оплате`,
      body: `Оплата по выставленному счёту не поступила. Срок оферты истекает ${isoDate(row.due_at)}; ` +
        'после этого заявка закрывается (таблица 1, пункт 88 Регламента ОРПСД-Р-01). ' +
        'Если оплата уже произведена, сообщите реквизиты платёжного документа.',
      payload: { requestId: row.id },
    });
    affected++;
  }
  return { job: 'Напоминание об оплате', regulationRef: 'п. 88', affected };
}

/**
 * Актуальность условий ПСД (п. 47; правило 18): условия установки актуальны
 * 3 месяца с получения утверждённой ПСД. Если за это время договор на СМР не
 * оплачен, перед СМР требуется повторная оценка технической возможности.
 */
export async function runPsdConditionsExpiry(db: Db): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; psd_done: string; counterparty_id: string }>(
    `SELECT r.id, r.number, max(s.left_at)::date::text AS psd_done, r.counterparty_id
       FROM requests r JOIN request_stages s ON s.request_id = r.id AND s.stage_code = 'psd' AND s.left_at IS NOT NULL
      WHERE r.closed_at IS NULL AND r.tv_recheck_required_at IS NULL
        AND EXISTS (SELECT 1 FROM request_services x WHERE x.request_id = r.id AND x.service = 'СМР')
        AND NOT EXISTS (SELECT 1 FROM contracts c WHERE c.request_id = r.id AND c.service = 'СМР'
                         AND c.status <> 'terminated' AND c.paid_at IS NOT NULL)
      GROUP BY r.id
     HAVING max(s.left_at) < now() - interval '3 months'`);
  for (const row of rows) {
    await db.tx(async (t) => {
      await t.query('UPDATE requests SET tv_recheck_required_at = current_date WHERE id = $1', [row.id]);
      await repo.logEvent(t, {
        actorName: 'Система', action: 'Требуется повторная оценка ТВ: условия ПСД устарели', entity: 'request',
        entityId: row.id, detail: `ПСД получена ${row.psd_done}, прошло 3 месяца`, regulationRef: 'п. 47',
      });
      await sendAll(t, await orpsdFor(t, row.id), {
        eventKey: 'psd_conditions_expired', subject: `Заявка ${row.number}: условия установки по ПСД устарели`,
        body: `С даты получения ПСД (${row.psd_done}) прошло 3 месяца. Условия установки оборудования перестают быть ` +
          'актуальными: перед СМР выполните повторную оценку технической возможности и при необходимости актуализируйте проект (п. 47).',
        payload: { requestId: row.id },
      });
    });
  }
  return { job: 'Актуальность условий ПСД', regulationRef: 'п. 47', affected: rows.length };
}

/**
 * АВР и ЭСФ — не позднее 1 операционного дня после оказания услуги (п. 91).
 * Не оформлено — напоминание расчётам с контрагентам, один раз по договору.
 */
export async function runAvrFormationControl(db: Db, calendar: WorkCalendar): Promise<JobResult> {
  const rows = await db.query<{ id: string; number: string; service: string; request_id: string; request_number: string; done_at: string | null }>(
    `SELECT c.id, c.number, c.service, c.request_id, r.number AS request_number,
            (SELECT max(s.left_at)::date::text FROM request_stages s
              WHERE s.request_id = r.id AND s.stage_code = CASE c.service WHEN 'ТУ' THEN 'tu' WHEN 'ПСД' THEN 'psd' ELSE 'smr' END
                AND s.left_at IS NOT NULL) AS done_at
       FROM contracts c JOIN requests r ON r.id = c.request_id
      WHERE c.status <> 'terminated' AND c.paid_at IS NOT NULL AND c.avr_formed_at IS NULL AND c.avr_sent_at IS NULL
        AND c.accepted_at IS NULL AND r.closed_at IS NULL`);
  const now = today();
  let affected = 0;
  const accounting = (await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.is_active AND r.role = 'accounting'`)).map((r) => r.email);
  for (const row of rows) {
    if (!row.done_at || addWorkingDays(row.done_at, 1, calendar) >= now) continue;
    if (await alreadySent(db, 'avr_formation_overdue', 'contractId', row.id)) continue;
    await sendAll(db, accounting, {
      eventKey: 'avr_formation_overdue', subject: `АВР и ЭСФ по договору ${row.number} не оформлены`,
      body: `Услуга «${row.service}» по заявке ${row.request_number} оказана ${row.done_at}. АВР и электронная ` +
        'счёт-фактура оформляются не позднее 1 операционного дня (п. 91). Отметьте оформление в карточке заявки.',
      payload: { contractId: row.id, requestId: row.request_id },
    });
    affected++;
  }
  return { job: 'Контроль оформления АВР и ЭСФ', regulationRef: 'п. 91', affected };
}

/** Сводный отчёт по показателям филиалов — до 1 марта (пп. 107, 109; правило 21). */
export async function runAnnualReportReminder(db: Db, now: string = today()): Promise<JobResult> {
  const [y, m, d] = now.split('-').map(Number);
  // Напоминание — с 20 февраля до 1 марта включительно.
  if (!((m === 2 && d >= 20) || (m === 3 && d === 1))) return { job: 'Напоминание о сводном отчёте', regulationRef: 'пп. 107, 109', affected: 0 };
  const period = String(y - 1);
  if (await alreadySent(db, 'annual_report_due', 'year', period)) return { job: 'Напоминание о сводном отчёте', regulationRef: 'пп. 107, 109', affected: 0 };
  const recipients = (await db.query<{ email: string }>(
    `SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.is_active AND r.role IN ('orpsd', 'management')`)).map((r) => r.email);
  await sendAll(db, recipients, {
    eventKey: 'annual_report_due', subject: `Сводный отчёт по показателям филиалов за ${period} год`,
    body: `Сводный отчёт по производственным показателям филиалов за ${period} год формируется не позднее 1 марта ` +
      '(пп. 107, 109 Регламента ОРПСД-Р-01). Отчёт собран системой в разделе «Отчёты» → «Сводный за год».',
    payload: { year: period },
  });
  return { job: 'Напоминание о сводном отчёте', regulationRef: 'пп. 107, 109', affected: recipients.length };
}

/**
 * У каждой открытой заявки — исполнитель (п. 102). Задание подбирает
 * исполнителя, если его нет или учётная запись исполнителя отключена
 * (уволился, в отпуске и заблокирован): карточка не должна висеть ни на ком.
 * Назначить некого — письмо ДИТ и ОР ПСД, один раз по заявке.
 */
export async function runExecutorCheck(db: Db): Promise<JobResult> {
  const details: string[] = [];
  let affected = 0;
  for (const row of await executors.needingExecutors(db)) {
    const changes = await db.tx(async (t) => {
      const made = await executors.ensureExecutors(t, row.id);
      const request = await repo.getRequest(t, row.id);
      if (made.length && request) await announce(t, request, made, { actorId: null, actorName: 'Система', ip: null, userAgent: '' }, '', true);
      return made;
    });
    if (!changes.length) continue;
    affected++;
    const missing = changes.filter((c) => !c.to);
    details.push(`${row.number}: ${changes.map((c) => `${c.kind === 'responsible' ? 'ответственный' : 'этап'} — ${c.to?.name ?? 'некого назначить'}`).join('; ')}`);
    if (missing.length && !await alreadySent(db, 'executor_missing', 'requestId', row.id)) {
      await sendAll(db, await roleRecipients(db, ['admin', 'orpsd']), {
        eventKey: 'executor_missing',
        subject: `Заявке ${row.number} некого назначить исполнителем`,
        body: `У заявки ${row.number} нет исполнителя: в подразделении нет действующих сотрудников с нужной ролью. ` +
          'Назначьте исполнителя в карточке заявки или добавьте сотрудника на экране «Пользователи» (п. 102 Регламента).',
        payload: { requestId: row.id },
      });
    }
  }
  return { job: 'Исполнители заявок', regulationRef: 'п. 102', affected, details };
}

/** Полный проход по заданиям. */
export async function runAllJobs(db: Db): Promise<JobResult[]> {
  const calendar = await repo.calendar(db);
  return [
    await runExecutorCheck(db),
    await runEscalations(db, calendar),
    await runOfferExpiry(db, calendar),
    await runAvrSilence(db, calendar),
    await runEquipmentReminders(db),
    await runDocumentExpiry(db),
    await runBranchReportReminders(db),
    await runPsdControlPoints(db, calendar),
    await runPsdDeadlineNear(db, calendar),
    await runPaymentReminders(db, calendar),
    await runPsdConditionsExpiry(db),
    await runAvrFormationControl(db, calendar),
    await runAnnualReportReminder(db),
  ];
}
