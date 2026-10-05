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
import {
  ALLOWED_BASIS, DEFAULT_RULES, normalizeCisDays, normalizeRules, periodDays, route, touchesNight,
} from '../src/permits/domain/rules.ts';
import type { RouteInput } from '../src/permits/domain/rules.ts';
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

test('основание: договор аренды из реестра СУА подтверждается сам; нет в реестре — по скану и вручную', () => {
  const found = verifyBasis(input({ type: 'lease', number: 'А-12' }), record({ number: 'А-12', facilityId: null }));
  assert.equal(found.ok, true);
  assert.equal(found.reference?.validUntil, '2027-03-01');
  const noScan = verifyBasis(input({ type: 'lease', number: 'А-12' }), null);
  assert.equal(noScan.code, 'not_found');
  assert.equal(noScan.blocking, true, 'без скана договора отправить нельзя');
  const withScan = verifyBasis(input({ type: 'lease', number: 'А-12', hasScan: true }), null);
  assert.equal(withScan.blocking, false);
  assert.equal(withScan.needsConfirmation, true);
  const foreign = verifyBasis(input({ type: 'lease', number: 'А-12' }), record({ number: 'А-12', counterpartyId: 'other' }));
  assert.equal(foreign.code, 'foreign');
});

test('основание: распоряжение Общества — внутренний документ, проверяется объект, а не организация', () => {
  const order = verifyBasis(input({ type: 'order', number: 'Р-7' }), record({ number: 'Р-7', counterpartyId: null }));
  assert.equal(order.ok, true);
  const other = verifyBasis(input({ type: 'order', number: 'Р-7' }), record({ number: 'Р-7', facilityId: 'f-2' }));
  assert.equal(other.code, 'other_facility');
});

test('режим проверки: строгий доступен для всех оснований с реестром, неизвестные значения — мягкий', () => {
  const modes = normalizeModes({ lease: 'strict', tu: 'strict', smr_contract: 'bogus' });
  assert.deepEqual(modes, { lease: 'strict', tu: 'strict', smr_contract: 'soft', transfer_act: 'soft', order: 'soft' });
  assert.deepEqual(normalizeModes(null), DEFAULT_MODES);
});

/* -------------------------------- бригада -------------------------------- */

type Doc = { id?: string; kind?: 'qualification' | 'passport' | 'visa'; title: string; validUntil: string; fileId?: string | null };
const worker = (over: Partial<{ documents: Doc[]; iin: string | null; citizenship: string; birthDate: string | null; address: string; idDocNumber: string }> = {}) => ({
  id: 'w-1', fullName: 'Иванов Иван Иванович', iin: IIN as string | null, citizenship: 'KZ',
  birthDate: '1985-01-01', birthPlace: 'г. Алматы', idDocNumber: '012345678', idDocIssuedAt: '2020-05-05',
  idDocIssuedBy: 'МВД РК', address: 'г. Алматы, ул. Абая, 1',
  documents: [{ id: 'doc-1', title: 'Допуск к работам на высоте', validUntil: '2027-03-15', fileId: 'file-1' }] as Doc[],
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

const noRoute = { fields: {}, branchReasons: [], emergency: false };
const letter = { number: '15-01/123', date: '2026-09-28', signatoryName: 'Петров П.П.', signatoryPosition: 'Директор', hasFile: true };
const submitInput = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  workType: 'installation', facilityId: FACILITY, basisType: 'tu', basisNumber: 'ТУ-15', basisValidUntil: '2027-03-01',
  periodStart: '2026-10-10T09:00', periodEnd: '2026-10-12T18:00',
  workers: [worker()], vehicles: [{ plate: '123ABC02' }], consent: true, counterpartyBlocked: false,
  basis: verifyBasis(input(), record()), route: noRoute, ownerBin: '', letter, now: '2026-09-29T10:00', ...over,
});

test('заявка: корректная заявка отправляется', () => {
  const { fields, issues } = validateForSubmit(submitInput());
  assert.deepEqual(fields, {});
  assert.deepEqual(issues, []);
});

