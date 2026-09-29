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

/** Договор по одной услуге заявки (пп. 21, 32, 48). */
export type ContractInfo = {
  service: Service;
  number: string;
  /** Фактическая дата поступления 100 % оплаты по этому договору (п. 86). */
  paidAt: string | null;
  /** Завизированный АВР по договору (пп. 70, 91). */
  avrApproved?: boolean;
  /** АВР и ЭСФ направлены Заказчику (пп. 91–92). */
  avrSentAt?: string | null;
  /** Работы по договору приняты: АВР подписан либо истёк срок замечаний (пп. 94–95). */
  acceptedAt?: string | null;
};

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
  /**
   * Действующие договоры по услугам. На каждую услугу — свой договор и своя
   * 100 % оплата (пп. 21, 32, 48, 59): оплата договора на ПСД не открывает СМР.
   */
  contracts: ContractInfo[];
  /**
   * Безвозмездные услуги заявки — ТУ на присоединение к сети телерадиовещания
   * (п. 20). Вычисляется через `pricing.isFreeOfCharge`: сам по себе вид услуги
   * «ТУ» от оплаты не освобождает.
   */
  freeServices: Service[];
  /** Все позиции заявки безвозмездны (п. 20). */
  freeOfCharge: boolean;
  /** Этапы, которые заявка уже прошла: этап услуги не повторяется. */
  passedStages: StageCode[];
  /** Утверждение сметной документации (пп. 41, 52). */
  estimateApproved: boolean;
  /** Распоряжение о разрешении на выполнение СМР (п. 60). */
  orderNumber: string | null;
  /** Завизированный акт приёма-передачи оборудования (п. 58). */
  transferActApprovedDate: string | null;
  /** Завизированный технический АВР филиала, подписанный Заказчиком (п. 66). */
  technicalAvrApproved: boolean;
  /** Завизированный АВР расчётов с контрагентами (пп. 70, 91). */
  avrApproved: boolean;
  /** Дата направления АВР и ЭСФ Заказчику (пп. 91–92); от неё — 10 р.д. по п. 94. */
  avrSentAt: string | null;
  /** Подтверждение оформления закрывающих документов (п. 95). */
  closingConfirmed: boolean;
  /** Результат согласован и передан Заказчику (пп. 24, 42). */
  resultDelivered: boolean;
  /** Открытые замечания к заявке (ТЗ №11). */
  openRemarks: number;
  /** Объект определён по справочнику (п. 16.1); false — известен только адрес. */
  facilityDetermined?: boolean;
  /**
   * Условия установки по ПСД устарели: прошло 3 месяца с её получения, а СМР
   * не начаты (п. 47). До повторной оценки ТВ к СМР не переходят.
   */
  tvRecheckRequired?: boolean;
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
  if (r.facilityDetermined === false) {
    out.push(fail('no_facility', 'Определите объект по адресу из заявки: от него зависят филиал и реестр', 'п. 16.1'));
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

/** Этап, на котором оказывается услуга. */
export const SERVICE_STAGE: Record<Service, StageCode> = { 'ТУ': 'tu', 'ПСД': 'psd', 'СМР': 'smr_prep' };

/** Действующий договор по услуге. */
export function contractFor(r: RequestSnapshot, service: Service): ContractInfo | undefined {
  return r.contracts.find((c) => c.service === service);
}

/** Дата оплаты договора по услуге; для безвозмездной услуги — не требуется (п. 20). */
export function paidAtFor(r: RequestSnapshot, service: Service): string | null {
  return contractFor(r, service)?.paidAt ?? null;
}

/** Услуги, которые ещё предстоит оказать: их этап не пройден и не открыт. */
export function pendingServices(r: RequestSnapshot): Service[] {
  return r.services.filter((s) => {
    const code = SERVICE_STAGE[s];
    if (r.passedStages.includes(code) || r.stageCode === code) return false;
    // СМР после подготовки идёт этапом «Выполнение СМР» — услуга уже оказывается.
    if (s === 'СМР' && (r.passedStages.includes('smr') || r.stageCode === 'smr')) return false;
    return true;
  });
}

/**
 * Услуги, договоры по которым заключаются в текущем цикле «КП → договор → оплата».
 * Безвозмездные услуги договора не требуют (п. 20). Договор на СМР при
 * заказанной ПСД заключается после её утверждения: стоимость СМР формируется
 * только по утверждённой сметной документации (пп. 49, 53).
 */
export function offerServices(r: RequestSnapshot): Service[] {
  const pending = pendingServices(r);
  return pending
    .filter((s) => !r.freeServices.includes(s))
    .filter((s) => !(s === 'СМР' && pending.includes('ПСД')));
}

/** Сметная документация на СМР утверждена (пп. 49, 53). */
const guardEstimate: Guard = (r) =>
  r.estimateApproved
    ? []
    : [fail('estimate_not_approved', 'Сметная документация не утверждена — договор на СМР заключается не ранее её утверждения', 'пп. 49, 53')];

/**
 * Договор и счёт направлены: на каждую услугу цикла заключён договор
 * (пп. 21, 32, 48, 83–85); договор на СМР — не ранее утверждения сметы (п. 53).
 */
const guardOffer: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  const due = offerServices(r);
  for (const service of due) {
    if (!contractFor(r, service)) {
      out.push(fail('no_contract', `Зарегистрируйте договор на услугу «${service}»`, 'пп. 21, 32, 48, 83'));
    }
  }
  if (due.includes('СМР')) out.push(...guardEstimate(r, input));
  return out;
};

