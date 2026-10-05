/**
 * Проверка основания для допуска (ТЗ портала, §4.2; План модуля допусков, §5.3).
 *
 * Основание ищется в данных, которые система ведёт: ТУ, акты приёма-передачи и
 * распоряжения Общества — в архиве документов, договоры на СМР — в договорах
 * модуля ОР ПСД, договоры аренды — в реестре договоров аренды СУА. Если договора
 * аренды в реестре нет, прикладывается скан, а специалист СУА подтверждает
 * основание вручную и вносит договор в реестр.
 *
 * Режим задаётся для каждого типа отдельно:
 *   мягкий  — не найдено или истекло: предупреждение, заявку можно отправить,
 *             специалист СУА подтверждает основание вручную;
 *   строгий — не найдено или истекло: отправить заявку нельзя.
 * Здесь только решение по найденной записи; поиск — в слое данных.
 */

export type BasisType = 'lease' | 'tu' | 'smr_contract' | 'transfer_act' | 'order';

export const BASIS_TYPES: readonly BasisType[] = ['lease', 'tu', 'smr_contract', 'transfer_act', 'order'];

export const BASIS_NAME: Record<BasisType, string> = {
  lease: 'Договор аренды',
  tu: 'Технические условия',
  smr_contract: 'СМР по договору',
  transfer_act: 'Акт приёма-передачи оборудования',
  order: 'Распоряжение Общества на выполнение монтажных работ',
};

export type BasisMode = 'soft' | 'strict';
export type BasisModes = Record<BasisType, BasisMode>;

export const DEFAULT_MODES: BasisModes = { lease: 'soft', tu: 'soft', smr_contract: 'soft', transfer_act: 'soft', order: 'soft' };

/** Типы, для которых в системе есть реестр: по каждому возможен строгий режим. */
export const REGISTRY_BACKED: readonly BasisType[] = ['lease', 'tu', 'smr_contract', 'transfer_act', 'order'];

export function isBasisType(value: unknown): value is BasisType {
  return typeof value === 'string' && (BASIS_TYPES as readonly string[]).includes(value);
}

/** Режимы из настройки: неизвестные значения заменяются мягким режимом. */
export function normalizeModes(value: unknown): BasisModes {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_MODES };
  for (const type of BASIS_TYPES) {
    if (source[type] === 'strict' && REGISTRY_BACKED.includes(type)) out[type] = 'strict';
  }
  return out;
}

/** Запись реестра, выбранная в форме или найденная по номеру. */
export type BasisRecord = {
  id: string;
  number: string;
  counterpartyId: string | null;
  facilityId: string | null;
  /** Документ завизирован; договор подписан. */
  approved: boolean;
  /** Договор расторгнут. */
  terminated: boolean;
  validUntil: string | null;
};

export type BasisInput = {
  type: BasisType | null;
  number: string;
  counterpartyId: string;
  facilityId: string | null;
  /** Дата начала работ, ГГГГ-ММ-ДД: на неё основание должно действовать. */
  startDate: string | null;
  /** Приложен скан основания. */
  hasScan: boolean;
};

export type BasisCode =
  | 'ok' | 'missing' | 'no_registry' | 'not_found' | 'foreign' | 'other_facility'
  | 'not_approved' | 'terminated' | 'expired';

export type BasisVerdict = {
  code: BasisCode;
  /** Основание подтверждено реестром системы. */
  ok: boolean;
  /** Отправить заявку нельзя. */
  blocking: boolean;
  /** Основание подтверждает специалист СУА вручную до одобрения. */
  needsConfirmation: boolean;
  /** Для подтверждения нужен скан основания. */
  needsScan: boolean;
  mode: BasisMode;
  message: string;
  reference: { id: string; number: string; validUntil: string | null } | null;
};

const fmtDate = (iso: string) => iso.split('-').reverse().join('.');

const NOT_FOUND: Record<BasisType, string> = {
  lease: 'Договор аренды с таким номером в реестре договоров аренды не найден',
  tu: 'Технические условия с таким номером у вашей организации в системе не найдены',
  smr_contract: 'Договор на СМР с таким номером у вашей организации в системе не найден',
  transfer_act: 'Акт приёма-передачи по этому объекту и вашей организации в архиве не найден',
  order: 'Распоряжение Общества с таким номером в архиве не найдено',
};

/** Без записи в реестре заявка идёт по скану основания: его проверит специалист СУА. */
const SCAN_WHEN_MISSING: readonly BasisType[] = ['lease', 'transfer_act'];

function problemOf(input: BasisInput, found: BasisRecord | null): { code: BasisCode; message: string } | null {
  const type = input.type as BasisType;
  if (!found) return { code: 'not_found', message: NOT_FOUND[type] };
  // Распоряжение — внутренний документ Общества: проверяется объект, а не организация.
  if (type !== 'order' && found.counterpartyId !== input.counterpartyId) {
    return { code: 'foreign', message: `Основание № ${found.number} оформлено на другую организацию` };
  }
  if ((type === 'transfer_act' || type === 'order' || type === 'lease') && input.facilityId && found.facilityId &&
      found.facilityId !== input.facilityId) {
    return { code: 'other_facility', message: `${BASIS_NAME[type]} № ${found.number} относится к другому объекту` };
  }
  if (!found.approved) {
    return {
      code: 'not_approved',
      message: type === 'smr_contract' || type === 'lease'
        ? `Договор № ${found.number} ещё не подписан`
        : `${BASIS_NAME[type]} № ${found.number} ещё не завизированы в архиве`,
    };
  }
  if (found.terminated) return { code: 'terminated', message: `Договор № ${found.number} расторгнут` };
  if (found.validUntil && input.startDate && found.validUntil < input.startDate) {
    return {
      code: 'expired',
      message: `Срок действия основания № ${found.number} истёк ${fmtDate(found.validUntil)} — раньше начала работ`,
    };
  }
  return null;
}

export function verifyBasis(input: BasisInput, found: BasisRecord | null, modes: BasisModes = DEFAULT_MODES): BasisVerdict {
  const base = { ok: false, blocking: true, needsConfirmation: false, needsScan: false, reference: null };
  if (!input.type || !input.number.trim()) {
    return { ...base, code: 'missing', mode: 'soft', message: 'Укажите тип и номер основания' };
  }
  const mode = modes[input.type];

  const reference = found ? { id: found.id, number: found.number, validUntil: found.validUntil } : null;
  const problem = problemOf(input, found);
  if (!problem) {
    return {
      code: 'ok', ok: true, blocking: false, needsConfirmation: false, needsScan: false, mode, reference,
      message: `Основание найдено: ${BASIS_NAME[input.type]} № ${found!.number}` +
        (found!.validUntil ? `, действует до ${fmtDate(found!.validUntil)}` : ''),
    };
  }
  if (mode === 'strict') {
    return { ...base, code: problem.code, mode, reference, message: `${problem.message} — заявку отправить нельзя` };
  }
  // Мягкий режим. Без договора аренды или акта в реестре заявка идёт по скану.
  const needsScan = SCAN_WHEN_MISSING.includes(input.type);
  const blocking = needsScan && !input.hasScan;
  return {
    code: problem.code, ok: false, blocking, needsConfirmation: true, needsScan, mode, reference,
    message: blocking
      ? `${problem.message}. Приложите скан ${input.type === 'lease' ? 'договора' : 'акта'} — специалист СУА подтвердит его вручную`
      : `${problem.message}. Специалист СУА проверит основание вручную`,
  };
}
