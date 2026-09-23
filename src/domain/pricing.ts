/**
 * Предварительная стоимость.
 *
 * Регламент:
 *  п. 18 — ТУ выдаются согласно действующему Прейскуранту;
 *  п. 20 — выдача ТУ на присоединение к сети телерадиовещания безвозмездна;
 *  п. 21 — «в случае если заявка включает несколько позиций, стоимость
 *          рассчитывается как сумма стоимости всех указанных услуг»;
 *  п. 49 — стоимость СМР формируется исключительно на основании утверждённой
 *          сметной документации, по РСНБ.
 *
 * ТЗ №3 — Заказчик видит ориентировочную стоимость при заполнении заявки.
 * Расчёт не является коммерческим предложением: КП формирует ОР ПСД после
 * подтверждения технической возможности (п. 21).
 */

import type { RequestService, Tariff } from './types.ts';
import { today } from './calendar.ts';

export type PriceLine = {
  service: RequestService['service'];
  title: string;
  /** null — стоимость не определяется на этапе заявки (СМР, п. 49). */
  amount: number | null;
  quantity: number;
  /** Основание: пункт Прейскуранта либо пункт Регламента для безвозмездных услуг. */
  source: string;
};

export type PriceEstimate = {
  lines: PriceLine[];
  /** Сумма определённых позиций (п. 21). */
  total: number;
  /** Есть позиции, стоимость которых на этапе заявки не определяется. */
  hasUndetermined: boolean;
  /** Текст оговорки для интерфейса. */
  disclaimer: string;
};

export const ESTIMATE_DISCLAIMER =
  'Ориентировочная стоимость. Не является коммерческим предложением и офертой: ' +
  'стоимость определяется ОР ПСД в коммерческом предложении после подтверждения ' +
  'технической возможности (Регламент п. 21).';

/** Действует ли позиция прейскуранта на дату. */
export function isTariffEffective(tariff: Tariff, on: string = today()): boolean {
  if (tariff.effectiveFrom > on) return false;
  if (tariff.effectiveTo && tariff.effectiveTo < on) return false;
  return true;
}

/** Безвозмездная услуга: ТУ на присоединение к сети телерадиовещания (п. 20). */
export function isFreeOfCharge(item: RequestService): boolean {
  return item.service === 'ТУ' && item.placement === 'network';
}

export function priceLine(item: RequestService, tariffs: Tariff[], on: string = today()): PriceLine {
  if (isFreeOfCharge(item)) {
    return {
      service: item.service,
      title: 'ТУ на присоединение к сети телерадиовещания',
      amount: 0,
      quantity: 1,
      source: 'Регламент п. 20 — безвозмездно при подтверждённой ТВ',
    };
  }
  if (item.service === 'СМР') {
    return {
      service: item.service,
      title: 'Строительно-монтажные работы',
      amount: null,
      quantity: 1,
      source: 'Регламент п. 49 — по утверждённой сметной документации',
    };
  }
  const tariff = item.tariffId ? tariffs.find((t) => t.id === item.tariffId) : undefined;
  if (!tariff) {
    return {
      service: item.service,
      title: item.service === 'ТУ' ? 'Технические условия' : 'Проектно-сметная документация',
      amount: null,
      quantity: 1,
      source: 'Позиция прейскуранта не выбрана — стоимость уточнит ОР ПСД',
    };
  }
  if (tariff.service !== item.service || !isTariffEffective(tariff, on)) {
    throw new Error('Выбранная позиция прейскуранта недоступна на указанную дату');
  }
  const quantity = Number(item.tariffQuantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Количество услуг должно быть целым положительным числом');
  }
  return {
    service: item.service,
    title: tariff.name,
    amount: Math.round(tariff.amount * quantity * 100) / 100,
    quantity,
    source: tariff.source,
  };
}

/** Смета заявки целиком: сумма всех позиций (п. 21). */
export function estimate(services: RequestService[], tariffs: Tariff[], on: string = today()): PriceEstimate {
  const lines = services.map((item) => priceLine(item, tariffs, on));
  const total = lines.reduce((sum, line) => sum + (line.amount ?? 0), 0);
  return {
    lines,
    total: Math.round(total * 100) / 100,
    hasUndetermined: lines.some((line) => line.amount === null),
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

export function formatMoney(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'По прейскуранту';
  if (amount === 0) return 'Безвозмездно';
  return `${new Intl.NumberFormat('ru-RU').format(amount)} ₸`;
}