/**
 * Начало оказания услуги: 100 % предоплата по договору этой услуги (пп. 86, 89).
 * Исключение — безвозмездная услуга (п. 20).
 */
const guardPaidFor = (service: Service): Guard => (r) => {
  if (r.freeServices.includes(service)) return [];
  const contract = contractFor(r, service);
  if (!contract) {
    return [fail('no_contract', `Нет договора на услугу «${service}»`, 'пп. 21, 32, 48')];
  }
  if (!contract.paidAt) {
    return [fail('not_paid', `Подтвердите поступление 100 % оплаты по договору ${contract.number} («${service}»)`, 'пп. 86, 89')];
  }
  return [];
};

/** Этап услуги не повторяется: заявка его уже прошла. */
const guardNotPassed = (code: StageCode): Guard => (r) =>
  r.passedStages.includes(code)
    ? [fail('stage_passed', `Этап «${stage(code).name}» уже пройден`, 'порядок этапов')]
    : [];

const all = (...guards: Guard[]): Guard => (r, input) => guards.flatMap((g) => g(r, input));

/** Условия ПСД актуальны 3 месяца с её получения — затем повторная оценка ТВ (п. 47). */
const guardTvActual: Guard = (r) => r.tvRecheckRequired
  ? [fail('tv_recheck_required', 'Прошло 3 месяца с получения ПСД: выполните повторную оценку технической возможности', 'п. 47')]
  : [];

/** Подготовка к СМР: утверждённая смета, договор на СМР и оплата по нему (пп. 49, 53, 59). */
const guardSmrPrep: Guard = all(guardNotPassed('smr_prep'), guardEstimate, guardPaidFor('СМР'), guardTvActual);

/**
 * Второй цикл для СМР после ПСД: смета утверждена, договор на СМР ещё не
 * оплачен (пп. 48–53). Если оплата уже поступила, заявка идёт прямо к подготовке СМР.
 */
const guardSmrOffer: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  if (!r.services.includes('СМР')) {
    out.push(fail('service_not_ordered', 'СМР в заявке не заказаны', 'п. 7.5'));
    return out;
  }
  out.push(...guardEstimate(r, input));
  if (paidAtFor(r, 'СМР')) {
    out.push(fail('already_paid', 'Договор на СМР уже оплачен — переходите к подготовке СМР', 'пп. 54, 59'));
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

/** Переход к оформлению АВР: работы завершены (пп. 24, 42, 66). */
const guardToAvr: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (r.stageCode === 'smr') {
    if (!r.technicalAvrApproved) {
      out.push(fail('no_technical_avr', 'Загрузите и завизируйте технический АВР, подписанный филиалом и Заказчиком', 'п. 66'));
    }
    return out;
  }
  if (!r.resultDelivered) {
    out.push(fail('result_not_delivered', 'Подтвердите согласование, утверждение и передачу результата Заказчику', 'пп. 24, 42'));
  }
  return out;
};

/**
 * Направление АВР Заказчику (пп. 91–92). АВР оформляется по каждому договору:
 * по услугам, оказанным раньше, акт мог уйти ещё до этого этапа. Приёмка
 * начинается, когда АВР направлены по всем действующим договорам.
 * Безвозмездная услуга (п. 20) АВР не требует.
 */
