/**
 * Проверка заявки на допуск перед отправкой (Инструкция о допуске, пп. 13–17;
 * ТЗ портала, §4.1).
 *
 * Бригада: у каждого работника — сведения по Приложению 1 Инструкции и
 * квалификационные документы со сканом и сроком действия; работника с
 * удостоверением, истекающим до начала работ, в заявку включить нельзя. Для
 * иностранцев — копии паспорта и визы, для граждан СНГ — срок безвизового
 * пребывания (п. 16). Несоблюдение требований — основание для отказа (п. 17),
 * поэтому система не даёт отправить неполную заявку. Проверка выполняется на
 * сервере при каждой отправке — обойти её запросом к API напрямую нельзя.
 */

import { validBin } from '../../domain/validation.ts';
import type { BasisVerdict } from './basis.ts';
import {
  DEFAULT_CIS_DAYS, WORK_TYPE_NAME, basisRequired, isCis, isResident, periodDays, periodWithinBasis,
} from './rules.ts';
import type { RouteVerdict, WorkType } from './rules.ts';

/** ИИН проверяется тем же алгоритмом контрольного разряда, что и БИН. */
export const validIin = validBin;

export type DocumentKind = 'qualification' | 'passport' | 'visa';

export type WorkerDocument = {
  id?: string;
  kind?: DocumentKind;
  title: string;
  number?: string;
  validUntil: string;
  fileId?: string | null;
};

export type WorkerForCheck = {
  id: string;
  fullName: string;
  iin: string | null;
  citizenship?: string;
  birthDate?: string | null;
  birthPlace?: string;
  idDocNumber?: string;
  idDocIssuedAt?: string | null;
  idDocIssuedBy?: string;
  address?: string;
  documents: WorkerDocument[];
};

export type CrewIssue = {
  workerId: string;
  fullName: string;
  code: 'no_documents' | 'expired' | 'no_file' | 'invalid_iin' | 'incomplete' | 'no_passport' | 'no_visa' |
    'visa_expired' | 'stay_limit';
  message: string;
  documentId?: string;
};

const fmtDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('.');

export type CrewCheckOptions = {
  /** Окончание работ: до него должны действовать паспорт и виза. */
  endDate?: string | null;
  /** Проверять полноту сведений по Приложению 1 — при отправке. */
  appendix?: boolean;
  cisDays?: Record<string, number>;
};

/** Чего не хватает в сведениях Приложения 1. */
export function appendixGaps(w: WorkerForCheck): string[] {
  const gaps: string[] = [];
  if (!w.birthDate) gaps.push('дата рождения');
  if (!w.birthPlace?.trim()) gaps.push('место рождения');
  if (!w.idDocNumber?.trim()) gaps.push(isResident(w.citizenship ?? 'KZ') ? 'номер удостоверения личности' : 'номер паспорта');
  if (!w.idDocIssuedAt) gaps.push('дата выдачи документа');
  if (!w.idDocIssuedBy?.trim()) gaps.push('кем выдан документ');
  if (!w.address?.trim()) gaps.push('адрес местожительства');
  return gaps;
}

/**
 * Замечания по бригаде на дату начала работ. Пустой список — бригада годится.
 * Без даты начала проверяются только наличие документов и сканов.
 */
