import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkCalendar } from '../src/domain/types.ts';
import { routeFor, applyTransition, canTransition, customerStatus, extendStage, openStage, pendingEscalations, requiredEscalationLevel, stageStartDate } from '../src/process/engine.ts';
import type { StageRecord } from '../src/process/engine.ts';
import { BOARD_STAGES, appliesTo, nextMainStage, stage } from '../src/process/stages.ts';
import type { RequestSnapshot } from '../src/process/transitions.ts';
import { transitionsFrom } from '../src/process/transitions.ts';
import { boardColumns, breakdownByParty, bottlenecks, requestCycle, stageMetrics } from '../src/process/metrics.ts';
import { AUTOMATION_RULES } from '../src/process/rules.ts';

const calendar: WorkCalendar = { holidays: [], workingDays: [] };
const ctx = { calendar, now: '2026-09-21' };

function makeRequest(over: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    id: 1,
    stageCode: 'tv_review',
    services: ['ТУ'],
    number: 'ЗК-2026-0001',
    incomingNumber: 'вх-1201',
    incomingDate: '2026-09-21',
    tvStatus: 'confirmed',
    masterFileVersion: '2026-09-01',
    verificationCalcDecision: 'not_required',
    contractNumber: null,
    freeOfCharge: false,
    paidAt: null,
    estimateApproved: false,
    orderNumber: null,
    transferActApprovedDate: null,
    avrApproved: false,
    avrSentAt: null,
    closingConfirmed: false,
    resultDelivered: false,
    openRemarks: 0,
    ...over,
  };
}

/* ------------------------- маршрут по составу услуг ------------------------- */

test('этапы услуг пропускаются, если услуга не заказана (п. 7.5)', () => {
  assert.equal(appliesTo('psd', ['ТУ']), false);
  assert.equal(appliesTo('psd', ['ТУ', 'ПСД']), true);
  assert.equal(nextMainStage('awaiting_payment', ['ТУ']), 'tu');
  assert.equal(nextMainStage('tu', ['ТУ']), 'avr', 'без ПСД и СМР следующий этап — оформление АВР');
  assert.equal(nextMainStage('tu', ['ТУ', 'СМР']), 'smr_prep');
});

test('маршрут заявки на три услуги проходит все этапы', () => {
  const route = routeFor(['ТУ', 'ПСД', 'СМР']);
  assert.deepEqual(route, [
    'draft', 'registered', 'tv_review', 'offer', 'awaiting_payment',
    'tu', 'psd', 'smr_prep', 'smr', 'avr', 'closing', 'closed_done',
  ]);
});

test('маршрут заявки только на ТУ короче', () => {
  const route = routeFor(['ТУ']);
  assert.ok(!route.includes('psd'));
  assert.ok(!route.includes('smr'));
  assert.ok(route.includes('tu'));
});

/* ---------------------- оценка технической возможности ---------------------- */

test('без подтверждённой ТВ переход к КП запрещён (п. 16.3)', () => {
  const r = makeRequest({ tvStatus: 'pending' });
  const check = canTransition(r, 'offer');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'tv_not_confirmed'));
});

test('без версии мастер-файла переход к КП запрещён (п. 16.5)', () => {
  const r = makeRequest({ masterFileVersion: '  ' });
  const check = canTransition(r, 'offer');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.regulationRef.includes('16.5')));
});

test('решение о поверочном расчёте обязательно, порог система не задаёт (п. 16.4)', () => {
  const undecided = canTransition(makeRequest({ verificationCalcDecision: null }), 'offer');
  assert.equal(undecided.ok, false);
  assert.ok(!undecided.ok && undecided.failures.some((f) => f.code === 'verification_undecided'));

  const pending = canTransition(makeRequest({ verificationCalcDecision: 'required' }), 'offer');
  assert.equal(pending.ok, false);

  const done = canTransition(makeRequest({ verificationCalcDecision: 'done' }), 'offer');
  assert.equal(done.ok, true);
});

test('отказ без мотивированной причины невозможен (п. 19, табл. 1)', () => {
  const r = makeRequest({ tvStatus: 'unavailable' });
  assert.equal(canTransition(r, 'closed_rejected').ok, false);
  assert.equal(canTransition(r, 'closed_rejected', { reason: 'Паспортная нагрузка яруса исчерпана' }).ok, true);
});

/* ------------------------------ оплата и услуги ----------------------------- */

test('начать оказание услуги без 100 % предоплаты нельзя (пп. 86, 89)', () => {
  const r = makeRequest({ stageCode: 'awaiting_payment', contractNumber: 'ДП-101/26' });
  const check = canTransition(r, 'tu');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'not_paid'));
});

