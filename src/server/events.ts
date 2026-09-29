/**
 * Уведомления по ключевым событиям заявки (Проверка функционала, В4).
 *
 * Каждое письмо — исполнение нормы Регламента или ТЗ:
 *   п. 6.2   — в день регистрации заявка направляется в филиал;
 *   пп. 9, 19, табл. 1 — письменный ответ Заказчику о ТВ либо мотивированный отказ;
 *   пп. 21, 84–85 — КП, договор и счёт направлены; счёт — в день получения СЗ;
 *   пп. 54, 89 — оплата поступила, работы начаты; СЗ в филиал с копией договора;
 *   пп. 58, 66 — акт загружен и ждёт визы ОР ПСД;
 *   пп. 90–91 — технический АВР подписан — расчётам с контрагентами;
 *   пп. 92–95, 127 — АВР направлен, работы приняты, заявка закрыта;
 *   ТЗ №7   — новое поручение ОКО.
 *
 * Функции вызываются в транзакции действия: письмо ставится в очередь вместе
 * с изменением и не теряется при сбое почты.
 */

import type { Db } from '../db/client.ts';
import type { RequestRow } from '../db/repo.ts';
import { addWorkingDays } from '../domain/calendar.ts';
import type { WorkCalendar } from '../domain/types.ts';
import { SERVICE_NAME } from '../domain/types.ts';
import type { StageCode } from '../process/stages.ts';
import { stage } from '../process/stages.ts';
import { branchRecipients, customerRecipients, notify, roleRecipients, SIGNATURE } from './notify.ts';

const services = (r: RequestRow) => r.services.map((s) => SERVICE_NAME[s]).join('; ');
const header = (r: RequestRow) => [
  `Заявка: ${r.number}${r.incomingNumber ? ` (вх. ${r.incomingNumber} от ${r.incomingDate})` : ''}`,
  `Объект: ${r.facilityName ?? '—'}`,
  `Услуги: ${services(r)}`,
];

/** Ответственный ОР ПСД по заявке, затем исполнитель поручения, затем весь ОР ПСД. */
async function orpsdRecipients(db: Db, r: RequestRow): Promise<string[]> {
  const assignee = await db.query<{ email: string }>(
    `SELECT u.email FROM requests q JOIN users u ON u.id = q.assignee_id
      WHERE q.id = $1 AND u.is_active
     UNION
     SELECT u.email FROM assignments a JOIN users u ON u.id = a.assignee_id
      WHERE a.request_id = $1 AND a.kind = 'control' AND u.is_active
        AND NOT EXISTS (SELECT 1 FROM requests q JOIN users x ON x.id = q.assignee_id WHERE q.id = $1 AND x.is_active)`,
    [r.uuid]);
  return assignee.length ? assignee.map((x) => x.email) : roleRecipients(db, ['orpsd']);
}

