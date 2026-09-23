/**
 * Условия перехода между этапами.
 *
 * Каждое условие — норма Регламента. Система не должна позволять нарушить
 * условие, которое Регламент установил: начать работы без 100 % предоплаты
 * (п. 86), заключить договор на СМР до утверждения сметы (п. 53), начать СМР
 * без завизированного акта приёма-передачи (п. 58) и т. д.
 *
 * Пункт 16.4 (поверочный расчёт «при приближении к предельным значениям»)
 * числового порога не содержит, а часть значений Приложения 8 помечена
 * [ЗАПОЛНИТЬ]. Собственный порог система не вводит: решение принимает инженер
 * ОР ПСД и оно фиксируется в заявке.
 */

import type { Service, TvStatus } from '../domain/types.ts';
import type { StageCode } from './stages.ts';
import { appliesTo, stage } from './stages.ts';

/** Снимок заявки, достаточный для проверки условий перехода. */
export type RequestSnapshot = {
  id: number;
  stageCode: StageCode;
  services: Service[];
  /** Внутренний номер CRM, присваивается при подаче. */
  number: string | null;
  /** Реквизиты официальной регистрации делопроизводством (п. 6). */
  incomingNumber: string | null;
  incomingDate: string | null;
  /** Оценка технической возможности (раздел 4). */
  tvStatus: TvStatus;
  /** Версия мастер-файла, использованная при расчёте (п. 16.5). */
  masterFileVersion: string | null;
  /** Решение инженера о поверочном расчёте, если загрузка близка к предельной (п. 16.4). */
  verificationCalcDecision: 'not_required' | 'required' | 'done' | null;
  /** Договор либо основание безвозмездной услуги (пп. 21, 32, 48). */
  contractNumber: string | null;
  /**
   * Все позиции заявки безвозмездны — только ТУ на присоединение к сети
   * телерадиовещания (п. 20). Вычисляется из состава услуг через
   * `pricing.isFreeOfCharge`: сам по себе вид услуги «ТУ» от оплаты не освобождает.
   */
  freeOfCharge: boolean;
  /** Фактическая дата поступления 100 % оплаты (п. 86). */
  paidAt: string | null;
  /** Утверждение сметной документации (пп. 41, 52). */
  estimateApproved: boolean;
  /** Распоряжение о разрешении на выполнение СМР (п. 60). */
  orderNumber: string | null;
  /** Завизированный акт приёма-передачи оборудования (п. 58). */
  transferActApprovedDate: string | null;
  /** Завизированный акт выполненных работ (пп. 66, 70). */
  avrApproved: boolean;
  /** АВР и ЭСФ направлены Заказчику (пп. 91–92). */
  avrSentAt: string | null;
  /** Подтверждение оформления закрывающих документов (п. 95). */
  closingConfirmed: boolean;
  /** Результат согласован и передан Заказчику (пп. 24, 42). */
  resultDelivered: boolean;
  /** Открытые замечания к заявке (ТЗ №11). */
  openRemarks: number;
};

export type GuardInput = {
  /** Причина — обязательна для отказа и возврата на доработку. */
  reason?: string | null;
  /** Подтверждение, что срок оферты истёк (проверяется движком по дате). */
  offerExpired?: boolean;
  /** Подтверждение, что истекли 10 рабочих дней на замечания (п. 94). */
  silenceAccepted?: boolean;
};

export type GuardFailure = {
  code: string;
  message: string;
  regulationRef: string;
};

export type GuardResult = { ok: true } | { ok: false; failures: GuardFailure[] };

type Guard = (r: RequestSnapshot, input: GuardInput) => GuardFailure[];

const fail = (code: string, message: string, regulationRef: string): GuardFailure => ({ code, message, regulationRef });

/** Регистрация: требуется заполненная заявка (ТЗ №4). */
const guardRegister: Guard = (r) =>
  r.number ? [] : [fail('no_number', 'Заявке не присвоен номер', 'п. 6')];

/** Направление на оценку ТВ: заявка зарегистрирована делопроизводством (п. 6). */
const guardToTvReview: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!r.incomingNumber || !r.incomingDate) {
    out.push(fail('not_registered', 'Укажите входящий номер и дату регистрации заявки', 'п. 6'));
  }
  return out;
};

/** Подтверждение ТВ (пп. 16.3, 16.5). */
const guardTvConfirmed: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (r.tvStatus !== 'confirmed') {
    out.push(fail('tv_not_confirmed', 'Техническая возможность не подтверждена', 'п. 16.3'));
  }
  if (!String(r.masterFileVersion ?? '').trim()) {
    out.push(fail('no_master_version', 'Укажите версию мастер-файла «Реестр АМС и загрузки», использованную при расчёте', 'п. 16.5'));
  }
  if (r.verificationCalcDecision === 'required') {
    out.push(fail('verification_pending', 'Требуется поверочный инженерный расчёт — завершите его либо уточните данные у филиала', 'п. 16.4'));
  }
  if (r.verificationCalcDecision === null) {
    out.push(fail('verification_undecided', 'Зафиксируйте решение о необходимости поверочного расчёта', 'п. 16.4'));
  }
  return out;
};

