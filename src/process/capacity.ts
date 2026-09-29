/**
 * Оценка технической возможности размещения (Регламент раздел 4, Приложение 8).
 *
 * п. 16.2 — параметры оборудования Заказчика (вес, парусность, потребляемая
 * мощность) сверяются со свободной ёмкостью АМС по несущей способности и
 * электроснабжению; п. 17 — для РТС и помещений оценка по свободной площади и
 * свободной мощности.
 *
 * Расчёт — подсказка инженеру, а не решение: п. 16.4 требует поверочного
 * расчёта «при приближении к предельным значениям», но числа не называет, а
 * часть паспортных значений Приложения 8 помечена [ЗАПОЛНИТЬ]. Поэтому:
 *   - при отсутствии паспортного значения проверка не выдумывает его, а
 *     возвращает «не определено» (null);
 *   - порог «приближения» берётся из настройки и по умолчанию не задан;
 *   - допустимая парусность в мастер-файле не ведётся — суммарная парусность
 *     показывается для сведения, решение по ней принимает инженер.
 *
 * Масса и мощность позиции заявки берутся как указаны в форме — это
 * суммарные значения размещаемого комплекта.
 */

export type CapacityFacility = {
  kind: string;
  passportLoadKg: number | null;
  powerInputKw: number | null;
  freeAreaM2: number | null;
};

export type CapacityTier = { id: string; heightM: number; capacityKg: number | null; occupiedKg: number };
export type CapacityTenant = { weightKg: number | null; windageM2: number | null; powerKw: number | null };

export type CapacityRequest = {
  placement: 'ams' | 'room';
  weightKg: number;
  windageM2: number;
  powerKw: number;
  areaM2: number;
  /** Высота размещения из заявки — по ней выбирается ярус. */
  heightM: number | null;
  /** Ярус, выбранный инженером явно. */
  tierId?: string | null;
};

export type CapacityCheck = {
  key: 'object_load' | 'tier_load' | 'power' | 'area' | 'windage';
  label: string;
  /** Загрузка до и после размещения, предел; null — предел не задан в мастер-файле. */
  before: number;
  after: number;
  limit: number | null;
  percent: number | null;
  /** true — в пределах; false — превышение; null — нельзя проверить. */
  ok: boolean | null;
  regulationRef: string;
};

export type CapacityResult = {
  verdict: 'ok' | 'insufficient' | 'unknown';
  tier: { id: string; heightM: number } | null;
  checks: CapacityCheck[];
  /** Хотя бы одна проверка дошла до порога приближения; null — порог не задан. */
  nearLimit: boolean | null;
  nearLimitPercent: number | null;
  message: string;
};

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + (Number(x) || 0), 0);

function check(
  key: CapacityCheck['key'], label: string, before: number, add: number, limit: number | null, ref: string,
): CapacityCheck {
  const after = round(before + add, 2);
  if (limit === null || !(limit > 0)) {
    return { key, label, before: round(before, 2), after, limit: null, percent: null, ok: null, regulationRef: ref };
  }
  return {
    key, label, before: round(before, 2), after, limit,
    percent: round((after / limit) * 100), ok: after <= limit, regulationRef: ref,
  };
}

/** Ярус: выбранный инженером, иначе ближайший к высоте размещения из заявки. */
export function pickTier(tiers: CapacityTier[], heightM: number | null, tierId?: string | null): CapacityTier | null {
  if (!tiers.length) return null;
  if (tierId) return tiers.find((t) => t.id === tierId) ?? null;
  if (heightM === null || !Number.isFinite(heightM)) return null;
  return [...tiers].sort((a, b) => Math.abs(a.heightM - heightM) - Math.abs(b.heightM - heightM))[0];
}

export function assessCapacity(input: {
  facility: CapacityFacility;
  tiers: CapacityTier[];
  tenants: CapacityTenant[];
  request: CapacityRequest;
  nearLimitPercent: number | null;
}): CapacityResult {
  const { facility, tiers, tenants, request } = input;
  const powerUsed = sum(tenants.map((t) => t.powerKw));
  const checks: CapacityCheck[] = [];
  let tier: CapacityTier | null = null;

  const roomLike = request.placement === 'room' || ['rts', 'room'].includes(facility.kind);
  if (roomLike) {
    // п. 17: для РТС и помещений — свободная площадь и свободная мощность.
    checks.push(check('area', 'Площадь размещения, м²', 0, request.areaM2, facility.freeAreaM2, 'п. 17'));
  } else {
    // п. 16.2: несущая способность объекта и яруса, парусность, мощность.
    const objectLoad = sum(tiers.map((t) => t.occupiedKg));
    checks.push(check('object_load', 'Нагрузка на объект, кг', objectLoad, request.weightKg, facility.passportLoadKg, 'п. 16.2'));
    tier = pickTier(tiers, request.heightM, request.tierId);
    checks.push(tier
      ? check('tier_load', `Нагрузка на ярус ${tier.heightM} м, кг`, tier.occupiedKg, request.weightKg, tier.capacityKg, 'п. 16.2')
      : { key: 'tier_load', label: 'Нагрузка на ярус, кг', before: 0, after: request.weightKg, limit: null, percent: null, ok: null, regulationRef: 'п. 16.2' });
    checks.push(check('windage', 'Парусность, м² (для сведения)', sum(tenants.map((t) => t.windageM2)), request.windageM2, null, 'п. 16.2'));
  }
  checks.push(check('power', 'Потребляемая мощность, кВт', powerUsed, request.powerKw, facility.powerInputKw,
    roomLike ? 'п. 17' : 'п. 16.2'));

  // Парусность не участвует в вердикте: допустимое значение в мастер-файле не ведётся.
  const decisive = checks.filter((c) => c.key !== 'windage');
  const failed = decisive.filter((c) => c.ok === false);
  const unknown = decisive.filter((c) => c.ok === null);
  const verdict: CapacityResult['verdict'] = failed.length ? 'insufficient' : unknown.length ? 'unknown' : 'ok';

  const threshold = input.nearLimitPercent;
  const nearLimit = threshold === null ? null
    : decisive.some((c) => c.percent !== null && c.percent >= threshold && c.ok !== false);

  const message = verdict === 'insufficient'
    ? `Превышение: ${failed.map((c) => `${c.label.toLowerCase()} — ${c.percent} %`).join('; ')}. ` +
      'Мотивированный отказ — в срок 2 рабочих дня (табл. 1), либо уточнение данных у филиала (п. 10).'
    : verdict === 'unknown'
      ? `В мастер-файле не заполнено: ${unknown.map((c) => c.label.toLowerCase()).join('; ')}. ` +
        'Требуется запрос в филиал либо поверочный расчёт — решение принимает инженер (п. 16.4).'
      : 'Свободной ёмкости достаточно. Решение о поверочном расчёте принимает инженер' +
        (nearLimit ? `: загрузка достигла порога ${threshold} % (п. 16.4).` : ' — числовой порог Регламентом не установлен (п. 16.4).');

  return {
    verdict, tier: tier ? { id: tier.id, heightM: tier.heightM } : null,
    checks, nearLimit, nearLimitPercent: threshold, message,
  };
}
