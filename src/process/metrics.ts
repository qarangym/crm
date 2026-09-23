/**
 * Аналитика прозрачности: где заявки стоят дольше норматива и кто держит срок.
 *
 * Главная задача проекта — руководство видит слабые места. Узкое место
 * определяется как этап, фактическое время на котором устойчиво превышает
 * норматив Регламента. Считать это можно только по таблице `request_stages`
 * со временем входа и выхода: по текстовому журналу такие цифры не получить.
 */

import type { OwnerParty, WorkCalendar } from '../domain/types.ts';
import { EMPTY_CALENDAR } from '../domain/types.ts';
import { calendarDaysBetween, isOverdue, today, workingDaysBetween } from '../domain/calendar.ts';
import type { StageRecord } from './engine.ts';
import type { StageCode } from './stages.ts';
import { BOARD_STAGES, stage } from './stages.ts';

/** Фактическая длительность нахождения на этапе в единицах его норматива. */
export function stageDuration(record: StageRecord, at: string = today(), calendar: WorkCalendar = EMPTY_CALENDAR): number {
  const end = record.leftAt ?? at;
  return record.slaUnit === 'calendar'
    ? calendarDaysBetween(record.enteredAt, end)
    : workingDaysBetween(record.enteredAt, end, calendar);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

export type StageMetrics = {
  stageCode: StageCode;
  name: string;
  ownerParty: OwnerParty;
  slaValue: number;
  slaText: string;
  regulationRef: string;
  /** Завершённых прохождений этапа в выборке. */
  completed: number;
  /** Заявок, находящихся на этапе сейчас. */
  inProgress: number;
  avgDays: number;
  medianDays: number;
  p80Days: number;
  /** Доля прохождений с нарушением норматива, 0..1. */
  breachShare: number;
  /** Отношение медианы к нормативу: >1 — этап систематически не укладывается. */
  slaRatio: number | null;
};

/** Показатели по каждому этапу. Сортировка — по порядку этапов. */
export function stageMetrics(
  records: StageRecord[],
  at: string = today(),
  calendar: WorkCalendar = EMPTY_CALENDAR,
): StageMetrics[] {
  return BOARD_STAGES.map((def) => {
    const all = records.filter((r) => r.stageCode === def.code);
    const finished = all.filter((r) => r.leftAt);
    const durations = finished.map((r) => stageDuration(r, at, calendar)).sort((a, b) => a - b);
    const breached = finished.filter((r) => r.breached).length;
    const median = quantile(durations, 0.5);
    return {
      stageCode: def.code,
      name: def.name,
      ownerParty: def.ownerParty,
      slaValue: def.slaValue,
      slaText: def.slaText,
      regulationRef: def.regulationRef,
      completed: finished.length,
      inProgress: all.filter((r) => !r.leftAt).length,
      avgDays: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0,
      medianDays: Math.round(median * 10) / 10,
      p80Days: Math.round(quantile(durations, 0.8) * 10) / 10,
      breachShare: finished.length ? Math.round((breached / finished.length) * 100) / 100 : 0,
      slaRatio: def.slaValue > 0 && durations.length ? Math.round((median / def.slaValue) * 100) / 100 : null,
    };
  });
}

/**
 * Узкие места: этапы с нормативом, где медиана превышает его в `threshold` раз
 * либо доля нарушений выше `breachLimit`. Отсортированы по тяжести.
 */
export function bottlenecks(
  metrics: StageMetrics[],
  options: { threshold?: number; breachLimit?: number; minSample?: number } = {},
): StageMetrics[] {
  const threshold = options.threshold ?? 1;
  const breachLimit = options.breachLimit ?? 0.2;
  const minSample = options.minSample ?? 3;
  return metrics
    .filter((m) => m.completed >= minSample && m.slaValue > 0)
    .filter((m) => (m.slaRatio ?? 0) > threshold || m.breachShare > breachLimit)
    .sort((a, b) => (b.slaRatio ?? 0) - (a.slaRatio ?? 0));
}

export type PartyBreakdown = {
  ownerParty: OwnerParty;
  /** Просроченных этапов, закреплённых за стороной. */
  overdue: number;
  /** Всего прохождений этапов этой стороны. */
  total: number;
  /** Суммарно дней сверх норматива. */
  excessDays: number;
};

/**
 * Разбивка просрочек по ответственной стороне.
 *
 * Без неё отчётность выглядит так, будто сроки срывает ОР ПСД, тогда как
 * этапы ожидания оплаты (п. 86), предоставления оборудования (п. 55) и
 * рассмотрения АВР (п. 94) закреплены за Заказчиком, а выполнение СМР —
 * за филиалом (п. 59).
 */
export function breakdownByParty(
  records: StageRecord[],
  at: string = today(),
  calendar: WorkCalendar = EMPTY_CALENDAR,
): PartyBreakdown[] {
  const map = new Map<OwnerParty, PartyBreakdown>();
  for (const record of records) {
    const key = record.ownerParty;
    const row = map.get(key) ?? { ownerParty: key, overdue: 0, total: 0, excessDays: 0 };
    row.total++;
    const overdue = record.leftAt ? record.breached : isOverdue(record.dueAt, at);
    if (overdue) {
      row.overdue++;
      const spent = stageDuration(record, at, calendar);
      const norm = record.slaValue + record.extendedBy;
      if (spent > norm) row.excessDays += spent - norm;
    }
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.overdue - a.overdue);
}

export type RequestCycle = {
  requestId: number;
  /** Рабочих дней от подачи до закрытия либо до текущей даты. */
  totalDays: number;
  /** Из них — время на стороне Заказчика. */
  customerDays: number;
  /** Время подразделений Общества. */
  internalDays: number;
  closed: boolean;
};

/** Полный цикл заявки с выделением времени Заказчика. */
export function requestCycle(
  records: StageRecord[],
  at: string = today(),
  calendar: WorkCalendar = EMPTY_CALENDAR,
): RequestCycle | null {
  if (records.length === 0) return null;
  const sorted = [...records].sort((a, b) => a.enteredAt.localeCompare(b.enteredAt));
  const first = sorted[0];
  const last = sorted.at(-1)!;
  const end = last.leftAt ?? at;
  let customerDays = 0;
  let internalDays = 0;
  for (const record of sorted) {
    const days = stageDuration(record, at, calendar);
    if (record.ownerParty === 'customer') customerDays += days;
    else internalDays += days;
  }
  return {
    requestId: first.requestId,
    totalDays: workingDaysBetween(first.enteredAt, end, calendar),
    customerDays,
    internalDays,
    closed: !!last.leftAt && stage(last.stageCode).terminal,
  };
}

export type BoardColumn = {
  stageCode: StageCode;
  name: string;
  short: string;
  slaText: string;
  ownerParty: OwnerParty;
  regulationRef: string;
  count: number;
  overdue: number;
};

/** Колонки доски со счётчиками. */
export function boardColumns(openRecords: StageRecord[], at: string = today()): BoardColumn[] {
  return BOARD_STAGES.map((def) => {
    const items = openRecords.filter((r) => r.stageCode === def.code && !r.leftAt);
    return {
      stageCode: def.code,
      name: def.name,
      short: def.short,
      slaText: def.slaText,
      ownerParty: def.ownerParty,
      regulationRef: def.regulationRef,
      count: items.length,
      overdue: items.filter((r) => isOverdue(r.dueAt, at)).length,
    };
  });
}
