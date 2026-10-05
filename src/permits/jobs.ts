/**
 * Фоновые задания портала допусков (Инструкция о допуске; ТЗ СУА, разд. 2:
 * «система должна автоматически контролировать сроки действия допусков,
 * договоров и документов работников»).
 *
 *  - рассмотрение СУА дольше 14 рабочих дней (п. 14) — исполнителю и руководителю СУА;
 *  - согласование филиала не получено в срок — руководителю филиала и СУА;
 *  - аварийный допуск не оформлен за 2 календарных дня (п. 18) — организации и СУА;
 *  - удостоверения, паспорта и визы работников истекают через 30 дней — организации;
 *  - допуск заканчивается через 3 дня — организации (продление, п. 19);
 *  - договор аренды истекает через 30 дней — организации и СУА (пп. 13, 14);
 *  - согласующий или ответственный на объекте отключён — назначается другой (п. 102 Регламента).
 *
 * Задания идемпотентны: письмо по одному поводу уходит один раз.
 */

import type { Db } from '../db/client.ts';
import * as repo from '../db/repo.ts';
import { today } from '../domain/calendar.ts';
import { notify, roleRecipients } from '../server/notify.ts';
import * as data from './db/permits.ts';
import { PERMITS_SIGNATURE } from './server/events.ts';

export type JobResult = { job: string; regulationRef: string; affected: number; details?: string[] };

async function sentBefore(db: Db, eventKey: string, key: string): Promise<boolean> {
  return !!await db.one(`SELECT 1 FROM notifications WHERE event_key = $1 AND payload->>'key' = $2 LIMIT 1`, [eventKey, key]);
}

/** Руководители СУА — отметка «руководитель подразделения» у специалистов по допускам; нет их — ДИТ. */
async function suaHeads(db: Db): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.is_active AND u.is_head AND r.role = 'permits'`);
  return rows.length ? rows.map((r) => r.email) : roleRecipients(db, ['admin']);
}

async function emailOf(db: Db, id: string | null): Promise<string[]> {
  if (!id) return [];
  const row = await db.one<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND is_active`, [id]);
  return row ? [row.email] : [];
}