test('ТУ на присоединение к сети выдаются без оплаты (п. 20)', () => {
  const r = makeRequest({
    stageCode: 'awaiting_payment', services: ['ТУ'],
    contractNumber: 'безвозмездно, п. 20', freeOfCharge: true,
  });
  assert.equal(canTransition(r, 'tu').ok, true);
});

test('вид услуги «ТУ» сам по себе от оплаты не освобождает (пп. 20, 86)', () => {
  const onAms = makeRequest({
    stageCode: 'awaiting_payment', services: ['ТУ'],
    contractNumber: 'ДП-101/26', freeOfCharge: false,
  });
  const check = canTransition(onAms, 'tu');
  assert.equal(check.ok, false, 'ТУ на размещение оборудования платные по Прейскуранту');
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'not_paid'));
});

test('заявка с платными позициями требует оплаты целиком (п. 86)', () => {
  const r = makeRequest({ stageCode: 'awaiting_payment', services: ['ТУ', 'ПСД'], contractNumber: 'ДП-101/26' });
  assert.equal(canTransition(r, 'psd').ok, false);
});

test('договор на СМР не ранее утверждения сметной документации (пп. 49, 53)', () => {
  const r = makeRequest({
    stageCode: 'awaiting_payment',
    services: ['СМР'],
    contractNumber: 'ДП-101/26',
    paidAt: '2026-09-18',
    estimateApproved: false,
  });
  const check = canTransition(r, 'smr_prep');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'estimate_not_approved'));
});

test('СМР не начинаются без завизированного акта и распоряжения (пп. 58, 60)', () => {
  const r = makeRequest({ stageCode: 'smr_prep', services: ['СМР'], paidAt: '2026-09-01', estimateApproved: true });
  const check = canTransition(r, 'smr');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'no_transfer_act'));
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'no_order'));

  const ready = makeRequest({
    stageCode: 'smr_prep', services: ['СМР'], paidAt: '2026-09-01',
    estimateApproved: true, transferActApprovedDate: '2026-09-15', orderNumber: 'Р-77',
  });
  assert.equal(canTransition(ready, 'smr').ok, true);
});

test('срок СМР считается от более поздней из дат оплаты и акта (п. 59)', () => {
  const late = makeRequest({ paidAt: '2026-09-01', transferActApprovedDate: '2026-09-15' });
  assert.equal(stageStartDate(late, 'smr', '2026-09-10'), '2026-09-15');

  const paidLater = makeRequest({ paidAt: '2026-09-20', transferActApprovedDate: '2026-09-15' });
  assert.equal(stageStartDate(paidLater, 'smr', '2026-09-10'), '2026-09-20');
});

/* ------------------------- применение перехода и сроки ---------------------- */

test('переход открывает этап с контрольной датой по нормативу (п. 9)', () => {
  const r = makeRequest({ stageCode: 'registered' });
  const current = openStage(r, 'registered', '2026-09-21', calendar);
  const out = applyTransition(r, current, 'tv_review', {}, ctx);
  assert.equal(out.request.stageCode, 'tv_review');
  assert.equal(out.opened.dueAt, '2026-09-28', '5 рабочих дней');
  assert.equal(out.opened.ownerParty, 'orpsd');
  assert.equal(out.closed?.leftAt, '2026-09-21');
});

test('переход с невыполненными условиями бросает ошибку и не меняет заявку', () => {
  const r = makeRequest({ tvStatus: 'pending' });
  assert.throws(() => applyTransition(r, null, 'offer', {}, ctx), /Техническая возможность не подтверждена/);
});

test('непредусмотренный переход отклоняется', () => {
  const r = makeRequest({ stageCode: 'registered' });
  const check = canTransition(r, 'smr');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures[0].code === 'no_transition');
});

test('из этапа ожидания оплаты есть выход по оферте (табл. 1)', () => {
  const r = makeRequest({ stageCode: 'awaiting_payment', contractNumber: 'ДП-101/26' });
  assert.equal(canTransition(r, 'closed_expired', { offerExpired: false }).ok, false);
  assert.equal(canTransition(r, 'closed_expired', { offerExpired: true }).ok, true);

  const paid = makeRequest({ stageCode: 'awaiting_payment', paidAt: '2026-09-18' });
  assert.equal(canTransition(paid, 'closed_expired', { offerExpired: true }).ok, false, 'оплаченную заявку закрыть по оферте нельзя');
});