export function checkWorkers(workers: WorkerForCheck[], startDate: string | null, options: CrewCheckOptions = {}): CrewIssue[] {
  const issues: CrewIssue[] = [];
  const cisDays = options.cisDays ?? DEFAULT_CIS_DAYS;
  const endDate = options.endDate ?? null;
  for (const w of workers) {
    const issue = (code: CrewIssue['code'], message: string, documentId?: string) =>
      issues.push({ workerId: w.id, fullName: w.fullName, code, message: `${w.fullName}: ${message}`, documentId });
    const citizenship = (w.citizenship || 'KZ').toUpperCase();
    const resident = isResident(citizenship);
    if (resident ? !validIin(w.iin ?? '') : (w.iin && !validIin(w.iin))) issue('invalid_iin', 'ИИН указан с ошибкой');

    const qualifications = w.documents.filter((d) => (d.kind ?? 'qualification') === 'qualification');
    if (!qualifications.length) issue('no_documents', 'нет квалификационных документов');
    for (const d of w.documents) {
      if (!d.fileId) issue('no_file', `к документу «${d.title}» не приложен скан`, d.id);
    }
    for (const d of qualifications) {
      if (startDate && d.validUntil < startDate) {
        issue('expired', `«${d.title}» действует до ${fmtDate(d.validUntil)} — истекает до начала работ`, d.id);
      }
    }
    if (options.appendix) {
      const gaps = appendixGaps(w);
      if (gaps.length) issue('incomplete', `не заполнены сведения Приложения 1 — ${gaps.join(', ')}`);
    }
    if (!resident) {
      // Иностранцы: копия паспорта, а не гражданам СНГ — и визы (п. 16).
      const until = endDate ?? startDate;
      const passport = w.documents.find((d) => d.kind === 'passport');
      if (!passport) issue('no_passport', 'приложите копию паспорта (п. 16)');
      else if (until && passport.validUntil < until) issue('no_passport', `паспорт действует до ${fmtDate(passport.validUntil)} — меньше срока работ`, passport.id);
      if (isCis(citizenship)) {
        const limit = cisDays[citizenship];
        if (limit && startDate && endDate && periodDays(startDate, endDate) > limit) {
          issue('stay_limit', `срок работ превышает срок безвизового пребывания гражданина СНГ — ${limit} дней (п. 16)`);
        }
      } else {
        const visa = w.documents.find((d) => d.kind === 'visa');
        if (!visa) issue('no_visa', 'приложите копию визы (п. 16)');
        else if (until && visa.validUntil < until) issue('visa_expired', `виза действует до ${fmtDate(visa.validUntil)} — меньше срока работ`, visa.id);
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

/** Время суток «ЧЧ:ММ». */
export function clockTime(value: unknown): string | null {
  const text = String(value ?? '').trim().slice(0, 5);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null;
}

export type SubmitInput = {
  workType: WorkType | null;
  facilityId: string | null;
  basisType: string | null;
  basisNumber: string;
  /** Срок действия основания: из реестра либо указанный заявителем. */
  basisValidUntil: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  workers: WorkerForCheck[];
  vehicles: { plate: string }[];
  consent: boolean;
  counterpartyBlocked: boolean;
  basis: BasisVerdict;
  route: RouteVerdict;
  /** Владелец оборудования (арендатор), если заявку подаёт его подрядчик. */
  ownerBin: string;
  letter: { number: string; date: string | null; signatoryName: string; signatoryPosition: string; hasFile: boolean };
  cisDays?: Record<string, number>;
  /** Текущее местное время, «ГГГГ-ММ-ДДTЧЧ:ММ». */
  now: string;
};

/** Ошибки по полям для подсветки в форме и замечания по бригаде. */
export function validateForSubmit(input: SubmitInput): { fields: Record<string, string>; issues: CrewIssue[] } {
  const fields: Record<string, string> = { ...input.route.fields };
  if (input.counterpartyBlocked) {
    fields.counterparty = 'Организация заблокирована: подача заявок на допуск недоступна. Обратитесь в СУА.';
  }
  if (!input.workType) fields.workType = 'Укажите цель и характер работ';
  if (!input.facilityId) fields.facilityId = 'Выберите объект';
  const needBasis = !input.workType || basisRequired(input.workType);
  if (needBasis && !input.basisType) fields.basisType = 'Выберите основание';
  if (input.basisType && !input.basisNumber.trim()) fields.basisNumber = 'Укажите номер основания';
  else if (input.basisType && input.basis.blocking) fields.basis = input.basis.message;
  if (input.ownerBin && !validBin(input.ownerBin)) fields.ownerBin = 'БИН владельца оборудования указан с ошибкой';

  const start = localDateTime(input.periodStart);
  const end = localDateTime(input.periodEnd);
  if (!start) fields.periodStart = 'Укажите дату и время начала работ';
  if (!end) fields.periodEnd = 'Укажите дату и время окончания работ';
  if (start && end && end <= start) fields.periodEnd = 'Окончание работ должно быть позже начала';
  else if (end && end < input.now) fields.periodEnd = 'Период работ уже прошёл';
  else if (end && input.basisType === 'lease' && !periodWithinBasis(end, input.basisValidUntil)) {
    fields.periodEnd = `Срок допуска не может превышать срок действия договора аренды — до ${fmtDate(input.basisValidUntil!)} (пп. 13, 14)`;
  }
  if (input.basisType === 'lease' && !input.basisValidUntil && !input.basis.ok) {
    fields.basisValidUntil = 'Укажите срок действия договора аренды: срок допуска не может его превышать';
  }

  const issues = checkWorkers(input.workers, start ? start.slice(0, 10) : null, {
    endDate: end ? end.slice(0, 10) : null, appendix: true, cisDays: input.cisDays,
  });
  if (!input.workers.length) fields.workers = 'Добавьте в заявку хотя бы одного работника';
  else if (issues.length) fields.workers = issues.map((i) => i.message).join('; ');
  if (input.vehicles.some((v) => !validPlate(v.plate))) fields.vehicles = 'Проверьте госномера транспорта';

  // Официальный запрос, подписанный уполномоченным лицом, со списком по Приложению 1 (п. 13).
  // При аварии допуск даётся по устному согласованию, запрос досылается в течение 2 дней (п. 18).
  if (!input.route.emergency) {
    if (!input.letter.signatoryName.trim()) fields.signatoryName = 'Укажите, кто подписал запрос';
    if (!input.letter.signatoryPosition.trim()) fields.signatoryPosition = 'Укажите должность подписавшего';
    if (!input.letter.number.trim()) fields.letterNumber = 'Укажите исходящий номер запроса';
    if (!input.letter.date) fields.letterDate = 'Укажите дату запроса';
    if (!input.letter.hasFile) {
      fields.letterFile = 'Приложите скан подписанного запроса со списком работников по Приложению 1, заверенным печатью (п. 13)';
    }
  }

  if (!input.consent) {
    fields.consent = 'Подтвердите, что работники дали согласие на обработку персональных данных';
  }
  return { fields, issues };
}

export { WORK_TYPE_NAME };
