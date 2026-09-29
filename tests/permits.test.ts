/**
 * Портал допусков: проверки без базы — основание, бригада, заявка перед
 * отправкой, права ролей. Сценарии — из критериев приёмки набросков
 * (ТЗ портала §6.2, «План реализации» v4, §1.7–1.8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODES, normalizeModes, verifyBasis } from '../src/permits/domain/basis.ts';
import type { BasisInput, BasisRecord } from '../src/permits/domain/basis.ts';
import {
  checkWorkers, localDateTime, normalizePlate, validIin, validPlate, validateForSubmit,
} from '../src/permits/domain/request.ts';
import type { SubmitInput } from '../src/permits/domain/request.ts';
import { localNow } from '../src/permits/server/routes.ts';
import * as rbac from '../src/server/rbac.ts';
import { checkUser } from '../src/server/users.ts';
import type { Actor } from '../src/server/rbac.ts';
import type { Role } from '../src/domain/types.ts';

const IIN = '850101300124';
const CP = 'cp-1';
const FACILITY = 'f-1';

const input = (over: Partial<BasisInput> = {}): BasisInput => ({
  type: 'tu', number: 'ТУ-15', counterpartyId: CP, facilityId: FACILITY, startDate: '2026-10-10', hasScan: false, ...over,
});
const record = (over: Partial<BasisRecord> = {}): BasisRecord => ({
  id: 'd-1', number: 'ТУ-15', counterpartyId: CP, facilityId: FACILITY, approved: true, terminated: false,
  validUntil: '2027-03-01', ...over,
});
const strict = { ...DEFAULT_MODES, tu: 'strict', smr_contract: 'strict', transfer_act: 'strict' } as const;

/* ------------------------------- основание ------------------------------- */

test('основание: без типа или номера отправить нельзя', () => {
  const v = verifyBasis(input({ number: ' ' }), null);
  assert.equal(v.code, 'missing');
  assert.equal(v.blocking, true);
});

test('основание: действующие ТУ своей организации проходят без ручного подтверждения', () => {
  const v = verifyBasis(input(), record());
  assert.equal(v.code, 'ok');
  assert.equal(v.ok, true);
  assert.equal(v.blocking, false);
  assert.equal(v.needsConfirmation, false);
  assert.match(v.message, /ТУ-15.*01\.03\.2027/);
});

test('основание: несуществующий номер — в мягком режиме предупреждение, в строгом блокировка', () => {
  const soft = verifyBasis(input(), null);
  assert.equal(soft.code, 'not_found');
  assert.equal(soft.blocking, false, 'мягкий режим пропускает заявку');
  assert.equal(soft.needsConfirmation, true, 'но СУА подтверждает основание вручную');

  const hard = verifyBasis(input(), null, strict);
  assert.equal(hard.blocking, true);
  assert.match(hard.message, /отправить нельзя/);
});

test('основание: истёкший договор блокируется в строгом режиме', () => {
  const found = record({ number: 'Д-7', validUntil: '2026-10-01' });
  const v = verifyBasis(input({ type: 'smr_contract', number: 'Д-7' }), found, strict);
  assert.equal(v.code, 'expired');
  assert.equal(v.blocking, true);
  assert.match(v.message, /01\.10\.2026/);
  const soft = verifyBasis(input({ type: 'smr_contract', number: 'Д-7' }), found);
  assert.equal(soft.blocking, false);
  assert.equal(soft.needsConfirmation, true);
});

test('основание: чужие, незавизированные ТУ и расторгнутый договор не подтверждаются реестром', () => {
  assert.equal(verifyBasis(input(), record({ counterpartyId: 'cp-2' })).code, 'foreign');
  assert.equal(verifyBasis(input(), record({ approved: false })).code, 'not_approved');
  assert.equal(verifyBasis(input({ type: 'smr_contract' }), record({ terminated: true })).code, 'terminated');
  assert.equal(verifyBasis(input(), record({ counterpartyId: 'cp-2' }), strict).blocking, true);
});

test('основание: акт по другому объекту не подходит', () => {
  const v = verifyBasis(input({ type: 'transfer_act', number: 'АПП-3' }), record({ number: 'АПП-3', facilityId: 'f-2' }));
  assert.equal(v.code, 'other_facility');
});