test('закрытие возможно по подтверждению либо по истечении 10 рабочих дней молчания (п. 94)', () => {
  const r = makeRequest({ stageCode: 'closing', avrApproved: true, avrSentAt: '2026-09-01' });
  assert.equal(canTransition(r, 'closed_done').ok, false);
  assert.equal(canTransition(r, 'closed_done', { silenceAccepted: true }).ok, true);
  assert.equal(canTransition({ ...r, closingConfirmed: true }, 'closed_done').ok, true);
});

test('АВР должен быть завизирован и направлен Заказчику (пп. 66, 91)', () => {
  const r = makeRequest({ stageCode: 'avr', services: ['СМР'], transferActApprovedDate: '2026-09-15' });
  const check = canTransition(r, 'closing');
  assert.equal(check.ok, false);
  assert.ok(!check.ok && check.failures.some((f) => f.code === 'no_avr'));
});

/* ------------------------------- продление срока ---------------------------- */

test('продление ПСД не более 15 рабочих дней и только с основанием (п. 33)', () => {
  const r = makeRequest({ stageCode: 'psd', services: ['ПСД'], paidAt: '2026-09-21' });
  const record = openStage(r, 'psd', '2026-09-21', calendar);
  assert.throws(() => extendStage(record, 10, '   ', calendar), /основание/);
  const extended = extendStage(record, 10, 'Письменное уведомление Заказчика исх. 145', calendar);
  assert.equal(extended.extendedBy, 10);
  assert.ok(extended.dueAt! > record.dueAt!);
  assert.throws(() => extendStage(extended, 10, 'Ещё раз'), /не более чем на 15/);
});

/* --------------------------------- эскалация -------------------------------- */

test('эскалация первого уровня — в день выявления просрочки (п. 100)', () => {
  const r = makeRequest();
  const record = openStage(r, 'tv_review', '2026-09-21', calendar); // срок 28.09
  assert.equal(requiredEscalationLevel(record, '2026-09-28', calendar), 0, 'в день срока нарушения нет');
  assert.equal(requiredEscalationLevel(record, '2026-09-29', calendar), 1);
});

test('эскалация второго уровня — через 2 рабочих дня (п. 100)', () => {
  const r = makeRequest();
  const record = openStage(r, 'tv_review', '2026-09-21', calendar);
  assert.equal(requiredEscalationLevel(record, '2026-09-30', calendar), 2);
});

test('уже отправленная эскалация повторно не формируется', () => {
  const r = makeRequest();
  const record = { ...openStage(r, 'tv_review', '2026-09-21', calendar), escalationLevel: 1 as const };
  const first = pendingEscalations([record], '2026-09-29', calendar);
  assert.equal(first.length, 0, 'первый уровень уже отправлен');
  const second = pendingEscalations([record], '2026-09-30', calendar);
  assert.equal(second.length, 1);
  assert.equal(second[0].level, 2);
  assert.match(second[0].event.message, /члена Правления/);
});

/* ------------------------- статус для Заказчика (ТЗ №10) -------------------- */

test('открытые замечания переводят заявку в «Требуются уточнения» (ТЗ №11)', () => {
  assert.equal(customerStatus(makeRequest()), 'review');
  assert.equal(customerStatus(makeRequest({ openRemarks: 2 })), 'clarification');
  assert.equal(customerStatus(makeRequest({ stageCode: 'closed_done' })), 'done');
  assert.equal(customerStatus(makeRequest({ stageCode: 'closed_expired' })), 'rejected');
});

test('каждый этап имеет норматив, ответственную сторону и ссылку на пункт', () => {
  for (const def of BOARD_STAGES) {
    assert.ok(def.regulationRef, `${def.code}: нет ссылки на пункт`);
    assert.ok(def.ownerParty, `${def.code}: не указана ответственная сторона`);
    assert.ok(def.slaText, `${def.code}: не указан норматив`);
  }
});

test('из каждого нетерминального этапа есть хотя бы один переход', () => {
  for (const def of BOARD_STAGES) {
    if (def.code === 'draft') continue;
    const out = transitionsFrom(def.code, ['ТУ', 'ПСД', 'СМР']);
    assert.ok(out.length > 0, `${def.code}: тупик`);
  }
});

test('из этапа оценки ТВ есть выход при отказе — заявка не зависает', () => {
  const out = transitionsFrom('tv_review', ['ТУ']).map((t) => t.to);
  assert.ok(out.includes('closed_rejected'));
});

/* --------------------------------- аналитика -------------------------------- */

