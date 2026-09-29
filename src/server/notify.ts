/**
 * Адресаты уведомлений по ключевым событиям заявки (Проверка функционала, В4).
 *
 * Регламент требует не только выполнить действие, но и сообщить о нём:
 * в день регистрации заявка направляется в филиал (п. 6.2), Заказчику —
 * письменный ответ о технической возможности (пп. 9, 19), после оплаты СМР —
 * служебная записка в филиал (п. 54), расчётам с контрагентами — о подписанном
 * техническом АВР (пп. 90–91) и т. д. Здесь собраны правила «кому»; тексты
 * писем — рядом с действием, которое их вызывает.
 *
 * Правило автоматизации, выключенное администратором ДИТ, писем не рассылает
 * (действие при этом выполняется и пишется в журнал).
 */

import type { Db } from '../db/client.ts';
import type { Role } from '../domain/types.ts';
import { enqueue } from './notifications.ts';

/** Почта Заказчика: карточка организации и активные представители в системе. */
export async function customerRecipients(db: Db, counterpartyId: string): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT email FROM counterparties WHERE id = $1 AND email <> ''
     UNION
     SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.counterparty_id = $1 AND u.is_active AND r.role = 'customer'`, [counterpartyId]);
  return rows.map((r) => r.email);
}

/**
 * Сотрудники с ролью. Для роли «Филиал» можно ограничить филиалом заявки —
 * иначе письмо о чужом объекте уйдёт всем филиалам.
 */
export async function roleRecipients(db: Db, roles: Role[], branchId: string | null = null): Promise<string[]> {
  const rows = await db.query<{ email: string }>(
    `SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.is_active AND r.role = ANY($1::text[])
        AND ($2::uuid IS NULL OR r.role <> 'branch' OR u.branch_id = $2)`, [roles, branchId]);
  return rows.map((r) => r.email);
}

export type BranchContact = 'director' | 'curator' | 'engineer' | 'board';

/** Ответственные лица филиала по Приложению 7. */
export async function branchRecipients(db: Db, branchId: string, who: BranchContact[]): Promise<string[]> {
  const column: Record<BranchContact, string> = {
    director: 'director_id', curator: 'curator_id', engineer: 'chief_engineer_id', board: 'board_curator_id',
  };
  const ids = who.map((w) => `b.${column[w]}`).join(', ');
  const rows = await db.query<{ email: string }>(
    `SELECT u.email FROM branches b JOIN users u ON u.id = ANY(ARRAY[${ids}]::uuid[])
      WHERE b.id = $1 AND u.is_active`, [branchId]);
  return rows.map((r) => r.email);
}

/** Включено ли правило автоматизации (по умолчанию — да). */
export async function ruleEnabled(db: Db, ruleId: number): Promise<boolean> {
  const row = await db.one<{ enabled: boolean }>('SELECT enabled FROM automation_rules WHERE id = $1', [ruleId]);
  return row ? row.enabled : true;
}

export type Message = {
  eventKey: string;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
  /** Правило автоматизации, от которого зависит рассылка. */
  ruleId?: number;
};

/** Постановка писем в очередь: адреса без повторов, пустые пропускаются. */
export async function notify(db: Db, recipients: string[], message: Message): Promise<number> {
  if (message.ruleId && !await ruleEnabled(db, message.ruleId)) return 0;
  const unique = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
  for (const recipient of unique) {
    await enqueue(db, {
      eventKey: message.eventKey, recipient, subject: message.subject, body: message.body,
      payload: message.payload,
    });
  }
  return unique.length;
}

/** Подпись писем Заказчику. */
export const SIGNATURE = [
  '',
  '—',
  'АО «Казтелерадио», отдел разработки проектно-сметной документации.',
  'Сообщение сформировано системой учёта заявок; отвечать на него не нужно.',
].join('\n');
