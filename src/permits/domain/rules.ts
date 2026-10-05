/**
 * Правила Инструкции о допуске сторонних организаций на объекты АО «Казтелерадио»
 * (temp/must/Инструкция_о_допуске.md). Чистые функции: решение по заявке, без
 * обращения к базе — поиск оснований и подсчёт людей на объекте делает слой данных.
 *
 *  - цель и характер работ определяют основание (пп. 7, 9, 12, 13): ТО, ремонт,
 *    аварийные работы и замена аналогичного оборудования — договор аренды; монтаж
 *    в помещениях, на крышах и территории — ТУ; контроль монтажа, выполняемого
 *    работниками Общества, — распоряжение Общества или договор на СМР;
 *    проектно-изыскательские работы — по согласованию с руководством филиала;
 *  - монтаж и демонтаж на АМС выполняют только работники Общества (п. 11);
 *  - согласование с руководством филиала (пп. 8, 14, 18): ТО и ремонт на АМС,
 *    изыскания, более 5 человек одновременно, аварийные работы, ночь и выходные;
 *  - ночью и в выходные — только аварийно-восстановительные работы (п. 14);
 *  - срок допуска не превышает срок договора аренды (пп. 13, 14), визы, а для
 *    граждан СНГ — срок безвизового пребывания (п. 16).
 */

import type { BasisType } from './basis.ts';

export type WorkType = 'maintenance' | 'replacement' | 'emergency' | 'survey' | 'installation' | 'supervision';

export const WORK_TYPES: readonly WorkType[] = ['maintenance', 'emergency', 'replacement', 'installation', 'supervision', 'survey'];

export const WORK_TYPE_NAME: Record<WorkType, string> = {
  maintenance: 'Техническое обслуживание и ремонт оборудования',
  emergency: 'Аварийно-восстановительные работы',
  replacement: 'Замена оборудования на аналогичное (без протяжки кабелей)',
  installation: 'Монтаж и/или демонтаж оборудования (помещения, крыши, территория)',
  supervision: 'Контроль монтажа/демонтажа, выполняемого работниками Общества',
  survey: 'Проектно-изыскательские работы (обследование объекта)',
};

export const WORK_TYPE_REF: Record<WorkType, string> = {
  maintenance: 'пп. 7, 8', emergency: 'пп. 14, 18', replacement: 'п. 7', installation: 'пп. 9, 10, 13',
  supervision: 'пп. 11, 12', survey: 'пп. 2, 14',
};

/** Допустимые основания по виду работ. Первое — основное, предлагается по умолчанию. */
export const ALLOWED_BASIS: Record<WorkType, BasisType[]> = {
  maintenance: ['lease'],
  emergency: ['lease'],
  replacement: ['lease'],
  installation: ['tu'],
  supervision: ['order', 'smr_contract'],
  survey: ['tu', 'lease', 'order'],
};

/** Основание обязательно: для изысканий его заменяет согласование с руководством филиала (п. 14). */
export const basisRequired = (w: WorkType): boolean => w !== 'survey';

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === 'string' && (WORK_TYPES as readonly string[]).includes(value);
}

export type BranchReason = 'ams' | 'survey' | 'crew' | 'emergency' | 'night' | 'weekend';

export const BRANCH_REASON_NAME: Record<BranchReason, string> = {
  ams: 'работы на АМС (п. 8)',
  survey: 'проектно-изыскательские работы (п. 14)',
  crew: 'более 5 человек одновременно (п. 14)',
  emergency: 'аварийно-восстановительные работы (пп. 14, 18)',
  night: 'работы в ночное время (п. 14)',
  weekend: 'работы в выходные и праздничные дни (п. 14)',
};

export type PermitRules = {
  /** Срок рассмотрения СУА, рабочих дней (п. 14). */
  reviewDays: number;
  /** Срок согласования руководством филиала, рабочих дней. */
  branchDays: number;
  /** Сколько человек одновременно допускается без согласования филиала (п. 14). */
  maxCrew: number;
  /** Ночное время: с … до … (Трудовой кодекс РК — с 22:00 до 06:00). */
  nightFrom: string;
  nightTo: string;
  /** Аварийный порядок: оформленный запрос и письменное разрешение, календарных дней (п. 18). */
  followupDays: number;
};

export const DEFAULT_RULES: PermitRules = {
  reviewDays: 14, branchDays: 3, maxCrew: 5, nightFrom: '22:00', nightTo: '06:00', followupDays: 2,
};