function record(over: Partial<StageRecord>): StageRecord {
  return {
    requestId: 1,
    stageCode: 'tv_review',
    enteredAt: '2026-09-01',
    leftAt: '2026-09-08',
    dueAt: '2026-09-08',
    slaValue: 5,
    slaUnit: 'working',
    ownerParty: 'orpsd',
    extendedBy: 0,
    extensionReason: null,
    escalationLevel: 0,
    breached: false,
    ...over,
  };
}

test('показатели этапа: медиана против норматива', () => {
  const records = [
    record({ requestId: 1, enteredAt: '2026-09-01', leftAt: '2026-09-15', breached: true }),
    record({ requestId: 2, enteredAt: '2026-09-01', leftAt: '2026-09-15', breached: true }),
    record({ requestId: 3, enteredAt: '2026-09-01', leftAt: '2026-09-16', breached: true }),
  ];
  const metrics = stageMetrics(records, '2026-09-21', calendar).find((m) => m.stageCode === 'tv_review')!;
  assert.equal(metrics.completed, 3);
  assert.equal(metrics.medianDays, 10);
  assert.equal(metrics.slaRatio, 2, 'вдвое дольше норматива');
  assert.equal(metrics.breachShare, 1);
});

test('узкое место определяется превышением норматива', () => {
  const slow = [1, 2, 3].map((id) => record({ requestId: id, enteredAt: '2026-09-01', leftAt: '2026-09-16', breached: true }));
  const fast = [4, 5, 6].map((id) => record({ requestId: id, stageCode: 'offer', slaValue: 1, slaUnit: 'operational', enteredAt: '2026-09-01', leftAt: '2026-09-02' }));
  const found = bottlenecks(stageMetrics([...slow, ...fast], '2026-09-21', calendar));
  assert.equal(found[0].stageCode, 'tv_review');
  assert.ok(!found.some((m) => m.stageCode === 'offer'));
});

test('просрочки разносятся по ответственной стороне, а не валятся на ОР ПСД', () => {
  const records = [
    record({ requestId: 1, stageCode: 'awaiting_payment', ownerParty: 'customer', slaValue: 10, enteredAt: '2026-09-01', leftAt: '2026-09-21', dueAt: '2026-09-15', breached: true }),
    record({ requestId: 2, stageCode: 'smr', ownerParty: 'branch', slaValue: 15, enteredAt: '2026-08-01', leftAt: '2026-09-10', dueAt: '2026-08-24', breached: true }),
    record({ requestId: 3, stageCode: 'tv_review', ownerParty: 'orpsd', enteredAt: '2026-09-01', leftAt: '2026-09-07', dueAt: '2026-09-08', breached: false }),
  ];
  const rows = breakdownByParty(records, '2026-09-21', calendar);
  const byParty = Object.fromEntries(rows.map((r) => [r.ownerParty, r]));
  assert.equal(byParty.customer.overdue, 1);
  assert.equal(byParty.branch.overdue, 1);
  assert.equal(byParty.orpsd.overdue, 0);
});

test('цикл заявки выделяет время на стороне Заказчика', () => {
  const records = [
    record({ stageCode: 'tv_review', ownerParty: 'orpsd', enteredAt: '2026-09-01', leftAt: '2026-09-08' }),
    record({ stageCode: 'awaiting_payment', ownerParty: 'customer', enteredAt: '2026-09-08', leftAt: '2026-09-22', slaValue: 10 }),
  ];
  const cycle = requestCycle(records, '2026-09-22', calendar)!;
  assert.equal(cycle.customerDays, 10);
  assert.equal(cycle.internalDays, 5);
  assert.equal(cycle.totalDays, 15);
});

test('колонки доски считают карточки и просрочки', () => {
  const open = [
    record({ requestId: 1, leftAt: null, dueAt: '2026-09-15' }),
    record({ requestId: 2, leftAt: null, dueAt: '2026-09-30' }),
  ];
  const columns = boardColumns(open, '2026-09-21');
  const tv = columns.find((c) => c.stageCode === 'tv_review')!;
  assert.equal(tv.count, 2);
  assert.equal(tv.overdue, 1);
  assert.equal(tv.regulationRef, stage('tv_review').regulationRef);
});

test('каждое правило автоматизации ссылается на пункт Регламента', () => {
  assert.equal(AUTOMATION_RULES.length, 21);
  for (const rule of AUTOMATION_RULES) {
    assert.match(rule.regulationRef, /п\./, `Правило ${rule.id} без ссылки на пункт`);
    assert.ok(rule.description.length > 20);
  }
  const ids = AUTOMATION_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы правил должны быть уникальны');
});
