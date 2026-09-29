import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assessCapacity, pickTier } from '../src/process/capacity.ts';
import type { CapacityTier } from '../src/process/capacity.ts';

const tiers: CapacityTier[] = [
  { id: 't66', heightM: 66, capacityKg: 2800, occupiedKg: 1800 },
  { id: 't58', heightM: 58, capacityKg: 3200, occupiedKg: 2340 },
  { id: 't48', heightM: 48, capacityKg: 3500, occupiedKg: 1600 },
];
const ams = { kind: 'ams', passportLoadKg: 9500, powerInputKw: 15, freeAreaM2: null };
const tenants = [{ weightKg: 100, windageM2: 1.5, powerKw: 6 }, { weightKg: null, windageM2: 0.5, powerKw: 3 }];
const req = (over = {}) => ({ placement: 'ams' as const, weightKg: 48, windageM2: 1.2, powerKw: 2.4, areaM2: 0, heightM: 60, ...over });

test('ярус: явно выбранный, иначе ближайший к высоте размещения', () => {
  assert.equal(pickTier(tiers, 60)?.id, 't58');
  assert.equal(pickTier(tiers, 70)?.id, 't66');
  assert.equal(pickTier(tiers, 60, 't48')?.id, 't48');
  assert.equal(pickTier(tiers, null), null);
  assert.equal(pickTier([], 60), null);
});

test('достаточная ёмкость по объекту, ярусу и мощности (п. 16.2)', () => {
  const r = assessCapacity({ facility: ams, tiers, tenants, request: req(), nearLimitPercent: null });
  assert.equal(r.verdict, 'ok');
  const byKey = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(byKey.object_load.before, 5740);
  assert.equal(byKey.object_load.after, 5788);
  assert.equal(byKey.tier_load.after, 2388);
  assert.equal(byKey.power.after, 11.4);
  assert.equal(byKey.windage.ok, null, 'допустимая парусность не ведётся — только для сведения');
  assert.equal(r.nearLimit, null);
});

test('превышение ярусной нагрузки — ТВ нет (п. 16.2, табл. 1)', () => {
  const r = assessCapacity({ facility: ams, tiers, tenants, request: req({ weightKg: 900 }), nearLimitPercent: null });
  assert.equal(r.verdict, 'insufficient');
  assert.equal(r.checks.find((c) => c.key === 'tier_load')!.ok, false);
  assert.match(r.message, /2 рабочих дня/);
});

test('ровно на пределе — ещё в пределах', () => {
  const r = assessCapacity({ facility: ams, tiers, tenants, request: req({ weightKg: 860 }), nearLimitPercent: null });
  const tier = r.checks.find((c) => c.key === 'tier_load')!;
  assert.equal(tier.after, 3200);
  assert.equal(tier.ok, true);
  assert.equal(tier.percent, 100);
});

test('нехватка мощности — ТВ нет', () => {
  const r = assessCapacity({ facility: ams, tiers, tenants, request: req({ powerKw: 7 }), nearLimitPercent: null });
  assert.equal(r.verdict, 'insufficient');
  assert.equal(r.checks.find((c) => c.key === 'power')!.ok, false);
});

test('паспортное значение [ЗАПОЛНИТЬ] не подменяется — «не определено» (Прил. 8, п. 16.4)', () => {
  const r = assessCapacity({
    facility: { ...ams, passportLoadKg: null }, tiers: [{ ...tiers[1], capacityKg: null }], tenants,
    request: req(), nearLimitPercent: null,
  });
  assert.equal(r.verdict, 'unknown');
  assert.match(r.message, /поверочный расчёт/);
  assert.ok(r.checks.filter((c) => c.ok === null).length >= 2);
});

test('превышение важнее неполноты данных', () => {
  const r = assessCapacity({
    facility: { ...ams, passportLoadKg: null }, tiers, tenants, request: req({ powerKw: 50 }), nearLimitPercent: null,
  });
  assert.equal(r.verdict, 'insufficient');
});

test('порог приближения — только из настройки (п. 16.4)', () => {
  const near = assessCapacity({ facility: ams, tiers, tenants, request: req({ weightKg: 700 }), nearLimitPercent: 90 });
  assert.equal(near.verdict, 'ok');
  assert.equal(near.nearLimit, true, 'ярус 58 м загружен на 95 %');
  const far = assessCapacity({ facility: ams, tiers, tenants, request: req(), nearLimitPercent: 90 });
  assert.equal(far.nearLimit, false);
});

test('РТС и помещения — по площади и мощности (п. 17)', () => {
  const room = { kind: 'rts', passportLoadKg: null, powerInputKw: 20, freeAreaM2: 12 };
  const ok = assessCapacity({ facility: room, tiers: [], tenants, request: req({ placement: 'room', areaM2: 4 }), nearLimitPercent: null });
  assert.deepEqual(ok.checks.map((c) => c.key), ['area', 'power']);
  assert.equal(ok.verdict, 'ok');
  assert.equal(ok.checks[1].regulationRef, 'п. 17');
  const tooBig = assessCapacity({ facility: room, tiers: [], tenants, request: req({ placement: 'room', areaM2: 15 }), nearLimitPercent: null });
  assert.equal(tooBig.verdict, 'insufficient');
});