async function contractors(db: Db, counterpartyId: string): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.counterparty_id = $1 AND u.is_active AND r.role = 'contractor'`, [counterpartyId]);
  return rows.map((r) => r.email);
}

export async function runPermitReviewControl(db: Db, now: string = today()): Promise<JobResult> {
  const details: string[] = [];
  let affected = 0;
  const overdue = await db.query<{ id: string; number: string; review_due_at: string; assignee_id: string | null; company: string }>(
    `SELECT a.id, a.number, a.review_due_at::text AS review_due_at, a.assignee_id, c.name_full AS company
       FROM access_requests a JOIN counterparties c ON c.id = a.counterparty_id
      WHERE a.status = 'pending_review' AND a.review_due_at < $1::date`, [now]);
  for (const r of overdue) {
    const key = `${r.id}:review`;
    if (await sentBefore(db, 'access_review_overdue', key)) continue;
    await notify(db, [...await emailOf(db, r.assignee_id), ...await suaHeads(db)], {
      eventKey: 'access_review_overdue',
      subject: `Просрочено рассмотрение заявки на допуск ${r.number}`,
      body: `Заявка ${r.number} (${r.company}) не рассмотрена в срок: ответ должен быть сформирован до ${r.review_due_at} — ` +
        `не позднее 14 рабочих дней (п. 14 Инструкции о допуске).${PERMITS_SIGNATURE}`,
      payload: { key, accessRequestId: r.id, link: `/dopusk/#${r.number}` },
    });
    await repo.logEvent(db, { actorName: 'Система', action: 'Просрочено рассмотрение заявки на допуск', entity: 'access_request',
      entityId: r.id, detail: `${r.number}: срок ${r.review_due_at}`, regulationRef: 'п. 14 Инструкции' });
    affected++; details.push(`${r.number}: рассмотрение просрочено`);
  }

  const branch = await db.query<{ id: string; number: string; branch_due_at: string; branch_approver_id: string | null;
    assignee_id: string | null; branch_id: string | null }>(
    `SELECT id, number, branch_due_at::text AS branch_due_at, branch_approver_id, assignee_id, branch_id FROM access_requests
      WHERE status = 'pending_review' AND branch_approval = 'pending' AND branch_due_at < $1::date`, [now]);
  for (const r of branch) {
    const key = `${r.id}:branch`;
    if (await sentBefore(db, 'access_branch_overdue', key)) continue;
    await notify(db, [...await emailOf(db, r.branch_approver_id), ...await emailOf(db, r.assignee_id)], {
      eventKey: 'access_branch_overdue',
      subject: `Не согласован допуск ${r.number}`,
      body: `Руководство филиала не согласовало заявку на допуск ${r.number} к сроку ${r.branch_due_at}. Согласуйте её в ` +
        `портале допусков; специалист СУА может отметить согласование, полученное устно или письмом.${PERMITS_SIGNATURE}`,
      payload: { key, accessRequestId: r.id, link: `/dopusk/#${r.number}` },
    });
    affected++; details.push(`${r.number}: согласование филиала просрочено`);
  }

  // Аварийный порядок: оформленный запрос и письменное разрешение — в течение 2 календарных дней (п. 18).
  const followups = await db.query<{ id: string; number: string; counterparty_id: string; assignee_id: string | null; letter: boolean }>(
    `SELECT id, number, counterparty_id, assignee_id, letter_file_id IS NOT NULL AS letter FROM access_requests
      WHERE status = 'approved' AND provisional AND followup_due_at < now()`);
  for (const r of followups) {
    const key = `${r.id}:followup`;
    if (await sentBefore(db, 'access_followup_overdue', key)) continue;
    const to = r.letter ? [...await emailOf(db, r.assignee_id), ...await suaHeads(db)]
      : [...await contractors(db, r.counterparty_id), ...await emailOf(db, r.assignee_id)];
    await notify(db, to, {
      eventKey: 'access_followup_overdue',
      subject: `Аварийный допуск ${r.number} не оформлен`,
      body: (r.letter
        ? 'Оформленный запрос получен, но письменное разрешение по аварийному допуску не направлено.'
        : 'Не получен оформленный запрос по аварийному допуску: его необходимо направить в течение 2 календарных дней.') +
        ` Пункт 18 Инструкции о допуске.${PERMITS_SIGNATURE}`,
      payload: { key, accessRequestId: r.id, link: `/dopusk/#${r.number}` },
    });
    affected++; details.push(`${r.number}: аварийный допуск не оформлен`);
  }
  return { job: 'Контроль сроков рассмотрения допусков', regulationRef: 'пп. 14, 18 Инструкции', affected, details };
}

export async function runPermitExpiry(db: Db, now: string = today()): Promise<JobResult> {
  let affected = 0;
  // Документы работников: за 30 дней до окончания.
  const docs = await db.query<{ id: string; title: string; valid_until: string; full_name: string; counterparty_id: string; kind: string }>(
    `SELECT d.id, d.title, d.valid_until::text AS valid_until, w.full_name, w.counterparty_id, d.kind
       FROM worker_documents d JOIN contractor_workers w ON w.id = d.worker_id
      WHERE w.is_active AND d.valid_until BETWEEN $1::date AND $1::date + 30`, [now]);
  for (const d of docs) {
    const key = `${d.id}:${d.valid_until}`;
    if (await sentBefore(db, 'worker_document_expiring', key)) continue;
    await notify(db, await contractors(db, d.counterparty_id), {
      eventKey: 'worker_document_expiring',
      subject: `Истекает документ работника: ${d.full_name}`,
      body: `${d.full_name}: «${d.title}» действует до ${d.valid_until}. Обновите документ в разделе «Бригады и работники» ` +
        `портала допусков — с истёкшим документом работника не включить в заявку и не допустить на объект.${PERMITS_SIGNATURE}`,
      payload: { key },
    });
    affected++;
  }
  // Допуски, заканчивающиеся через 3 дня: напомнить о продлении (п. 19).
  const ending = await db.query<{ id: string; number: string; counterparty_id: string; period_end: string; facility: string }>(
    `SELECT a.id, a.number, a.counterparty_id, to_char(a.period_end, 'YYYY-MM-DD HH24:MI') AS period_end, f.name AS facility
       FROM access_requests a LEFT JOIN facilities f ON f.id = a.facility_id
      WHERE a.status = 'approved' AND NOT a.provisional AND a.period_end::date BETWEEN $1::date AND $1::date + 3`, [now]);
  for (const r of ending) {
    const key = `${r.id}:ending`;
    if (await sentBefore(db, 'access_permit_ending', key)) continue;
    await notify(db, await contractors(db, r.counterparty_id), {
      eventKey: 'access_permit_ending',
      subject: `Допуск ${r.number} заканчивается ${r.period_end.slice(0, 10)}`,
      body: `Допуск ${r.number} на объект ${r.facility ?? ''} действует до ${r.period_end}. Если работы не завершены, подайте ` +
        `запрос на продление: в карточке допуска — «Продлить допуск» (п. 19 Инструкции).${PERMITS_SIGNATURE}`,
      payload: { key, accessRequestId: r.id, link: `/dopusk/#${r.number}` },
    });
    affected++;
  }
  // Договоры аренды: за 30 дней до окончания.
  const leases = await db.query<{ id: string; number: string; valid_until: string; counterparty_id: string; name_full: string }>(
    `SELECT l.id, l.number, l.valid_until::text AS valid_until, l.counterparty_id, c.name_full
       FROM lease_contracts l JOIN counterparties c ON c.id = l.counterparty_id
      WHERE l.status = 'active' AND l.valid_until BETWEEN $1::date AND $1::date + 30`, [now]);
  for (const l of leases) {
    const key = `${l.id}:${l.valid_until}`;
    if (await sentBefore(db, 'lease_expiring', key)) continue;
    await notify(db, [...await contractors(db, l.counterparty_id), ...await roleRecipients(db, ['permits'])], {
      eventKey: 'lease_expiring',
      subject: `Истекает договор аренды № ${l.number}`,
      body: `Договор аренды № ${l.number} (${l.name_full}) действует до ${l.valid_until}. Допуск на объект не может ` +
        `превышать срок договора аренды (пп. 13, 14 Инструкции).${PERMITS_SIGNATURE}`,
      payload: { key },
    });
    affected++;
  }
  return { job: 'Сроки документов работников, допусков и договоров аренды', regulationRef: 'пп. 13, 14, 19 Инструкции', affected };
}