test('основание: без акта в архиве нужен скан — временное основание с подтверждением СУА', () => {
  const noScan = verifyBasis(input({ type: 'transfer_act', number: 'АПП-3' }), null);
  assert.equal(noScan.blocking, true, 'без скана отправить нельзя');
  assert.equal(noScan.needsScan, true);
  const withScan = verifyBasis(input({ type: 'transfer_act', number: 'АПП-3', hasScan: true }), null);
  assert.equal(withScan.blocking, false);
  assert.equal(withScan.needsConfirmation, true);
  assert.equal(verifyBasis(input({ type: 'transfer_act', number: 'АПП-3', hasScan: true }), null, strict).blocking, true,
    'в строгом режиме скан реестр не заменяет');
});

test('основание: договор аренды подтверждается вручную по скану — реестра в системе нет', () => {
  const noScan = verifyBasis(input({ type: 'lease', number: 'А-12' }), null);
  assert.equal(noScan.code, 'no_registry');
  assert.equal(noScan.blocking, true);
  const withScan = verifyBasis(input({ type: 'lease', number: 'А-12', hasScan: true }), null);
  assert.equal(withScan.blocking, false);
  assert.equal(withScan.needsConfirmation, true);
});

test('режим проверки: строгий для договора аренды невозможен, неизвестные значения — мягкий', () => {
  const modes = normalizeModes({ lease: 'strict', tu: 'strict', smr_contract: 'bogus' });
  assert.deepEqual(modes, { lease: 'soft', tu: 'strict', smr_contract: 'soft', transfer_act: 'soft' });
  assert.deepEqual(normalizeModes(null), DEFAULT_MODES);
});

/* -------------------------------- бригада -------------------------------- */

const worker = (over: Partial<{ documents: { id?: string; title: string; validUntil: string; fileId?: string | null }[]; iin: string }> = {}) => ({
  id: 'w-1', fullName: 'Иванов Иван Иванович', iin: IIN,
  documents: [{ id: 'doc-1', title: 'Допуск к работам на высоте', validUntil: '2027-03-15', fileId: 'file-1' }],
  ...over,
});

test('бригада: удостоверение, действующее на начало работ, проходит', () => {
  assert.deepEqual(checkWorkers([worker()], '2026-10-10'), []);
});

test('бригада: удостоверение, истекающее до начала работ, не пропускается', () => {
  const issues = checkWorkers([worker({ documents: [{ id: 'd', title: 'Электробезопасность', validUntil: '2026-09-01', fileId: 'f' }] })], '2026-10-10');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'expired');
  assert.match(issues[0].message, /истекает до начала работ/);
});

test('бригада: работник без удостоверений или без скана не пропускается', () => {
  assert.equal(checkWorkers([worker({ documents: [] })], '2026-10-10')[0].code, 'no_documents');
  assert.equal(checkWorkers([worker({ documents: [{ title: 'Высота', validUntil: '2027-01-01', fileId: null }] })], null)[0].code, 'no_file');
});

test('бригада: ИИН проверяется по контрольному разряду', () => {
  assert.equal(validIin(IIN), true);
  assert.equal(validIin('850101300125'), false);
  assert.equal(checkWorkers([worker({ iin: '850101300125' })], null)[0].code, 'invalid_iin');
});

test('транспорт: госномер без пробелов и дефисов', () => {
  assert.equal(normalizePlate(' 123 abc-02 '), '123ABC02');
  assert.equal(validPlate('123 ABC 02'), true);
  assert.equal(validPlate('12'), false);
});

/* ------------------------------ заявка целиком ------------------------------ */

const submitInput = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  facilityId: FACILITY, basisType: 'tu', basisNumber: 'ТУ-15',
  periodStart: '2026-10-10T09:00', periodEnd: '2026-10-12T18:00',
  workers: [worker()], vehicles: [{ plate: '123ABC02' }], consent: true, counterpartyBlocked: false,
  basis: verifyBasis(input(), record()), now: '2026-09-29T10:00', ...over,
});

test('заявка: корректная заявка отправляется', () => {
  const { fields, issues } = validateForSubmit(submitInput());
  assert.deepEqual(fields, {});
  assert.deepEqual(issues, []);
});

test('заявка: неполная заявка блокируется с указанием полей', () => {
  const { fields } = validateForSubmit(submitInput({
    facilityId: null, basisType: null, basisNumber: '', periodStart: null, periodEnd: null, workers: [], consent: false,
  }));
  for (const key of ['facilityId', 'basisType', 'basisNumber', 'periodStart', 'periodEnd', 'workers', 'consent']) {
    assert.ok(fields[key], `нет ошибки по полю ${key}`);
  }
});