/** Заявка зарегистрирована делопроизводством — в филиал в день регистрации (п. 6.2; правило 1). */
export async function requestRegistered(db: Db, r: RequestRow, calendar: WorkCalendar): Promise<void> {
  if (!r.branchId) return;
  const answerBy = addWorkingDays(r.incomingDate ?? r.createdAt.slice(0, 10), 5, calendar);
  await notify(db, await branchRecipients(db, r.branchId, ['curator', 'engineer']), {
    eventKey: 'request_registered_branch', ruleId: 1,
    subject: `Заявка ${r.number} по объекту вашего филиала`,
    body: [
      'В систему поступила и зарегистрирована заявка по объекту филиала.', '',
      ...header(r), `Заказчик: ${r.counterpartyName}`, '',
      `Ответ о технической возможности — не позднее ${answerBy} (п. 9). ` +
      'Запросы ОР ПСД к филиалу направляются служебной запиской, срок ответа 3 рабочих дня (п. 10).',
    ].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Новое поручение — ОКО на контроль (ТЗ №7). */
export async function assignmentCreated(db: Db, r: RequestRow, dueAt: string): Promise<void> {
  await notify(db, await roleRecipients(db, ['oko']), {
    eventKey: 'assignment_created_oko', ruleId: 1,
    subject: `Новое поручение по заявке ${r.number}`,
    body: [
      'Зарегистрирована заявка, поручение ОР ПСД поставлено на контроль.', '',
      ...header(r), `Заказчик: ${r.counterpartyName}`,
      `Срок ответа о технической возможности: ${dueAt} (п. 9).`,
    ].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Решение по технической возможности — письменный ответ Заказчику (пп. 9, 19, табл. 1). */
export async function tvAnswered(db: Db, r: RequestRow, confirmed: boolean, reason: string | null): Promise<void> {
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: confirmed ? 'tv_confirmed' : 'tv_refused',
    subject: confirmed
      ? `Заявка ${r.number}: техническая возможность подтверждена`
      : `Заявка ${r.number}: мотивированный отказ`,
    body: [
      ...header(r), '',
      confirmed
        ? 'Техническая возможность подтверждена. Коммерческое предложение и проект договора ' +
          'направляются отдельно; стоимость определяется по Прейскуранту (п. 21).'
        : `Техническая возможность отсутствует. Основание: ${reason ?? 'указано в письме Общества'}.`,
      SIGNATURE,
    ].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** КП, договор и счёт направлены — срок оферты (пп. 21, 84–88, табл. 1; правило 6). */
export async function offerSent(db: Db, r: RequestRow, dueAt: string | null, contracts: { service: string | null; number: string; amount: string | null }[]): Promise<void> {
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: 'offer_sent', ruleId: 6,
    subject: `Заявка ${r.number}: договор и счёт на оплату`,
    body: [
      ...header(r), '',
      'Направлены коммерческое предложение, договор и счёт:',
      ...contracts.map((c) => `  • ${c.service}: договор ${c.number}${c.amount ? `, сумма ${c.amount} ₸` : ''}`),
      '',
      `Работы начинаются после поступления 100 % предоплаты (п. 86). Срок оплаты по оферте — 10 рабочих дней` +
      `${dueAt ? `, до ${dueAt}` : ''}; при неоплате заявка закрывается (табл. 1).`,
      SIGNATURE,
    ].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Договор зарегистрирован — СЗ в расчёты с контрагентами на счёт (пп. 84–85; правило 5). */
export async function contractRegistered(db: Db, r: RequestRow, c: { service: string; number: string; amount: number | null }): Promise<void> {
  await notify(db, await roleRecipients(db, ['accounting']), {
    eventKey: 'invoice_requested', ruleId: 5,
    subject: `Счёт по договору ${c.number} (заявка ${r.number})`,
    body: [
      ...header(r), `Заказчик: ${r.counterpartyName}`, '',
      `Зарегистрирован договор ${c.number} на услугу «${c.service}»${c.amount !== null ? ` на сумму ${c.amount} ₸` : ''}.`,
      'Счёт формируется в день получения служебной записки и направляется Заказчику (пп. 84–85).',
    ].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Оплата поступила (пп. 86, 89; правило 7). */
export async function paymentReceived(db: Db, r: RequestRow, c: { service: string | null; number: string }, paidAt: string): Promise<void> {
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: 'payment_received', ruleId: 7,
    subject: `Заявка ${r.number}: оплата по договору ${c.number} получена`,
    body: [...header(r), '', `Поступление 100 % оплаты по договору ${c.number} («${c.service}») зафиксировано ${paidAt}.`,
      'Срок оказания услуги отсчитывается с даты полной оплаты (пп. 24, 33, 59).', SIGNATURE].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Начат этап услуги — Заказчику срок; для СМР — СЗ в филиал (пп. 24, 33, 54–55). */
export async function serviceStarted(db: Db, r: RequestRow, code: StageCode, dueAt: string | null): Promise<void> {
  const text: Partial<Record<StageCode, string>> = {
    tu: `Начата разработка технических условий. Срок — не позднее ${dueAt} (п. 24).`,
    psd: `Начата разработка проектно-сметной документации. Срок — не позднее ${dueAt} (п. 33).`,
    smr_prep: `Оплата по договору на СМР получена. Передайте оборудование и материалы филиалу по акту ` +
      `приёма-передачи в срок не более 90 календарных дней — до ${dueAt} (п. 55).`,
    smr: `Начато выполнение строительно-монтажных работ. Срок — не позднее ${dueAt} (п. 59).`,
  };
  if (!text[code]) return;
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: `stage_${code}_started`, ruleId: 7,
    subject: `Заявка ${r.number}: ${stage(code).name.toLowerCase()}`,
    body: [...header(r), '', text[code]!, SIGNATURE].join('\n'),
    payload: { requestId: r.uuid },
  });
  if (code === 'smr_prep' && r.branchId) {
    const contract = r.contracts.find((c) => c.service === 'СМР');
    await notify(db, await branchRecipients(db, r.branchId, ['curator', 'engineer']), {
      eventKey: 'smr_paid_branch', ruleId: 7,
      subject: `СМР по заявке ${r.number}: оплата получена, приём оборудования`,
      body: [
        ...header(r), `Заказчик: ${r.counterpartyName}`, '',
        `Оплата по договору на СМР ${contract?.number ?? ''} поступила. Филиалу — принять оборудование ` +
        'и материалы по акту приёма-передачи и направить акт в течение 2 рабочих дней (пп. 54, 58). ' +
        'Копия договора — в карточке заявки.',
      ].join('\n'),
      payload: { requestId: r.uuid },
    });
  }
}

/** Акт загружен и ждёт визы ОР ПСД (пп. 58, 66). */
export async function actAwaitingApproval(db: Db, r: RequestRow, kind: string, number: string): Promise<void> {
  await notify(db, await orpsdRecipients(db, r), {
    eventKey: 'act_awaiting_approval',
    subject: `${kind} ${number} по заявке ${r.number} ожидает визы`,
    body: [...header(r), '', `Филиал загрузил документ «${kind}» № ${number}. Завизируйте его в карточке заявки: ` +
      'от визы зависит переход к следующему этапу.'].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Акт приёма-передачи завизирован — распоряжение на СМР (пп. 58–60; правило 11). */
export async function transferActApproved(db: Db, r: RequestRow): Promise<void> {
  await notify(db, await orpsdRecipients(db, r), {
    eventKey: 'transfer_act_approved', ruleId: 11,
    subject: `Заявка ${r.number}: подготовить распоряжение на СМР`,
    body: [...header(r), '', 'Акт приёма-передачи оборудования завизирован. Оформите распоряжение о разрешении ' +
      'на выполнение СМР (п. 60); срок СМР — 15 рабочих дней (п. 59).'].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Технический АВР подписан — АВР и ЭСФ в 1 операционный день (пп. 66, 90–91; правило 13). */
export async function technicalAvrApproved(db: Db, r: RequestRow): Promise<void> {
  await notify(db, await roleRecipients(db, ['accounting']), {
    eventKey: 'technical_avr_approved', ruleId: 13,
    subject: `Заявка ${r.number}: оформить АВР и ЭСФ`,
    body: [...header(r), `Заказчик: ${r.counterpartyName}`, '',
      'Технический АВР подписан филиалом и Заказчиком и завизирован. АВР и электронная счёт-фактура ' +
      'оформляются не позднее 1 операционного дня (п. 91).'].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** АВР и ЭСФ направлены — 10 рабочих дней на замечания (пп. 92–94). */
export async function avrSent(db: Db, r: RequestRow, sentAt: string, calendar: WorkCalendar, contract?: string): Promise<void> {
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: 'avr_sent',
    subject: `Заявка ${r.number}: акт выполненных работ${contract ? ` по договору ${contract}` : ''}`,
    body: [...header(r), '',
      `Акт выполненных работ и электронная счёт-фактура направлены ${sentAt}.`,
      `Подпишите акт либо направьте мотивированные замечания до ${addWorkingDays(sentAt, 10, calendar)}. ` +
      'Без подтверждения и замечаний в этот срок работы считаются принятыми в полном объёме (п. 94).',
      SIGNATURE].join('\n'),
    payload: { requestId: r.uuid },
  });
}

/** Заявка закрыта: исполнена, отклонена, расторгнута (пп. 19, 96–97, 127). */
export async function requestClosed(db: Db, r: RequestRow, to: StageCode, reason: string | null): Promise<void> {
  const text: Partial<Record<StageCode, [string, string]>> = {
    closed_done: ['исполнена', 'Работы приняты, договорные обязательства исполнены (п. 127).'],
    closed_rejected: ['отказ', `Заявка отклонена. Основание: ${reason ?? '—'} (п. 19, табл. 1).`],
    closed_cancelled: ['расторгнута', `Договор расторгнут по соглашению сторон. Основание: ${reason ?? '—'}. ` +
      'Возврат денежных средств, если он предусмотрен, оформляется отдельно (пп. 96–97).'],
  };
  const t = text[to];
  if (!t) return;
  await notify(db, await customerRecipients(db, r.counterpartyId), {
    eventKey: `request_${to}`,
    subject: `Заявка ${r.number}: ${t[0]}`,
    body: [...header(r), '', t[1], SIGNATURE].join('\n'),
    payload: { requestId: r.uuid },
  });
}
