/**
 * Этапы обработки заявки.
 *
 * Семь статусов ТЗ №10 сохраняются как витрина для Заказчика, но управленческая
 * прозрачность требует более мелкого шага: у каждого этапа свой норматив
 * Регламента и своя ответственная сторона. Без этого весь цикл от оценки ТВ до
 * закрытия договора прячется внутри статуса «В работе», и руководство не видит,
 * где именно стоит заявка.
 *
 * Определения ниже — начальное наполнение таблицы `stage_definitions`.
 * В работающей системе они редактируются администратором ДИТ: Регламент
 * изменению не подлежит, но его следующая редакция не должна требовать
 * пересборки приложения.
 */

import type { CustomerStatus, OwnerParty, Service, SlaUnit } from '../domain/types.ts';

export type StageCode =
  | 'draft'
  | 'registered'
  | 'tv_review'
  | 'offer'
  | 'awaiting_payment'
  | 'tu'
  | 'psd'
  | 'smr_prep'
  | 'smr'
  | 'avr'
  | 'closing'
  | 'closed_done'
  | 'closed_rejected'
  | 'closed_expired'
  | 'closed_cancelled';

export type StageDefinition = {
  code: StageCode;
  order: number;
  name: string;
  /** Короткое имя для колонки доски. */
  short: string;
  slaValue: number;
  slaUnit: SlaUnit;
  /** Человекочитаемый норматив для интерфейса. */
  slaText: string;
  ownerParty: OwnerParty;
  /** Этап применяется только если в заявке есть эта услуга. */
  serviceScope?: Service;
  /** Статус, который видит Заказчик (ТЗ №10). */
  customerStatus: CustomerStatus;
  terminal: boolean;
  regulationRef: string;
  hint: string;
};

export const STAGES: readonly StageDefinition[] = [
  {
    code: 'draft',
    order: 1,
    name: 'Черновик заявки',
    short: 'Черновик',
    slaValue: 0,
    slaUnit: 'none',
    slaText: '—',
    ownerParty: 'customer',
    customerStatus: 'draft',
    terminal: false,
    regulationRef: 'ТЗ №1',
    hint: 'Заказчик заполняет форму на портале. Заявка ещё не подана.',
  },
  {
    code: 'registered',
    order: 2,
    name: 'Зарегистрирована',
    short: 'Регистрация',
    slaValue: 0,
    slaUnit: 'same_day',
    slaText: 'в день поступления',
    ownerParty: 'records',
    customerStatus: 'registered',
    terminal: false,
    regulationRef: 'п. 6',
    hint: 'Регистрация в СП ЦА, ответственном за документооборот, и направление в ОР ПСД и филиал.',
  },
  {
    code: 'tv_review',
    order: 3,
    name: 'Оценка технической возможности',
    short: 'Оценка ТВ',
    slaValue: 5,
    slaUnit: 'working',
    slaText: '5 рабочих дней',
    ownerParty: 'orpsd',
    customerStatus: 'review',
    terminal: false,
    regulationRef: 'пп. 9, 16',
    hint: 'Проверка по мастер-файлу «Реестр АМС и загрузки»; результат фиксируется с версией реестра.',
  },
  {
    code: 'offer',
    order: 4,
    name: 'КП, договор, счёт',
    short: 'КП и договор',
    slaValue: 1,
    slaUnit: 'operational',
    slaText: 'счёт — в день получения СЗ',
    ownerParty: 'orpsd',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 21, 32, 48, 84–85',
    hint: 'Коммерческое предложение по Прейскуранту суммой позиций, проект договора, счёт в 1С.',
  },
  {
    code: 'awaiting_payment',
    order: 5,
    name: 'Ожидание 100 % предоплаты',
    short: 'Оплата',
    slaValue: 10,
    slaUnit: 'working',
    slaText: 'оферта 10 рабочих дней',
    ownerParty: 'customer',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 86–88, табл. 1',
    hint: 'Ежедневный мониторинг поступления оплаты; по истечении оферты заявка закрывается.',
  },
  {
    code: 'tu',
    order: 6,
    name: 'Выдача технических условий',
    short: 'ТУ',
    slaValue: 5,
    slaUnit: 'working',
    slaText: '5 рабочих дней после полной оплаты',
    ownerParty: 'orpsd',
    serviceScope: 'ТУ',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 22–24',
    hint: 'Разработка, согласование с филиалом, утверждение и направление ТУ Заявителю.',
  },
  {
    code: 'psd',
    order: 7,
    name: 'Разработка ПСД',
    short: 'ПСД',
    slaValue: 30,
    slaUnit: 'working',
    slaText: '30 рабочих дней, продление не более 15',
    ownerParty: 'orpsd',
    serviceScope: 'ПСД',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 33–42',
    hint: 'Контрольные точки: исходные данные (3 р.д.), графическая часть, двухуровневая проверка СД, согласование с филиалом.',
  },
  {
    code: 'smr_prep',
    order: 8,
    name: 'Подготовка к СМР',
    short: 'Подготовка СМР',
    slaValue: 90,
    slaUnit: 'calendar',
    slaText: 'до 90 календарных дней на оборудование',
    ownerParty: 'customer',
    serviceScope: 'СМР',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 55–60',
    hint: 'Заказчик передаёт оборудование по акту; филиал принимает; оформляется распоряжение на СМР.',
  },
  {
    code: 'smr',
    order: 9,
    name: 'Выполнение СМР',
    short: 'СМР',
    slaValue: 15,
    slaUnit: 'working',
    slaText: '15 рабочих дней',
    ownerParty: 'branch',
    serviceScope: 'СМР',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'п. 59',
    hint: 'Работы выполняет филиал; по завершении оформляется технический АВР.',
  },
  {
    code: 'avr',
    order: 10,
    name: 'АВР и ЭСФ',
    short: 'АВР и ЭСФ',
    slaValue: 1,
    slaUnit: 'operational',
    slaText: '1 операционный день',
    ownerParty: 'accounting',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 66, 70, 90–92',
    hint: 'Формирование АВР (Р-1 для ТУ и ПСД, № 2В для СМР — п. 70) и электронной счёт-фактуры, направление Заказчику.',
  },
  {
    code: 'closing',
    order: 11,
    name: 'Приёмка Заказчиком',
    short: 'Приёмка',
    slaValue: 10,
    slaUnit: 'working',
    slaText: '10 рабочих дней на замечания',
    ownerParty: 'customer',
    customerStatus: 'work',
    terminal: false,
    regulationRef: 'пп. 93–95',
    hint: 'Без подтверждения и мотивированных замечаний в срок работы считаются принятыми в полном объёме.',
  },
  {
    code: 'closed_done',
    order: 12,
    name: 'Исполнена',
    short: 'Исполнена',
    slaValue: 0,
    slaUnit: 'none',
    slaText: '—',
    ownerParty: 'orpsd',
    customerStatus: 'done',
    terminal: true,
    regulationRef: 'п. 127',
    hint: 'Договор считается исполненным после подписания всех предусмотренных документов.',
  },
  {
    code: 'closed_rejected',
    order: 13,
    name: 'Отказано',
    short: 'Отказ',
    slaValue: 2,
    slaUnit: 'working',
    slaText: 'ответ в 2 рабочих дня',
    ownerParty: 'orpsd',
    customerStatus: 'rejected',
    terminal: true,
    regulationRef: 'п. 19, табл. 1',
    hint: 'Мотивированный письменный отказ; заявка закрывается и архивируется.',
  },
  {
    code: 'closed_expired',
    order: 14,
    name: 'Закрыта по истечении оферты',
    short: 'Оферта истекла',
    slaValue: 0,
    slaUnit: 'none',
    slaText: '—',
    ownerParty: 'orpsd',
    customerStatus: 'rejected',
    terminal: true,
    regulationRef: 'табл. 1',
    hint: 'Оплата не поступила в течение 10 рабочих дней; заявка закрыта с письменным уведомлением.',
  },
  {
    code: 'closed_cancelled',
    order: 15,
    name: 'Расторгнута',
    short: 'Расторжение',
    slaValue: 0,
    slaUnit: 'none',
    slaText: '—',
    ownerParty: 'orpsd',
    customerStatus: 'rejected',
    terminal: true,
    regulationRef: 'пп. 96–97',
    hint: 'Соглашение о расторжении; при необходимости — заявка на возврат денежных средств.',
  },
];

