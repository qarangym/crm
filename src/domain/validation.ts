/**
 * Проверка заявки.
 *
 * ТЗ ОР ПСД:
 *  №4 — контроль заполнения всех обязательных полей до отправки;
 *  №5 — выявление бессмысленных значений (наборы букв вместо чисел, прочерки,
 *       повторяющиеся символы, фиктивные значения, значения вне диапазона).
 * Регламент п. 7 — состав сведений заявки; п. 19 — основания не принимать заявку.
 *
 * Правила перенесены из прототипа QTR CRM и дополнены: контрольная сумма БИН,
 * несколько услуг в одной заявке (Регламент п. 7.5).
 */

import type { Placement, RequestService, Service } from './types.ts';
import { SERVICES } from './types.ts';

export type FieldErrors = Record<string, string>;

const LETTERS = /[A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]/;
const REPEATED = /(.)\1{4,}/;
const JUNK = /^(test|тест|qwerty|asdf|йцукен|фыва|нет|null|undefined|aaa|xxx|---|н\/д|na)$/i;
const DASHES_ONLY = /^[-—–\s.]+$/;

/** Осмысленный текст: есть буквы, нет повторов и заглушек (ТЗ №5). */
export function validText(value: unknown, min = 3): boolean {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > 1000) return false;
  if (DASHES_ONLY.test(s)) return false;
  if (!LETTERS.test(s)) return false;
  if (REPEATED.test(s)) return false;
  if (JUNK.test(s)) return false;
  return true;
}

/**
 * БИН/ИИН Республики Казахстан: 12 цифр с контрольным разрядом.
 * Прототип проверял только длину — этого недостаточно для ТЗ №5.
 */
export function validBin(value: unknown): boolean {
  const s = String(value ?? '').trim();
  if (!/^\d{12}$/.test(s)) return false;
  if (/^(\d)\1{11}$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  const sum = (w: number[]) => w.reduce((acc, k, i) => acc + k * digits[i], 0);
  let control = sum(w1) % 11;
  if (control === 10) control = sum(w2) % 11;
  if (control === 10) return false;
  return control === digits[11];
}

export function validEmail(value: unknown): boolean {
  const s = String(value ?? '').trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/** Казахстанский номер: 11 цифр, начинается с 7, без однообразных последовательностей. */
export function validPhone(value: unknown): boolean {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(digits)) return false;
  if (/(\d)\1{7}/.test(digits)) return false;
  return true;
}

type NumRule = { key: string; label: string; max: number; allowZero?: boolean; integer?: boolean };

function checkNumber(params: Record<string, unknown>, rule: NumRule, errors: FieldErrors, prefix: string) {
  const raw = params[rule.key];
  const n = Number(raw);
  const min = rule.allowZero ? 0 : 0.000001;
  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n) || n < min || n > rule.max) {
    errors[`${prefix}${rule.key}`] = `${rule.label}: ${rule.allowZero ? 'от 0' : 'больше 0'} до ${rule.max}`;
    return;
  }
  if (rule.integer && !Number.isInteger(n)) {
    errors[`${prefix}${rule.key}`] = `${rule.label}: укажите целое число`;
  }
}

/** Реквизиты Заказчика — Регламент п. 7.1, 7.3. */
export function validateApplicant(form: Record<string, unknown>): FieldErrors {
  const e: FieldErrors = {};
  if (!validText(form.company, 3)) e.company = 'Укажите наименование организации';
  if (!validBin(form.bin)) e.bin = 'БИН/ИИН: 12 цифр, проверьте контрольный разряд';
  if (!validText(form.contact, 3)) e.contact = 'Укажите Ф.И.О. ответственного лица';
  if (!validEmail(form.email)) e.email = 'Укажите корректный адрес электронной почты';
  if (!validPhone(form.phone)) e.phone = 'Номер в формате +7 7XX XXX XX XX';
  return e;
}

/** Объект размещения — Регламент п. 16.1 (объект определяется по адресу в мастер-файле). */
export function validateFacility(form: Record<string, unknown>): FieldErrors {
  const e: FieldErrors = {};
  if (!form.facilityId) e.facilityId = 'Выберите объект из справочника';
  return e;
}

