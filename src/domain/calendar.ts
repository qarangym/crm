/**
 * Исчисление сроков.
 *
 * Регламент различает рабочие дни (пп. 9, 10, 24, 33, 59, 94), календарные
 * (п. 55 — 90 дней на предоставление оборудования), операционный день (п. 91)
 * и «в день регистрации» (п. 6). Смешивать их нельзя: ранний прототип считал
 * всё календарными днями, из-за чего сроки расходились с Регламентом.
 *
 * Все даты — ISO-строки YYYY-MM-DD в часовом поясе Асия/Алматы.
 */

import type { SlaUnit, WorkCalendar } from './types.ts';
import { EMPTY_CALENDAR } from './types.ts';

const TZ = 'Asia/Almaty';
const DAY_MS = 86_400_000;

/** Текущая дата по Алматы. */
export function today(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

function toUtcNoon(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Выходной по календарю: суббота/воскресенье или праздник, если это не перенесённый рабочий день. */
export function isWorkingDay(iso: string, calendar: WorkCalendar = EMPTY_CALENDAR): boolean {
  const day = toUtcNoon(iso).getUTCDay();
  if (calendar.workingDays.includes(iso)) return true;
  if (calendar.holidays.includes(iso)) return false;
  return day !== 0 && day !== 6;
}

/**
 * Прибавляет рабочие дни. День отсчёта не учитывается: срок «не более 5 рабочих
 * дней со дня поступления» истекает на пятый рабочий день после поступления.
 */
export function addWorkingDays(from: string, count: number, calendar: WorkCalendar = EMPTY_CALENDAR): string {
  if (count <= 0) return from.slice(0, 10);
  const d = toUtcNoon(from);
  let left = count;
  let guard = 0;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(toIso(d), calendar)) left--;
    if (++guard > 10_000) throw new Error('Календарь не содержит рабочих дней');
  }
  return toIso(d);
}

/** Прибавляет календарные дни (Регламент п. 55 — 90 календарных дней). */
export function addCalendarDays(from: string, count: number): string {
  const d = toUtcNoon(from);
  d.setUTCDate(d.getUTCDate() + count);
  return toIso(d);
}

/** Количество рабочих дней между датами, не включая начальную. */
export function workingDaysBetween(from: string, to: string, calendar: WorkCalendar = EMPTY_CALENDAR): number {
  const start = toUtcNoon(from);
  const end = toUtcNoon(to);
  if (end <= start) return 0;
  let n = 0;
  const cursor = new Date(start);
  let guard = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isWorkingDay(toIso(cursor), calendar)) n++;
    if (++guard > 100_000) throw new Error('Слишком большой интервал');
  }
  return n;
}

/** Календарных дней между датами. */
export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((toUtcNoon(to).getTime() - toUtcNoon(from).getTime()) / DAY_MS);
}

/**
 * Контрольная дата по нормативу этапа.
 * `same_day` — тот же день; `operational` приравнен к одному рабочему дню (п. 91).
 */
export function dueDate(
  from: string,
  value: number,
  unit: SlaUnit,
  calendar: WorkCalendar = EMPTY_CALENDAR,
): string | null {
  const start = from.slice(0, 10);
  switch (unit) {
    case 'none':
      return null;
    case 'same_day':
      return start;
    case 'calendar':
      return addCalendarDays(start, value);
    case 'operational':
      return addWorkingDays(start, Math.max(1, value), calendar);
    case 'working':
      return addWorkingDays(start, value, calendar);
  }
}

/** Остаток срока в рабочих днях: отрицательное значение — просрочка. */
export function daysLeft(due: string | null, from: string = today(), calendar: WorkCalendar = EMPTY_CALENDAR): number | null {
  if (!due) return null;
  const target = due.slice(0, 10);
  const start = from.slice(0, 10);
  if (target === start) return 0;
  return target > start
    ? workingDaysBetween(start, target, calendar)
    : -workingDaysBetween(target, start, calendar);
}

/** Просрочен ли срок на указанную дату. */
export function isOverdue(due: string | null, from: string = today()): boolean {
  return !!due && due.slice(0, 10) < from.slice(0, 10);
}