/** Отказ: мотивированный письменный ответ (п. 19, табл. 1). */
const guardReject: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  if (!String(input.reason ?? '').trim()) {
    out.push(fail('no_reason', 'Укажите мотивированную причину отказа', 'п. 19, табл. 1'));
  }
  return out;
};

/** Выставление счёта: договор либо основание безвозмездной услуги (пп. 21, 83–85). */
const guardOffer: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!String(r.contractNumber ?? '').trim()) {
    out.push(fail('no_contract', 'Укажите номер договора либо основание безвозмездного оказания услуги', 'пп. 21, 83'));
  }
  return out;
};

/**
 * Начало оказания услуг: 100 % предоплата (пп. 86, 89).
 * Исключение только одно — заявка целиком безвозмездна (п. 20).
 */
const guardPaid: Guard = (r) => {
  if (r.freeOfCharge) return [];
  if (!r.paidAt) {
    return [fail('not_paid', 'Подтвердите поступление 100 % предварительной оплаты', 'пп. 86, 89')];
  }
  return [];
};

/** Подготовка к СМР: договор не ранее утверждения сметной документации (пп. 49, 53). */
const guardSmrPrep: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!r.estimateApproved) {
    out.push(fail('estimate_not_approved', 'Сметная документация не утверждена — договор на СМР заключается не ранее её утверждения', 'пп. 49, 53'));
  }
  return out;
};

/** Начало СМР: акт приёма-передачи оборудования и распоряжение (пп. 58, 60). */
const guardSmrStart: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!r.transferActApprovedDate) {
    out.push(fail('no_transfer_act', 'Загрузите и завизируйте акт приёма-передачи оборудования', 'п. 58'));
  }
  if (!String(r.orderNumber ?? '').trim()) {
    out.push(fail('no_order', 'Укажите номер распоряжения о разрешении на выполнение СМР', 'п. 60'));
  }
  return out;
};

/** Переход к оформлению АВР: работы завершены (п. 66). */
const guardToAvr: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (r.services.includes('СМР') && !r.transferActApprovedDate) {
    out.push(fail('no_transfer_act', 'Нет завизированного акта приёма-передачи оборудования', 'п. 58'));
  }
  if (!r.services.includes('СМР') && !r.resultDelivered) {
    out.push(fail('result_not_delivered', 'Подтвердите согласование, утверждение и передачу результата Заказчику', 'пп. 24, 42'));
  }
  return out;
};

/** Направление АВР Заказчику (пп. 91–92). */
const guardToClosing: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!r.avrApproved) {
    out.push(fail('no_avr', 'Нужен подписанный и завизированный акт выполненных работ', 'пп. 66, 70'));
  }
  if (!r.avrSentAt) {
    out.push(fail('avr_not_sent', 'Отметьте направление АВР и ЭСФ Заказчику', 'пп. 91–92'));
  }
  return out;
};

/**
 * Закрытие: подтверждение Заказчика либо истечение 10 рабочих дней молчания
 * (п. 94 — работы считаются принятыми в полном объёме).
 */
const guardDone: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  if (!r.closingConfirmed && !input.silenceAccepted) {
    out.push(fail('closing_not_confirmed', 'Подтвердите приёмку Заказчиком либо истечение срока рассмотрения АВР', 'пп. 94–95'));
  }
  return out;
};

/** Закрытие по истечении оферты (табл. 1). */
const guardExpired: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  if (r.paidAt) out.push(fail('already_paid', 'Оплата поступила — заявка не может быть закрыта по оферте', 'табл. 1'));
  if (!input.offerExpired) out.push(fail('offer_active', 'Срок оферты ещё не истёк', 'табл. 1'));
  return out;
};

/** Расторжение по инициативе Заказчика (пп. 96–97). */
const guardCancel: Guard = (_r, input) =>
  String(input.reason ?? '').trim() ? [] : [fail('no_reason', 'Укажите основание расторжения', 'пп. 96–97')];

export type TransitionDefinition = {
  from: StageCode;
  to: StageCode;
  /** Действие в интерфейсе. */
  title: string;
  guard: Guard;
  regulationRef: string;
  /** Кто вправе выполнить переход. */
  roles: string[];
};

const SERVICE_STAGES: StageCode[] = ['tu', 'psd', 'smr_prep'];