test('заявка: неполная заявка блокируется с указанием полей', () => {
  const { fields } = validateForSubmit(submitInput({
    workType: null, facilityId: null, basisType: null, basisNumber: '', periodStart: null, periodEnd: null, workers: [], consent: false,
    letter: { number: '', date: null, signatoryName: '', signatoryPosition: '', hasFile: false },
  }));
  for (const key of ['workType', 'facilityId', 'basisType', 'periodStart', 'periodEnd', 'workers', 'consent',
    'letterFile', 'letterNumber', 'letterDate', 'signatoryName']) {
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

/* ------------------------- Инструкция о допуске ------------------------- */

const routeInput = (over: Partial<RouteInput> = {}): RouteInput => ({
  workType: 'maintenance', onAms: false, hoursFrom: '09:00', hoursTo: '18:00', weekendWork: false,
  periodHasWorkingDay: true, crewSize: 2, concurrent: 0, ...over,
});

test('Инструкция: основание по цели работ — аренда для ТО, ТУ для монтажа, распоряжение для контроля (пп. 7, 9, 12)', () => {
  assert.deepEqual(ALLOWED_BASIS.maintenance, ['lease']);
  assert.deepEqual(ALLOWED_BASIS.installation, ['tu']);
  assert.ok(ALLOWED_BASIS.supervision.includes('order'));
});

test('Инструкция: монтаж на АМС — только работники Общества (п. 11); ТО на АМС — с согласованием филиала (п. 8)', () => {
  assert.match(route(routeInput({ workType: 'installation', onAms: true })).fields.workType, /п\. 11/);
  assert.match(route(routeInput({ workType: 'replacement', onAms: true })).fields.workType, /работники Общества/);
  const ams = route(routeInput({ onAms: true }));
  assert.deepEqual(ams.fields, {});
  assert.deepEqual(ams.branchReasons, ['ams']);
  assert.deepEqual(route(routeInput()).branchReasons, [], 'ТО в помещении — без согласования филиала');
});

test('Инструкция: изыскания и более 5 человек — согласование руководства филиала (п. 14)', () => {
  assert.ok(route(routeInput({ workType: 'survey' })).branchReasons.includes('survey'));
  assert.ok(route(routeInput({ crewSize: 6 })).branchReasons.includes('crew'));
  assert.ok(route(routeInput({ crewSize: 3, concurrent: 3 })).branchReasons.includes('crew'), 'считаются уже допущенные на объект');
  assert.equal(route(routeInput({ crewSize: 5 })).branchReasons.includes('crew'), false);
});

test('Инструкция: ночью и в выходные — только аварийные работы и с согласованием филиала (п. 14)', () => {
  assert.match(route(routeInput({ hoursTo: '23:00' })).fields.workHours, /ночное время/);
  assert.match(route(routeInput({ weekendWork: true })).fields.workHours, /выходные/);
  assert.match(route(routeInput({ periodHasWorkingDay: false })).fields.workHours, /нет рабочих дней/);
  const night = route(routeInput({ workType: 'emergency', hoursFrom: '20:00', hoursTo: '04:00', weekendWork: true }));
  assert.deepEqual(night.fields, {});
  assert.equal(night.emergency, true);
  for (const r of ['emergency', 'night', 'weekend'] as const) assert.ok(night.branchReasons.includes(r));
  assert.equal(touchesNight('06:00', '22:00'), false);
  assert.equal(touchesNight('05:30', '12:00'), true);
  assert.equal(touchesNight('08:00', '02:00'), true, 'через полночь');
});

test('Инструкция: срок допуска не превышает срок договора аренды (пп. 13, 14)', () => {
  const lease = verifyBasis(input({ type: 'lease', number: 'А-1' }), record({ number: 'А-1', validUntil: '2026-10-11', facilityId: null }));
  const { fields } = validateForSubmit(submitInput({ workType: 'maintenance', basisType: 'lease', basisNumber: 'А-1', basis: lease, basisValidUntil: '2026-10-11' }));
  assert.match(fields.periodEnd, /срок действия договора аренды/);
  const noUntil = validateForSubmit(submitInput({
    workType: 'maintenance', basisType: 'lease', basisNumber: 'А-1', basisValidUntil: null,
    basis: verifyBasis(input({ type: 'lease', number: 'А-1', hasScan: true }), null),
  }));
  assert.ok(noUntil.fields.basisValidUntil, 'без реестра заявитель указывает срок договора');
});

test('Инструкция: подписанный запрос со списком по Приложению 1 обязателен, кроме аварии (пп. 13, 18)', () => {
  const none = { number: '', date: null, signatoryName: '', signatoryPosition: '', hasFile: false };
  assert.ok(validateForSubmit(submitInput({ letter: none })).fields.letterFile);
  const emergency = validateForSubmit(submitInput({ letter: none, route: { fields: {}, branchReasons: ['emergency'], emergency: true } }));
  assert.equal(emergency.fields.letterFile, undefined, 'при аварии запрос досылается в течение 2 дней');
});

test('Инструкция: сведения Приложения 1 обязательны при отправке', () => {
  const issues = checkWorkers([worker({ birthDate: null, address: '' })], '2026-10-10', { appendix: true });
  assert.equal(issues[0].code, 'incomplete');
  assert.match(issues[0].message, /дата рождения, .*адрес/);
  assert.deepEqual(checkWorkers([worker({ birthDate: null })], '2026-10-10'), [], 'в черновике не мешает');
});

test('Инструкция: иностранцам — паспорт и виза, гражданам СНГ — срок безвизового пребывания (п. 16)', () => {
  const quals = worker().documents;
  const passport: Doc = { id: 'p', kind: 'passport', title: 'Паспорт', validUntil: '2030-01-01', fileId: 'fp' };
  const visa: Doc = { id: 'v', kind: 'visa', title: 'Виза', validUntil: '2026-10-11', fileId: 'fv' };
  const opts = { endDate: '2026-10-12' };
  const de = (docs: Doc[]) => checkWorkers([worker({ iin: null, citizenship: 'DE', documents: [...quals, ...docs] })], '2026-10-10', opts);
  assert.deepEqual(de([]).map((i) => i.code), ['no_passport', 'no_visa']);
  assert.deepEqual(de([passport, visa]).map((i) => i.code), ['visa_expired']);
  assert.deepEqual(de([passport, { ...visa, validUntil: '2027-01-01' }]), []);
  const ru = (end: string) => checkWorkers([worker({ iin: null, citizenship: 'RU', documents: [...quals, passport] })],
    '2026-10-10', { endDate: end, cisDays: normalizeCisDays({ RU: 30 }) });
  assert.deepEqual(ru('2026-11-08'), []);
  assert.equal(ru('2026-11-09')[0].code, 'stay_limit');
  assert.equal(periodDays('2026-10-10', '2026-10-10'), 1);
  assert.equal(checkWorkers([worker({ iin: null })], null)[0].code, 'invalid_iin', 'гражданину Казахстана ИИН обязателен');
});

test('Инструкция: настройки сроков и пределов — с проверкой значений', () => {
  assert.deepEqual(normalizeRules(null), DEFAULT_RULES);
  assert.equal(normalizeRules({ reviewDays: 10, maxCrew: 0, nightFrom: '25:00' }).reviewDays, 10);
  assert.equal(normalizeRules({ maxCrew: 0 }).maxCrew, 5);
  assert.equal(normalizeRules({ nightFrom: '25:00' }).nightFrom, '22:00');
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

test('права: филиал ведёт допуски на свои объекты, аудитор только читает журнал', () => {
  const branch = actor(['branch'], { branchId: 'b-1' });
  assert.equal(rbac.can(branch, 'permit.branch'), true);
  assert.equal(rbac.can(branch, 'permit.review'), false);
  const auditor = actor(['auditor']);
  assert.equal(rbac.can(auditor, 'audit.view'), true);
  assert.equal(rbac.can(auditor, 'request.view'), false);
  assert.equal(rbac.can(auditor, 'admin'), false);
});