export function normalizeRules(value: unknown): PermitRules {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const int = (x: unknown, d: number, min: number, max: number) =>
    Number.isInteger(x) && (x as number) >= min && (x as number) <= max ? x as number : d;
  const time = (x: unknown, d: string) => (typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : d);
  return {
    reviewDays: int(v.reviewDays, DEFAULT_RULES.reviewDays, 1, 60),
    branchDays: int(v.branchDays, DEFAULT_RULES.branchDays, 0, 30),
    maxCrew: int(v.maxCrew, DEFAULT_RULES.maxCrew, 1, 100),
    nightFrom: time(v.nightFrom, DEFAULT_RULES.nightFrom),
    nightTo: time(v.nightTo, DEFAULT_RULES.nightTo),
    followupDays: int(v.followupDays, DEFAULT_RULES.followupDays, 1, 30),
  };
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Время работ задевает ночь: начало раньше конца ночи, конец позже её начала или работа через полночь. */
export function touchesNight(from: string, to: string, rules: PermitRules = DEFAULT_RULES): boolean {
  const f = minutes(from), t = minutes(to);
  const nightStart = minutes(rules.nightFrom), nightEnd = minutes(rules.nightTo);
  if (t <= f) return true; // через полночь
  return f < nightEnd || t > nightStart;
}

export type RouteInput = {
  workType: WorkType | null;
  onAms: boolean;
  hoursFrom: string;
  hoursTo: string;
  weekendWork: boolean;
  /** Дни периода, ГГГГ-ММ-ДД: есть ли среди них рабочие (по производственному календарю). */
  periodHasWorkingDay: boolean;
  /** Человек в заявке и уже допущенных той же организацией на объект в пересекающийся период. */
  crewSize: number;
  concurrent: number;
};

export type RouteVerdict = {
  /** Ошибки, с которыми заявку отправить нельзя. */
  fields: Record<string, string>;
  /** Почему нужно согласование руководства филиала; пусто — не нужно. */
  branchReasons: BranchReason[];
  emergency: boolean;
};

/** Маршрут заявки по Инструкции: что запрещено и что требует согласования филиала. */
export function route(input: RouteInput, rules: PermitRules = DEFAULT_RULES): RouteVerdict {
  const fields: Record<string, string> = {};
  const reasons = new Set<BranchReason>();
  const w = input.workType;
  if (!w) {
    fields.workType = 'Укажите цель и характер работ';
    return { fields, branchReasons: [], emergency: false };
  }
  const emergency = w === 'emergency';
  if (input.onAms && (w === 'installation' || w === 'replacement')) {
    fields.workType = 'Монтаж и демонтаж оборудования на АМС выполняют только работники Общества (п. 11). ' +
      'Подайте заявку на контроль работ (п. 12)';
  }
  if (input.onAms && (w === 'maintenance' || w === 'emergency' || w === 'supervision')) reasons.add('ams');
  if (w === 'survey') reasons.add('survey');
  if (emergency) reasons.add('emergency');

  const night = touchesNight(input.hoursFrom, input.hoursTo, rules);
  const weekend = input.weekendWork || !input.periodHasWorkingDay;
  if ((night || weekend) && !emergency) {
    fields.workHours = night
      ? `В ночное время (с ${rules.nightFrom} до ${rules.nightTo}) допуск только для аварийно-восстановительных работ (п. 14)`
      : 'В выходные и праздничные дни допуск только для аварийно-восстановительных работ (п. 14)' +
        (input.periodHasWorkingDay ? '' : '. В выбранном периоде нет рабочих дней');
  }
  if (night) reasons.add('night');
  if (weekend) reasons.add('weekend');

  const total = input.crewSize + input.concurrent;
  if (total > rules.maxCrew) reasons.add('crew');
  return { fields, branchReasons: [...reasons], emergency };
}

/* ------------------------------ иностранцы ------------------------------ */

/** Государства СНГ: срок пребывания на объектах — по сроку безвизового пребывания (п. 16). */
export const CIS = ['RU', 'BY', 'AM', 'KG', 'UZ', 'TJ', 'AZ', 'MD'];

export const COUNTRY_NAME: Record<string, string> = {
  KZ: 'Казахстан', RU: 'Россия', BY: 'Беларусь', AM: 'Армения', KG: 'Кыргызстан', UZ: 'Узбекистан',
  TJ: 'Таджикистан', AZ: 'Азербайджан', MD: 'Молдова', TM: 'Туркменистан', GE: 'Грузия', UA: 'Украина',
  MN: 'Монголия', CN: 'Китай', TR: 'Турция', KR: 'Республика Корея', JP: 'Япония', IN: 'Индия', IR: 'Иран',
  AE: 'ОАЭ', DE: 'Германия', FR: 'Франция', IT: 'Италия', ES: 'Испания', GB: 'Великобритания', FI: 'Финляндия',
  SE: 'Швеция', NL: 'Нидерланды', PL: 'Польша', CZ: 'Чехия', AT: 'Австрия', CH: 'Швейцария', US: 'США',
  CA: 'Канада', IL: 'Израиль', LT: 'Литва', LV: 'Латвия', EE: 'Эстония',
};

export const DEFAULT_CIS_DAYS: Record<string, number> = { RU: 90, BY: 90, AM: 90, KG: 90, UZ: 30, TJ: 30, AZ: 30, MD: 30 };

export function normalizeCisDays(value: unknown): Record<string, number> {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CIS_DAYS };
  for (const code of CIS) {
    const n = v[code];
    if (Number.isInteger(n) && (n as number) > 0 && (n as number) <= 365) out[code] = n as number;
  }
  return out;
}

export const isResident = (citizenship: string) => (citizenship || 'KZ').toUpperCase() === 'KZ';
export const isCis = (citizenship: string) => CIS.includes((citizenship || '').toUpperCase());

/** Календарных дней в периоде включительно: 01.10–01.10 — один день. */
export function periodDays(start: string, end: string): number {
  return Math.floor((Date.parse(end.slice(0, 10)) - Date.parse(start.slice(0, 10))) / 86_400_000) + 1;
}

/* --------------------------------- сроки --------------------------------- */

/** Срок допуска не превышает срок действия основания (договора аренды) — пп. 13, 14. */
export function periodWithinBasis(periodEnd: string | null, basisValidUntil: string | null): boolean {
  return !periodEnd || !basisValidUntil || periodEnd.slice(0, 10) <= basisValidUntil;
}
