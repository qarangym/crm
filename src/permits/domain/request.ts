/**
 * Проверка заявки на допуск перед отправкой (ТЗ портала, §4.1; «Бизнес-процессы» v2, процесс 8).
 *
 * Правила бригады из набросков: у каждого работника — квалификационные
 * документы со сканом и сроком действия; работника с документом, истекающим
 * до начала работ, в заявку добавить нельзя. Проверка выполняется на сервере
 * при каждой отправке — обойти её запросом к API напрямую нельзя.
 */

import { validBin } from '../../domain/validation.ts';
import type { BasisVerdict } from './basis.ts';

/** ИИН проверяется тем же алгоритмом контрольного разряда, что и БИН. */
export const validIin = validBin;

export type WorkerDocument = {
  id?: string;
  title: string;
  number?: string;
  validUntil: string;
  fileId?: string | null;
};

export type WorkerForCheck = {
  id: string;
  fullName: string;
  iin: string;
  documents: WorkerDocument[];
};

export type CrewIssue = {
  workerId: string;
  fullName: string;
  code: 'no_documents' | 'expired' | 'no_file' | 'invalid_iin';
  message: string;
  documentId?: string;
};

const fmtDate = (iso: string) => iso.split('-').reverse().join('.');

/**
 * Замечания по бригаде на дату начала работ. Пустой список — бригада годится.
 * Без даты начала проверяются только наличие документов и сканов.
 */
export function checkWorkers(workers: WorkerForCheck[], startDate: string | null): CrewIssue[] {
  const issues: CrewIssue[] = [];
  for (const w of workers) {
    if (!validIin(w.iin)) {
      issues.push({ workerId: w.id, fullName: w.fullName, code: 'invalid_iin', message: `${w.fullName}: ИИН указан с ошибкой` });
    }
    if (!w.documents.length) {
      issues.push({
        workerId: w.id, fullName: w.fullName, code: 'no_documents',
        message: `${w.fullName}: нет квалификационных документов`,
      });
      continue;
    }
    for (const d of w.documents) {
      if (!d.fileId) {
        issues.push({
          workerId: w.id, fullName: w.fullName, code: 'no_file', documentId: d.id,
          message: `${w.fullName}: к документу «${d.title}» не приложен скан`,
        });
      }
      if (startDate && d.validUntil < startDate) {
        issues.push({
          workerId: w.id, fullName: w.fullName, code: 'expired', documentId: d.id,
          message: `${w.fullName}: «${d.title}» действует до ${fmtDate(d.validUntil)} — истекает до начала работ`,
        });
      }
    }
  }
  return issues;
}

/** Госномер без пробелов и дефисов, заглавными буквами. */
export function normalizePlate(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

export function validPlate(value: unknown): boolean {
  return /^[0-9A-ZА-ЯЁ]{4,12}$/.test(normalizePlate(value));
}

/** Местное время объекта: «ГГГГ-ММ-ДДTЧЧ:ММ». */
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function localDateTime(value: unknown): string | null {
  const text = String(value ?? '').trim().replace(' ', 'T').slice(0, 16);
  if (!LOCAL.test(text) || Number.isNaN(Date.parse(text + ':00Z'))) return null;
  return text;
}

export type SubmitInput = {
  facilityId: string | null;
  basisType: string | null;
  basisNumber: string;
  periodStart: string | null;
  periodEnd: string | null;
  workers: WorkerForCheck[];
  vehicles: { plate: string }[];
  consent: boolean;
  counterpartyBlocked: boolean;
  basis: BasisVerdict;
  /** Текущее местное время, «ГГГГ-ММ-ДДTЧЧ:ММ». */
  now: string;
};

/** Ошибки по полям для подсветки в форме и замечания по бригаде. */
export function validateForSubmit(input: SubmitInput): { fields: Record<string, string>; issues: CrewIssue[] } {
  const fields: Record<string, string> = {};
  if (input.counterpartyBlocked) {
    fields.counterparty = 'Организация заблокирована: подача заявок на допуск недоступна. Обратитесь в СУА.';
  }
  if (!input.facilityId) fields.facilityId = 'Выберите объект';
  if (!input.basisType) fields.basisType = 'Выберите тип основания';
  if (!input.basisNumber.trim()) fields.basisNumber = 'Укажите номер основания';
  else if (input.basisType && input.basis.blocking) fields.basis = input.basis.message;

  const start = localDateTime(input.periodStart);
  const end = localDateTime(input.periodEnd);
  if (!start) fields.periodStart = 'Укажите дату и время начала работ';
  if (!end) fields.periodEnd = 'Укажите дату и время окончания работ';
  if (start && end && end <= start) fields.periodEnd = 'Окончание работ должно быть позже начала';
  else if (end && end < input.now) fields.periodEnd = 'Период работ уже прошёл';

  const issues = checkWorkers(input.workers, start ? start.slice(0, 10) : null);
  if (!input.workers.length) fields.workers = 'Добавьте в бригаду хотя бы одного работника';
  else if (issues.length) fields.workers = issues.map((i) => i.message).join('; ');
  if (input.vehicles.some((v) => !validPlate(v.plate))) fields.vehicles = 'Проверьте госномера транспорта';

  if (!input.consent) {
    fields.consent = 'Подтвердите, что работники дали согласие на обработку персональных данных';
  }
  return { fields, issues };
}