/** Параметры одной услуги заявки. */
export function validateService(item: RequestService, index: number): FieldErrors {
  const e: FieldErrors = {};
  const p = `services.${index}.`;
  const params = item.params ?? {};

  if (!SERVICES.includes(item.service)) {
    e[`${p}service`] = 'Выберите вид услуги';
    return e;
  }
  const placements: Placement[] = ['ams', 'room', 'network', 'cable', 'power'];
  if (!placements.includes(item.placement)) {
    e[`${p}placement`] = 'Выберите сценарий размещения';
    return e;
  }

  if (!validText(params.scope, 12)) e[`${p}scope`] = 'Опишите состав и объём работ';

  if (item.placement === 'network') {
    // Присоединение технических средств теле-, радиоканала — Приложение 1 Регламента.
    if (item.service !== 'ТУ') {
      e[`${p}placement`] = 'Присоединение к сети телерадиовещания оформляется только как ТУ';
    }
    if (!validText(params.channel, 2)) e[`${p}channel`] = 'Укажите наименование телерадиоканала';
    if (!validText(params.signalType, 2)) e[`${p}signalType`] = 'Укажите тип сигнала';
    if (!validText(params.deliveryPoint, 3)) e[`${p}deliveryPoint`] = 'Укажите точку доведения сигнала';
    checkNumber(params, { key: 'bitrate', label: 'Информационная скорость, Мбит/с', max: 100000 }, e, p);
  } else {
    if (!validText(params.equipment, 5)) e[`${p}equipment`] = 'Укажите модель и назначение оборудования';
    checkNumber(params, { key: 'quantity', label: 'Количество, шт.', max: 10000, integer: true }, e, p);
    checkNumber(params, { key: 'power', label: 'Потребляемая мощность, кВт', max: 100000, allowZero: true }, e, p);

    if (item.placement === 'ams') {
      // Регламент п. 16.2 — вес, парусность, потребляемая мощность.
      checkNumber(params, { key: 'weight', label: 'Масса, кг', max: 100000 }, e, p);
      checkNumber(params, { key: 'windage', label: 'Парусность, м²', max: 10000 }, e, p);
      checkNumber(params, { key: 'height', label: 'Высота размещения, м', max: 1000 }, e, p);
    }
    if (item.placement === 'room') {
      // Регламент п. 17 — для РТС и помещений оценка по свободной площади и мощности.
      checkNumber(params, { key: 'area', label: 'Площадь размещения, м²', max: 100000 }, e, p);
    }
    if (item.placement === 'cable') {
      checkNumber(params, { key: 'length', label: 'Протяжённость кабеля, м', max: 100000 }, e, p);
      if (!validText(params.route, 8)) e[`${p}route`] = 'Опишите маршрут и способ прокладки';
    }
  }

  if (item.service === 'ПСД' && !validText(params.designTask, 12)) {
    // Регламент п. 32 — задание на проектирование (Приложение 2 к договору).
    e[`${p}designTask`] = 'Укажите задание на проектирование';
  }
  if (item.service === 'СМР' && !String(item.basisReference ?? '').trim()) {
    // Регламент п. 53 — договор на СМР не ранее утверждения сметной документации.
    e[`${p}basisReference`] = 'Укажите номер утверждённой ПСД или иного основания для СМР';
  }
  if (item.tariffId) {
    checkNumber({ tariffQuantity: item.tariffQuantity }, { key: 'tariffQuantity', label: 'Количество услуг', max: 10000, integer: true }, e, p);
  }
  return e;
}

export type RequestDraft = {
  company?: unknown;
  bin?: unknown;
  contact?: unknown;
  email?: unknown;
  phone?: unknown;
  facilityId?: unknown;
  services?: RequestService[];
  attachments?: unknown[];
};

/**
 * Полная проверка заявки.
 * `draft = true` — сохранение черновика: проверяется только минимум,
 * чтобы заявку можно было отложить и дозаполнить (ТЗ №10, статус «Черновик»).
 */
export function validateRequest(form: RequestDraft, draft = false): FieldErrors {
  const errors: FieldErrors = {};
  const services = form.services ?? [];

  if (!validText(form.company, 3)) errors.company = 'Укажите наименование организации';
  if (services.length === 0) errors.services = 'Выберите хотя бы одну услугу';

  const seen = new Set<Service>();
  for (const item of services) {
    if (seen.has(item.service)) {
      errors.services = 'Услуга указана дважды: объедините параметры в одной позиции';
    }
    seen.add(item.service);
  }

  if (draft) return errors;

  Object.assign(errors, validateApplicant(form as Record<string, unknown>));
  Object.assign(errors, validateFacility(form as Record<string, unknown>));
  services.forEach((item, i) => Object.assign(errors, validateService(item, i)));
  return errors;
}

export const hasErrors = (e: FieldErrors): boolean => Object.keys(e).length > 0;