/** Переходы основного маршрута строятся из порядка этапов; условия задаются явно. */
export const TRANSITIONS: readonly TransitionDefinition[] = [
  { from: 'draft', to: 'registered', title: 'Подать заявку', guard: guardRegister, regulationRef: 'п. 6', roles: ['customer', 'records', 'orpsd', 'admin'] },
  { from: 'registered', to: 'tv_review', title: 'Направить на оценку ТВ', guard: guardToTvReview, regulationRef: 'п. 6.1', roles: ['records', 'orpsd', 'admin'] },
  { from: 'registered', to: 'closed_rejected', title: 'Отклонить заявку', guard: guardReject, regulationRef: 'п. 19', roles: ['orpsd', 'admin'] },

  { from: 'tv_review', to: 'offer', title: 'ТВ подтверждена — сформировать КП', guard: guardTvConfirmed, regulationRef: 'пп. 16.3, 16.5, 21', roles: ['orpsd', 'admin'] },
  { from: 'tv_review', to: 'closed_rejected', title: 'ТВ отсутствует — мотивированный отказ', guard: guardReject, regulationRef: 'табл. 1', roles: ['orpsd', 'admin'] },

  { from: 'offer', to: 'awaiting_payment', title: 'Договор и счёт направлены', guard: guardOffer, regulationRef: 'пп. 84–85', roles: ['orpsd', 'accounting', 'admin'] },
  { from: 'offer', to: 'closed_cancelled', title: 'Расторжение / отзыв заявки', guard: guardCancel, regulationRef: 'пп. 96–97', roles: ['orpsd', 'admin'] },

  { from: 'awaiting_payment', to: 'tu', title: 'Оплата получена — выдача ТУ', guard: guardPaid, regulationRef: 'пп. 20, 24, 86', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'psd', title: 'Оплата получена — разработка ПСД', guard: guardPaid, regulationRef: 'пп. 33, 86', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'smr_prep', title: 'Оплата получена — подготовка к СМР', guard: (r, i) => [...guardPaid(r, i), ...guardSmrPrep(r, i)], regulationRef: 'пп. 49, 53, 54', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'closed_expired', title: 'Закрыть по истечении оферты', guard: guardExpired, regulationRef: 'табл. 1', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'closed_cancelled', title: 'Расторжение и возврат', guard: guardCancel, regulationRef: 'пп. 96–97', roles: ['orpsd', 'admin'] },

  { from: 'tu', to: 'psd', title: 'ТУ выданы — к разработке ПСД', guard: () => [], regulationRef: 'пп. 24, 32', roles: ['orpsd', 'admin'] },
  { from: 'tu', to: 'smr_prep', title: 'ТУ выданы — к подготовке СМР', guard: guardSmrPrep, regulationRef: 'пп. 49, 53', roles: ['orpsd', 'admin'] },
  { from: 'tu', to: 'avr', title: 'ТУ выданы — к оформлению АВР', guard: guardToAvr, regulationRef: 'пп. 25, 90', roles: ['orpsd', 'admin'] },

  { from: 'psd', to: 'smr_prep', title: 'ПСД утверждена — к подготовке СМР', guard: guardSmrPrep, regulationRef: 'пп. 42, 49, 53', roles: ['orpsd', 'admin'] },
  { from: 'psd', to: 'avr', title: 'ПСД передана — к оформлению АВР', guard: guardToAvr, regulationRef: 'пп. 42–43, 90', roles: ['orpsd', 'admin'] },

  { from: 'smr_prep', to: 'smr', title: 'Оборудование принято — начать СМР', guard: guardSmrStart, regulationRef: 'пп. 58–60', roles: ['orpsd', 'branch', 'admin'] },
  { from: 'smr_prep', to: 'closed_cancelled', title: 'Оборудование не предоставлено — расторжение', guard: guardCancel, regulationRef: 'пп. 57, 96', roles: ['orpsd', 'admin'] },

  { from: 'smr', to: 'avr', title: 'Работы завершены — оформить АВР', guard: guardToAvr, regulationRef: 'пп. 66, 70', roles: ['orpsd', 'branch', 'admin'] },

  { from: 'avr', to: 'closing', title: 'АВР и ЭСФ направлены Заказчику', guard: guardToClosing, regulationRef: 'пп. 91–93', roles: ['accounting', 'orpsd', 'admin'] },

  { from: 'closing', to: 'closed_done', title: 'Работы приняты — закрыть заявку', guard: guardDone, regulationRef: 'пп. 94–95, 127', roles: ['orpsd', 'accounting', 'admin'] },
];

/** Переходы, доступные из текущего этапа с учётом состава услуг. */
export function transitionsFrom(code: StageCode, services: readonly Service[]): TransitionDefinition[] {
  return TRANSITIONS.filter((t) => {
    if (t.from !== code) return false;
    if (SERVICE_STAGES.includes(t.to) && !appliesTo(t.to, services)) return false;
    return true;
  });
}

export function findTransition(from: StageCode, to: StageCode): TransitionDefinition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Проверка условий перехода без его применения — используется интерфейсом для подсказок. */
export function checkTransition(r: RequestSnapshot, to: StageCode, input: GuardInput = {}): GuardResult {
  const def = findTransition(r.stageCode, to);
  if (!def) {
    return {
      ok: false,
      failures: [fail('no_transition', `Переход «${stage(r.stageCode).name}» → «${stage(to).name}» не предусмотрен`, 'порядок этапов')],
    };
  }
  if (SERVICE_STAGES.includes(to) && !appliesTo(to, r.services)) {
    return { ok: false, failures: [fail('service_not_ordered', 'Услуга не заказана в этой заявке', 'п. 7.5')] };
  }
  const failures = def.guard(r, input);
  return failures.length ? { ok: false, failures } : { ok: true };
}
