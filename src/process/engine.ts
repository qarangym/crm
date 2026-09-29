/**
 * Процессный движок: применение переходов, исчисление сроков, эскалация.
 *
 * Движок ничего не знает о базе данных и интерфейсе — он получает снимок
 * заявки и возвращает описание изменений. Это позволяет покрыть правила
 * Регламента тестами без поднятия приложения.
 */

import type { CustomerStatus, OwnerParty, Service, SlaUnit, WorkCalendar } from '../domain/types.ts';
import { EMPTY_CALENDAR, OWNER_PARTY_NAME } from '../domain/types.ts';
import { addWorkingDays, dueDate, isOverdue, today, workingDaysBetween } from '../domain/calendar.ts';
import type { StageCode } from './stages.ts';
import { nextMainStage, stage } from './stages.ts';
import type { GuardFailure, GuardInput, GuardResult, RequestSnapshot } from './transitions.ts';
import { checkTransition, findTransition, paidAtFor } from './transitions.ts';

/** Запись о нахождении заявки на этапе — строка таблицы `request_stages`. */
export type StageRecord = {
  requestId: number;
  stageCode: StageCode;
  enteredAt: string;
  leftAt: string | null;
  dueAt: string | null;
  slaValue: number;
  slaUnit: SlaUnit;
  ownerParty: OwnerParty;
  /** Продление срока: основание обязательно (пп. 33, 45). */
  extendedBy: number;
  extensionReason: string | null;
  escalationLevel: 0 | 1 | 2;
  breached: boolean;
};

export type ProcessEvent = {
  kind: 'stage_entered' | 'stage_left' | 'escalation' | 'remark' | 'note';
  requestId: number;
  stageCode: StageCode;
  at: string;
  message: string;
  regulationRef?: string;
};

export type TransitionOutcome = {
  request: RequestSnapshot;
  closed: StageRecord | null;
  opened: StageRecord;
  events: ProcessEvent[];
};

export type EngineContext = {
  calendar?: WorkCalendar;
  now?: string;
};

const STAGE_SERVICE: Partial<Record<StageCode, Service>> = { tu: 'ТУ', psd: 'ПСД', smr_prep: 'СМР', smr: 'СМР' };

/**
 * Дата, от которой отсчитывается норматив этапа.
 * Регламент пп. 24, 33 — срок услуги считается с даты полной оплаты договора
 * этой услуги; п. 59 — СМР выполняются со дня передачи оборудования по акту
 * **и** перечисления 100 % оплаты по договору на СМР, то есть от более поздней
 * из двух дат. Безвозмездная услуга (п. 20) отсчитывается от перехода.
 */
export function stageStartDate(r: RequestSnapshot, code: StageCode, at: string): string {
  const service = STAGE_SERVICE[code];
  const paidAt = service ? paidAtFor(r, service) : null;
  if (code === 'tu' || code === 'psd' || code === 'smr_prep') {
    return paidAt ?? at;
  }
  if (code === 'smr') {
    const dates = [at, paidAt, r.transferActApprovedDate].filter(Boolean) as string[];
    return dates.sort().at(-1) ?? at;
  }
  // П. 94: 10 рабочих дней на замечания — с даты получения АВР Заказчиком.
  if (code === 'closing') return r.avrSentAt ?? at;
  return at;
}

/** Открыть этап: вычислить контрольную дату по нормативу. */
export function openStage(
  r: RequestSnapshot,
  code: StageCode,
  at: string,
  calendar: WorkCalendar = EMPTY_CALENDAR,
): StageRecord {
  const def = stage(code);
  const start = stageStartDate(r, code, at);
  return {
    requestId: r.id,
    stageCode: code,
    enteredAt: at,
    leftAt: null,
    dueAt: dueDate(start, def.slaValue, def.slaUnit, calendar),
    slaValue: def.slaValue,
    slaUnit: def.slaUnit,
    ownerParty: def.ownerParty,
    extendedBy: 0,
    extensionReason: null,
    escalationLevel: 0,
    breached: false,
  };
}

/** Проверить переход, не применяя его. */
export function canTransition(r: RequestSnapshot, to: StageCode, input: GuardInput = {}): GuardResult {
  return checkTransition(r, to, input);
}

/**
 * Применить переход. Бросает исключение, если условия Регламента не выполнены:
 * движок не позволяет обойти нормы, даже если переход инициирован из интерфейса.
 */
export function applyTransition(
  r: RequestSnapshot,
  current: StageRecord | null,
  to: StageCode,
  input: GuardInput = {},
  ctx: EngineContext = {},
): TransitionOutcome {
  const calendar = ctx.calendar ?? EMPTY_CALENDAR;
  const at = ctx.now ?? today();
  const check = checkTransition(r, to, input);
  if (!check.ok) {
    const text = check.failures.map((f) => `${f.message} (${f.regulationRef})`).join('; ');
    throw new TransitionError(text, check.failures);
  }

  const def = findTransition(r.stageCode, to)!;
  const events: ProcessEvent[] = [];

  let closed: StageRecord | null = null;
  if (current) {
    closed = { ...current, leftAt: at, breached: isOverdue(current.dueAt, at) };
    events.push({
      kind: 'stage_left',
      requestId: r.id,
      stageCode: current.stageCode,
      at,
      message: closed.breached
        ? `Этап «${stage(current.stageCode).name}» завершён с нарушением срока`
        : `Этап «${stage(current.stageCode).name}» завершён в срок`,
      regulationRef: stage(current.stageCode).regulationRef,
    });
  }

  const next = { ...r, stageCode: to };
  const opened = openStage(next, to, at, calendar);
  events.push({
    kind: 'stage_entered',
    requestId: r.id,
    stageCode: to,
    at,
    message: `${def.title}. Норматив: ${stage(to).slaText}. Отвечает: ${OWNER_PARTY_NAME[stage(to).ownerParty]}`,
    regulationRef: def.regulationRef,
  });

  if (input.reason) {
    events.push({ kind: 'note', requestId: r.id, stageCode: to, at, message: input.reason });
  }

  return { request: next, closed, opened, events };
}