/** Согласующий и ответственный на объекте отключены или отсутствуют — назначить действующего (п. 102 Регламента). */
export async function runPermitExecutors(db: Db): Promise<JobResult> {
  let affected = 0;
  const details: string[] = [];
  const pending = await db.query<{ id: string; number: string; branch_id: string | null; branch_approver_id: string | null }>(
    `SELECT a.id, a.number, a.branch_id, a.branch_approver_id FROM access_requests a
       LEFT JOIN users u ON u.id = a.branch_approver_id AND u.is_active
      WHERE a.status = 'pending_review' AND a.branch_approval = 'pending' AND u.id IS NULL`);
  for (const r of pending) {
    const next = await data.pickBranchApprover(db, r.branch_id);
    if (!next || next.id === r.branch_approver_id) continue;
    await data.setBranchApprover(db, r.id, next.id);
    await repo.logEvent(db, { actorName: 'Система', action: 'Назначен согласующий от филиала', entity: 'access_request',
      entityId: r.id, detail: `${r.number}: ${next.name}`, regulationRef: 'п. 102 Регламента' });
    affected++; details.push(`${r.number}: согласует ${next.name}`);
  }
  const active = await db.query<{ id: string; number: string; facility_id: string | null; branch_id: string | null }>(
    `SELECT a.id, a.number, a.facility_id, a.branch_id FROM access_requests a
       LEFT JOIN users u ON u.id = a.site_officer_id AND u.is_active
      WHERE a.status = 'approved' AND u.id IS NULL`);
  for (const r of active) {
    const next = await data.pickSiteOfficer(db, r.facility_id, r.branch_id);
    if (!next) continue;
    await db.query(`UPDATE access_requests SET site_officer_id = $2 WHERE id = $1`, [r.id, next.id]);
    await repo.logEvent(db, { actorName: 'Система', action: 'Назначено ответственное лицо на объекте', entity: 'access_request',
      entityId: r.id, detail: `${r.number}: ${next.name}`, regulationRef: 'п. 20 Инструкции' });
    affected++; details.push(`${r.number}: на объекте ${next.name}`);
  }
  return { job: 'Ответственные по допускам', regulationRef: 'п. 20 Инструкции, п. 102 Регламента', affected, details };
}

export async function runPermitJobs(db: Db): Promise<JobResult[]> {
  return [await runPermitExecutors(db), await runPermitReviewControl(db), await runPermitExpiry(db)];
}