test('заявка: окончание раньше начала и прошедший период не принимаются', () => {
  assert.ok(validateForSubmit(submitInput({ periodEnd: '2026-10-10T08:00' })).fields.periodEnd);
  assert.match(validateForSubmit(submitInput({ periodStart: '2026-09-01T09:00', periodEnd: '2026-09-02T09:00' })).fields.periodEnd,
    /уже прошёл/);
});

test('заявка: блокирующая проверка основания и заблокированная организация не дают отправить', () => {
  const blocked = verifyBasis(input(), null, strict);
  assert.equal(validateForSubmit(submitInput({ basis: blocked })).fields.basis, blocked.message);
  assert.ok(validateForSubmit(submitInput({ counterpartyBlocked: true })).fields.counterparty);
});

test('заявка: работник с истёкшим удостоверением — ошибка по бригаде', () => {
  const { fields, issues } = validateForSubmit(submitInput({
    workers: [worker({ documents: [{ id: 'd', title: 'Высота', validUntil: '2026-10-01', fileId: 'f' }] })],
  }));
  assert.equal(issues.length, 1);
  assert.match(fields.workers, /Высота/);
});

test('местное время: формат «ГГГГ-ММ-ДДTЧЧ:ММ», Казахстан UTC+5', () => {
  assert.equal(localDateTime('2026-10-10 09:30'), '2026-10-10T09:30');
  assert.equal(localDateTime('2026-10-10T09:30:45'), '2026-10-10T09:30');
  assert.equal(localDateTime('10.10.2026'), null);
  assert.equal(localNow(new Date('2026-09-29T20:00:00Z')), '2026-09-30T01:00');
});

/* --------------------------------- права --------------------------------- */

const actor = (roles: Role[], over: Partial<Actor> = {}): Actor => ({
  id: 'u1', userId: 'oidc:1', email: 'u@qtr.kz', fullName: 'Пользователь',
  roles, branchId: null, counterpartyId: null, isActive: true, ...over,
});

test('права: подрядчик — только своя организация в портале допусков, заявок ОР ПСД не видит', () => {
  const contractor = actor(['contractor'], { counterpartyId: CP });
  assert.equal(rbac.can(contractor, 'permit.own'), true);
  assert.equal(rbac.can(contractor, 'permit.view'), false);
  assert.equal(rbac.can(contractor, 'request.view'), false);
  assert.equal(rbac.isExternal(contractor), true);
  assert.deepEqual(rbac.requestScope(contractor), { kind: 'none' });
});

test('учётная запись: внешняя роль не совмещается с другими — кабинеты не пересекаются', () => {
  const admin = actor(['admin'], { email: 'admin@qtr.kz' });
  const check = (roles: Role[]) => checkUser({ email: 'rep@a.kz', fullName: 'Представитель', roles, counterpartyId: CP }, admin).fields;
  assert.match(check(['customer', 'contractor']).roles, /разные учётные записи/);
  assert.ok(check(['contractor', 'orpsd']).roles, 'и с ролями сотрудников');
  assert.equal(check(['contractor']).roles, undefined);
  assert.equal(check(['customer']).roles, undefined);
  assert.equal(check(['permits', 'assets']).roles, undefined, 'роли сотрудников совмещаются как прежде');
});

test('права: даже при ошибке в данных «Подрядчик» рядом с «Заказчиком» не открывает все заявки ОР ПСД', () => {
  const both = actor(['customer', 'contractor'], { counterpartyId: CP });
  assert.equal(rbac.isCustomer(both), true);
  assert.deepEqual(rbac.requestScope(both), { kind: 'counterparty', id: CP });
});

test('права: специалист СУА рассматривает заявки и смотрит архив актов без загрузки', () => {
  const sua = actor(['permits']);
  assert.equal(rbac.can(sua, 'permit.review'), true);
  assert.equal(rbac.can(sua, 'permit.view'), true);
  assert.equal(rbac.can(sua, 'documents.view'), true);
  assert.equal(rbac.can(sua, 'documents.download'), true);
  assert.equal(rbac.can(sua, 'documents.upload'), false);
  assert.equal(rbac.can(sua, 'permit.own'), false);
  assert.equal(rbac.can(actor(['oko']), 'permit.review'), false, 'ОКО — только просмотр');
  assert.equal(rbac.can(actor(['oko']), 'permit.view'), true);
});
