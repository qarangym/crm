/**
 * Письма портала допусков (ТЗ портала, §5.2; «План реализации» v4, §1.5):
 *   заявка отправлена на рассмотрение — специалистам СУА;
 *   заявка одобрена, файл допуска прикреплён — подрядчику;
 *   заявка отклонена, с причиной — подрядчику.
 *
 * Функции вызываются в транзакции действия: письмо ставится в очередь вместе
 * с изменением и не теряется при сбое почты.
 */

import type { Db } from '../../db/client.ts';
import { notify, roleRecipients } from '../../server/notify.ts';
import type { AccessRequestRow } from '../db/permits.ts';
import { BASIS_NAME } from '../domain/basis.ts';

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
  `Объект: ${r.facility_name ?? '—'}${r.branch_name ? ` (${r.branch_name})` : ''}`,
  `Период работ: ${period(r)}`,
];

/** Представители организации в портале и автор заявки. */
export async function contractorRecipients(db: Db, r: AccessRequestRow): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.counterparty_id = $1 AND u.is_active AND ur.role = 'contractor'
     UNION
     SELECT email FROM users WHERE id = $2 AND is_active`, [r.counterparty_id, r.created_by]);
  return rows.map((x) => x.email);
}

export async function requestSubmitted(db: Db, r: AccessRequestRow): Promise<void> {
  const check = r.basis_check as { message?: string; needsConfirmation?: boolean };
  await notify(db, await roleRecipients(db, ['permits']), {
    eventKey: 'access_request_submitted',
    subject: `${r.is_urgent ? 'СРОЧНО · ' : ''}Новая заявка на допуск ${r.number}`,
    body: [
      'Подана заявка на допуск персонала и техники на объект. Заявка ждёт рассмотрения в очереди СУА.', '',
      ...header(r),
      `Организация: ${r.counterparty_name} (БИН ${r.counterparty_bin})`,
      `Основание: ${r.basis_type ? BASIS_NAME[r.basis_type] : '—'} № ${r.basis_number}`,
      `Проверка основания: ${check.message ?? '—'}${check.needsConfirmation ? ' — нужно подтверждение вручную' : ''}`,
      `Работников: ${r.workers_count}, транспорт: ${r.vehicles_count}`,
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id },
  });
}

export async function requestApproved(db: Db, r: AccessRequestRow): Promise<void> {
  await notify(db, await contractorRecipients(db, r), {
    eventKey: 'access_request_approved',
    subject: `Заявка на допуск ${r.number} одобрена`,
    body: [
      'Заявка на допуск одобрена. Файл допуска доступен для скачивания в разделе «Мои заявки» портала допусков.', '',
      ...header(r),
      'Допуск предъявляется на объекте; проверка бригады и транспорта на въезде выполняется в действующем порядке.',
      PERMITS_SIGNATURE,
    ].join('\n'),
    payload: { accessRequestId: r.id },
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
    payload: { accessRequestId: r.id },
  });
}
