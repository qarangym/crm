/**
 * Письма портала допусков (Инструкция о допуске, пп. 14–18; ТЗ портала, §5.2):
 *   заявка отправлена — специалистам СУА;
 *   нужно согласование — руководителю филиала (пп. 8, 14, 18);
 *   решение филиала — специалисту СУА, при отказе — и организации;
 *   допуск выдан — организации, копия — в филиал объекта (п. 15);
 *   аварийный допуск — организации и филиалу, напоминание о досылке запроса (п. 18);
 *   отказ, отзыв допуска, отзыв заявки — участникам.
 *
 * Функции вызываются в транзакции действия: письмо ставится в очередь вместе
 * с изменением и не теряется при сбое почты.
 */

import type { Db } from '../../db/client.ts';
import { notify, roleRecipients } from '../../server/notify.ts';
import type { AccessRequestRow } from '../db/permits.ts';
import { BASIS_NAME } from '../domain/basis.ts';
import { BRANCH_REASON_NAME, WORK_TYPE_NAME } from '../domain/rules.ts';
import type { BranchReason } from '../domain/rules.ts';

export const PERMITS_SIGNATURE = [
  '',
  '—',
  'АО «Казтелерадио», Служба управления активами.',
  'Сообщение сформировано порталом допусков; отвечать на него не нужно.',
].join('\n');

const period = (r: AccessRequestRow) =>
  `${(r.period_start ?? '').replace('T', ' ')} — ${(r.period_end ?? '').replace('T', ' ')}`;

const header = (r: AccessRequestRow) => [
  `Заявка на допуск: ${r.number}`,
  `Цель работ: ${r.work_type ? WORK_TYPE_NAME[r.work_type] : '—'}${r.on_ams ? ', на АМС' : ''}`,
  `Объект: ${r.facility_name ?? '—'}${r.branch_name ? ` (${r.branch_name})` : ''}`,
  `Период работ: ${period(r)}, время ${r.work_hours_from}–${r.work_hours_to}${r.weekend_work ? ', включая выходные' : ''}`,
  `Организация: ${r.counterparty_name} (БИН ${r.counterparty_bin})`,
];

const link = (r: AccessRequestRow) => `/dopusk/#${r.number}`;
const reasons = (r: AccessRequestRow) => (r.branch_reasons ?? []).map((x) => BRANCH_REASON_NAME[x as BranchReason] ?? x).join('; ');

/** Представители организации в портале и автор заявки. */
export async function contractorRecipients(db: Db, r: AccessRequestRow): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.counterparty_id = $1 AND u.is_active AND ur.role = 'contractor'
     UNION
     SELECT email FROM users WHERE id = $2 AND is_active`, [r.counterparty_id, r.created_by]);
  return rows.map((x) => x.email);
}

async function emails(db: Db, ids: (string | null)[]): Promise<string[]> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return [];
  const rows = await db.query<{ email: string }>(`SELECT email FROM users WHERE id = ANY($1::uuid[]) AND is_active`, [list]);
  return rows.map((x) => x.email);
}

/** Филиал объекта: директор, куратор, главный инженер, ответственное лицо на объекте (п. 15). */
export async function branchCopyRecipients(db: Db, r: AccessRequestRow): Promise<string[]> {
  if (!r.branch_id) return [];
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM branches b JOIN users u ON u.id = ANY(ARRAY[b.director_id, b.curator_id, b.chief_engineer_id, b.site_officer_id])
      WHERE b.id = $1 AND u.is_active`, [r.branch_id]);
  return [...rows.map((x) => x.email), ...await emails(db, [r.site_officer_id])];
}

async function suaRecipients(db: Db, r: AccessRequestRow): Promise<string[]> {
  const own = await emails(db, [r.assignee_id]);
  return own.length ? own : roleRecipients(db, ['permits']);
}