const guardToClosing: Guard = (r) => {
  const out: GuardFailure[] = [];
  if (!r.contracts.length) {
    if (r.freeOfCharge) return out;
    if (!r.avrApproved) out.push(fail('no_avr', 'Нужен подписанный и завизированный акт выполненных работ', 'пп. 70, 91'));
    if (!r.avrSentAt) out.push(fail('avr_not_sent', 'Отметьте дату направления АВР и ЭСФ Заказчику', 'пп. 91–92'));
    return out;
  }
  for (const c of r.contracts) {
    if (c.avrSentAt || c.acceptedAt) continue;
    if (!c.avrApproved) {
      out.push(fail('no_avr', `Загрузите и завизируйте АВР по договору ${c.number} («${c.service}»)`, 'пп. 70, 91'));
    }
    out.push(fail('avr_not_sent', `Отметьте направление АВР и ЭСФ по договору ${c.number} («${c.service}»)`, 'пп. 91–92'));
  }
  return out;
};

/**
 * Закрытие: подтверждение Заказчика либо истечение 10 рабочих дней молчания
 * (п. 94 — работы считаются принятыми в полном объёме).
 */
const guardDone: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  const allAccepted = r.contracts.length > 0 && r.contracts.every((c) => c.acceptedAt);
  if (!r.closingConfirmed && !input.silenceAccepted && !allAccepted) {
    out.push(fail('closing_not_confirmed', 'Подтвердите приёмку Заказчиком либо истечение срока рассмотрения АВР', 'пп. 94–95'));
  }
  return out;
};

/** Закрытие по истечении оферты (табл. 1): оплата по договорам цикла не поступила. */
const guardExpired: Guard = (r, input) => {
  const out: GuardFailure[] = [];
  if (offerServices(r).some((s) => paidAtFor(r, s))) {
    out.push(fail('already_paid', 'Оплата поступила — заявка не может быть закрыта по оферте', 'табл. 1'));
  }
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

  { from: 'offer', to: 'awaiting_payment', title: 'Договор и счёт направлены', guard: guardOffer, regulationRef: 'пп. 21, 53, 84–85', roles: ['orpsd', 'accounting', 'admin'] },
  { from: 'offer', to: 'closed_cancelled', title: 'Расторжение / отзыв заявки', guard: guardCancel, regulationRef: 'пп. 96–97', roles: ['orpsd', 'admin'] },

  { from: 'awaiting_payment', to: 'tu', title: 'Оплата получена — выдача ТУ', guard: all(guardNotPassed('tu'), guardPaidFor('ТУ')), regulationRef: 'пп. 20, 24, 86', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'psd', title: 'Оплата получена — разработка ПСД', guard: all(guardNotPassed('psd'), guardPaidFor('ПСД')), regulationRef: 'пп. 33, 86', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'smr_prep', title: 'Оплата получена — подготовка к СМР', guard: guardSmrPrep, regulationRef: 'пп. 49, 53, 54, 59', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'closed_expired', title: 'Закрыть по истечении оферты', guard: guardExpired, regulationRef: 'табл. 1', roles: ['orpsd', 'admin'] },
  { from: 'awaiting_payment', to: 'closed_cancelled', title: 'Расторжение и возврат', guard: guardCancel, regulationRef: 'пп. 96–97', roles: ['orpsd', 'admin'] },

  { from: 'tu', to: 'psd', title: 'ТУ выданы — к разработке ПСД', guard: guardPaidFor('ПСД'), regulationRef: 'пп. 24, 32, 86', roles: ['orpsd', 'admin'] },
  { from: 'tu', to: 'smr_prep', title: 'ТУ выданы — к подготовке СМР', guard: guardSmrPrep, regulationRef: 'пп. 49, 53, 59', roles: ['orpsd', 'admin'] },
  { from: 'tu', to: 'avr', title: 'ТУ выданы — к оформлению АВР', guard: guardToAvr, regulationRef: 'пп. 25, 90', roles: ['orpsd', 'admin'] },

  { from: 'psd', to: 'offer', title: 'ПСД утверждена — КП и договор на СМР', guard: guardSmrOffer, regulationRef: 'пп. 48–53', roles: ['orpsd', 'admin'] },
  { from: 'psd', to: 'smr_prep', title: 'ПСД утверждена — к подготовке СМР', guard: guardSmrPrep, regulationRef: 'пп. 42, 49, 53, 59', roles: ['orpsd', 'admin'] },
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
  // ТЗ №11: замечание снимается исправлением заявки, а не переходом этапа.
  // Закрыть заявку (отказ, расторжение, оферта) можно и при открытых замечаниях.
  if (r.openRemarks > 0 && !stage(to).terminal) {
    failures.push(fail('open_remarks',
      `Есть неустранённые замечания (${r.openRemarks}): дождитесь исправления заявки Заказчиком либо снимите замечание`,
      'ТЗ №11'));
  }
  return failures.length ? { ok: false, failures } : { ok: true };
}