export class TransitionError extends Error {
  failures: GuardFailure[];
  constructor(message: string, failures: GuardFailure[]) {
    super(message);
    this.name = 'TransitionError';
    this.failures = failures;
  }
}

/**
 * Продление срока этапа.
 * Регламент п. 33 — разработка ПСД может быть продлена не более чем на
 * 15 рабочих дней с письменным уведомлением Заказчика. Для прочих этапов
 * продление возможно только по договору или допсоглашению (пп. 45, 64),
 * поэтому основание обязательно всегда.
 */
export const MAX_PSD_EXTENSION_DAYS = 15;

export function extendStage(
  record: StageRecord,
  days: number,
  reason: string,
  calendar: WorkCalendar = EMPTY_CALENDAR,
): StageRecord {
  if (!reason || !reason.trim()) {
    throw new Error('Укажите основание продления срока (пп. 33, 45)');
  }
  if (days <= 0) throw new Error('Продление должно быть положительным');
  if (record.stageCode === 'psd' && record.extendedBy + days > MAX_PSD_EXTENSION_DAYS) {
    throw new Error(`Разработка ПСД продлевается не более чем на ${MAX_PSD_EXTENSION_DAYS} рабочих дней (п. 33)`);
  }
  if (!record.dueAt) throw new Error('У этапа нет контрольной даты');
  return {
    ...record,
    dueAt: addWorkingDays(record.dueAt, days, calendar),
    extendedBy: record.extendedBy + days,
    extensionReason: reason.trim(),
  };
}

/**
 * Срок, нарушение которого эскалируется по п. 100.
 *
 * Пункт 100 говорит о нарушении сроков **филиалом**. Просрочки Заказчика
 * (оплата, оборудование, приёмка), ОР ПСД и бухгалтерии в эскалацию не
 * попадают: их учитывают показатели по ответственной стороне.
 */
export type EscalationSubject = {
  dueAt: string | null;
  /** Этап завершён либо на служебную записку получен ответ. */
  closed: boolean;
  /** За срок отвечает филиал. */
  branchDeadline: boolean;
  /** Уже отправленный уровень. */
  level: number;
  /** Дата уведомления первого уровня — от неё отсчитываются 2 рабочих дня. */
  level1At: string | null;
};

/** Сроки этапа эскалируются, только если этап ведёт филиал. */
export function isBranchDeadline(record: Pick<StageRecord, 'ownerParty'>): boolean {
  return record.ownerParty === 'branch';
}

/**
 * Уровень эскалации, который нужно отправить сейчас; 0 — ничего отправлять не нужно.
 *
 * Регламент п. 100: первый уровень — в день выявления нарушения срока
 * (уведомление курирующему заместителю директора филиала с копией директору);
 * второй — если нарушение не устранено в течение 2 рабочих дней **с даты
 * направления уведомления первого уровня** (курирующему члену Правления).
 */
export function nextEscalationLevel(
  subject: EscalationSubject,
  at: string = today(),
  calendar: WorkCalendar = EMPTY_CALENDAR,
): 0 | 1 | 2 {
  if (!subject.branchDeadline || subject.closed || !subject.dueAt) return 0;
  if (!isOverdue(subject.dueAt, at)) return 0;
  if (subject.level === 0) return 1;
  if (subject.level === 1 && subject.level1At &&
      workingDaysBetween(subject.level1At, at, calendar) >= 2) return 2;
  return 0;
}

/** Событие эскалации для журнала. */
export function escalationEvent(requestId: number, stageCode: StageCode, level: 1 | 2, at: string): ProcessEvent {
  return {
    kind: 'escalation',
    requestId,
    stageCode,
    at,
    message:
      level === 1
        ? 'Эскалация 1-го уровня: уведомление курирующему заместителю директора филиала с копией директору'
        : 'Эскалация 2-го уровня: информирование курирующего члена Правления',
    regulationRef: 'п. 100',
  };
}

/**
 * Статус для Заказчика (ТЗ №10) — проекция этапа.
 * Открытые замечания переводят заявку в «Требуются уточнения» независимо от этапа.
 */
export function customerStatus(r: RequestSnapshot): CustomerStatus {
  if (r.openRemarks > 0 && !stage(r.stageCode).terminal) return 'clarification';
  return stage(r.stageCode).customerStatus;
}

/**
 * Следующий этап основного маршрута с учётом состава услуг.
 * Этапы неназначенных услуг пропускаются (Регламент п. 7.5 — услуг может быть несколько).
 */
export function suggestNextStage(r: RequestSnapshot): StageCode | null {
  return nextMainStage(r.stageCode, r.services);
}

/** Признак просрочки текущего этапа. */
export function isStageOverdue(record: StageRecord | null, at: string = today()): boolean {
  return !!record && !record.leftAt && isOverdue(record.dueAt, at);
}

/** Услуги, для которых этап уже пройден, — для отображения маршрута заявки. */
export function routeFor(services: Service[]): StageCode[] {
  const route: StageCode[] = [];
  let code: StageCode | null = 'draft';
  const guard = new Set<StageCode>();
  while (code && !guard.has(code)) {
    guard.add(code);
    route.push(code);
    code = nextMainStage(code, services);
    if (code === 'closed_done') {
      route.push(code);
      break;
    }
  }
  return route;
}