export async function requestSubmitted(db: Db, r: AccessRequestRow): Promise<void> {
  const check = r.basis_check as { message?: string; needsConfirmation?: boolean };
  await notify(db, [...await suaRecipients(db, r), ...(r.is_urgent ? await roleRecipients(db, ['permits']) : [])], {
    eventKey: 'access_request_submitted',
    subject: `${r.is_urgent ? 'СРОЧНО · ' : ''}Новая заявка на допуск ${r.number}`,
    body: [
      'Подана заявка на допуск персонала и техники на объект. Срок рассмотрения — до ' +
        `${r.review_due_at ?? '—'} (14 рабочих дней, п. 14 Инструкции).`, '',
      ...header(r),
      `Основание: ${r.basis_type ? `${BASIS_NAME[r.basis_type]} № ${r.basis_number}` : 'не требуется (п. 14)'}`,
      `Проверка основания: ${check.message ?? '—'}${check.needsConfirmation ? ' — нужно подтверждение вручную' : ''}`,
      `Работников: ${r.workers_count}, транспорт: ${r.vehicles_count}`,
      r.branch_approval === 'pending' ? `Нужно согласование руководства филиала: ${reasons(r)}` : '',
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function branchApprovalRequested(db: Db, r: AccessRequestRow): Promise<void> {
  const emergency = r.work_type === 'emergency';
  await notify(db, await emails(db, [r.branch_approver_id]), {
    eventKey: 'access_branch_approval',
    subject: `${emergency ? 'АВАРИЯ · ' : ''}Согласуйте допуск ${r.number} на объект филиала`,
    body: [
      emergency
        ? 'Аварийно-восстановительные работы: допуск предоставляется в день запроса по согласованию руководителя ' +
          'филиала (п. 18 Инструкции). Согласуйте или откажите в портале допусков.'
        : `Заявка на допуск требует согласования руководства филиала: ${reasons(r)}. Срок — до ${r.branch_due_at ?? '—'}.`,
      '',
      ...header(r),
      `Работников: ${r.workers_count}, транспорт: ${r.vehicles_count}`,
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function branchDecided(db: Db, r: AccessRequestRow): Promise<void> {
  const ok = r.branch_approval === 'approved';
  await notify(db, await suaRecipients(db, r), {
    eventKey: 'access_branch_decided',
    subject: `Филиал ${ok ? 'согласовал' : 'не согласовал'} допуск ${r.number}`,
    body: [
      `Руководство филиала ${ok ? 'согласовало' : 'не согласовало'} заявку на допуск` +
        `${r.branch_note ? `: ${r.branch_note}` : '.'}`, '',
      ...header(r),
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

/** Письменный ответ заявителю, копия — в филиал объекта (п. 15). */
export async function requestApproved(db: Db, r: AccessRequestRow): Promise<void> {
  const body = (forBranch: boolean) => [
    r.provisional
      ? 'Аварийный допуск предоставлен по согласованию руководства филиала (п. 18 Инструкции). Оформленный запрос ' +
        'необходимо направить в течение 2 календарных дней — загрузите скан в карточке заявки.'
      : 'Допуск на объект предоставлен. Электронный допуск доступен в разделе «Мои заявки» портала допусков.',
    '',
    ...header(r),
    `Код допуска для проверки на объекте: ${r.permit_code ?? '—'}`,
    `Работников: ${r.workers_count}, транспорт: ${r.vehicles_count}`,
    forBranch
      ? `Ответственное лицо на объекте: ${r.site_officer_name ?? 'не назначено'}. Перед началом работ проведите инструктаж ` +
        'с записью в журнале, проверьте спецодежду, спецобувь и СИЗ (пп. 21–23 Инструкции); отметки — в разделе ' +
        '«Проверка на объекте».'
      : 'На объекте ответственный работник филиала проводит инструктаж и проверяет спецодежду, спецобувь и СИЗ. ' +
        'Без СИЗ к работам не допускают (п. 22 Инструкции).',
    PERMITS_SIGNATURE,
  ].join('\n');
  await notify(db, await contractorRecipients(db, r), {
    eventKey: 'access_request_approved',
    subject: `${r.provisional ? 'Аварийный допуск' : 'Допуск'} по заявке ${r.number} предоставлен`,
    body: body(false),
    payload: { accessRequestId: r.id, link: link(r) },
  });
  await notify(db, await branchCopyRecipients(db, r), {
    eventKey: 'access_request_approved_branch',
    subject: `Копия: допуск ${r.number} на объект ${r.facility_name ?? ''}`.trim(),
    body: body(true),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function emergencyFinalized(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, [...await contractorRecipients(db, r), ...await branchCopyRecipients(db, r)], {
    eventKey: 'access_emergency_finalized',
    subject: `Аварийный допуск ${r.number} оформлен письменно`,
    body: ['Получен оформленный запрос, письменное разрешение по аварийному допуску направлено (п. 18 Инструкции).', '',
      ...header(r), PERMITS_SIGNATURE].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function requestRejected(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, await contractorRecipients(db, r), {
    eventKey: 'access_request_rejected',
    subject: `Заявка на допуск ${r.number} отклонена`,
    body: [
      'Заявка на допуск отклонена.', '',
      ...header(r),
      `Причина: ${r.rejection_reason ?? '—'}`, '',
      'Чтобы подать заявку снова, откройте её в разделе «Мои заявки» и нажмите «Подать повторно» — ' +
      'данные заполнятся из отклонённой заявки.',
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function requestWithdrawn(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, [...await suaRecipients(db, r), ...await emails(db, [r.branch_approval === 'pending' ? r.branch_approver_id : null])], {
    eventKey: 'access_request_withdrawn',
    subject: `Заявка на допуск ${r.number} отозвана организацией`,
    body: ['Организация отозвала заявку на допуск до решения.', '', ...header(r),
      r.rejection_reason ? `Причина: ${r.rejection_reason}` : '', PERMITS_SIGNATURE].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function permitRevoked(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, [...await contractorRecipients(db, r), ...await branchCopyRecipients(db, r)], {
    eventKey: 'access_permit_revoked',
    subject: `Допуск ${r.number} отозван`,
    body: ['Допуск на объект отозван Службой управления активами. Работы по нему не допускаются.', '',
      ...header(r), `Причина: ${r.revoke_reason ?? '—'}`, PERMITS_SIGNATURE].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}

export async function permitClosed(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, [...await contractorRecipients(db, r), ...await suaRecipients(db, r)], {
    eventKey: 'access_permit_closed',
    subject: `Работы по допуску ${r.number} завершены`,
    body: ['Ответственное лицо филиала отметило завершение работ и закрыло допуск.', '', ...header(r),
      r.close_note ? `Отметка: ${r.close_note}` : '', PERMITS_SIGNATURE].join('\n'),
    payload: { accessRequestId: r.id, link: link(r) },
  });
}