const BY_CODE = new Map(STAGES.map((s) => [s.code, s]));

/**
 * Нормативы, изменённые администратором ДИТ (С9). Регламент изменению не
 * подлежит, но его следующая редакция не должна требовать пересборки: новый
 * норматив накладывается на значение из кода и действует для этапов, открытых
 * после изменения. Уже рассчитанные контрольные даты не пересчитываются.
 */
export type SlaOverride = { slaValue: number; slaUnit: SlaUnit; slaText: string };
const OVERRIDES = new Map<StageCode, SlaOverride>();

export function setStageOverrides(rows: { stageCode: StageCode; override: SlaOverride }[]): void {
  OVERRIDES.clear();
  for (const row of rows) if (BY_CODE.has(row.stageCode)) OVERRIDES.set(row.stageCode, row.override);
}

export function stageOverride(code: StageCode): SlaOverride | null {
  return OVERRIDES.get(code) ?? null;
}

export function stage(code: StageCode): StageDefinition {
  const found = BY_CODE.get(code);
  if (!found) throw new Error(`Неизвестный этап: ${code}`);
  const override = OVERRIDES.get(code);
  return override ? { ...found, ...override } : found;
}

/** Все этапы с действующими нормативами — для конфигурации интерфейса. */
export function currentStages(): StageDefinition[] {
  return STAGES.map((s) => stage(s.code));
}

/** Этапы доски: рабочие колонки без терминальных исходов. */
export const BOARD_STAGES = STAGES.filter((s) => !s.terminal);

/** Применим ли этап к заявке с данным составом услуг. */
export function appliesTo(code: StageCode, services: readonly Service[]): boolean {
  const scope = stage(code).serviceScope;
  return !scope || services.includes(scope);
}

/**
 * Следующий по порядку применимый этап основного маршрута.
 * Этапы услуг (ТУ, ПСД, СМР) пропускаются, если услуга не заказана.
 */
export function nextMainStage(code: StageCode, services: readonly Service[]): StageCode | null {
  const current = stage(code);
  if (current.terminal) return null;
  for (const candidate of STAGES) {
    if (candidate.terminal) break;
    if (candidate.order <= current.order) continue;
    if (appliesTo(candidate.code, services)) return candidate.code;
  }
  return 'closed_done';
}
