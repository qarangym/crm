/**
 * Портал допусков: сквозной тест против настоящей PostgreSQL.
 *
 * Сценарии — критерии приёмки (План модуля допусков, §10) и требования
 * Инструкции о допуске сторонних организаций на объекты АО «Казтелерадио»:
 * цель работ и основание, Приложение 1, согласование руководства филиала
 * (АМС, изыскания, более 5 человек, ночь и выходные, авария), аварийный
 * порядок с досылкой запроса, срок рассмотрения 14 рабочих дней, допуск с
 * кодом и копией в филиал, проверка на объекте (инструктаж, СИЗ), закрытие,
 * отзыв, продление, реестр договоров аренды, иностранцы; а также права,
 * письма, «колокольчик», замещение, отчёт и неизменяемый журнал.
 *
 *   TEST_DATABASE_URL=postgres://qtr:testpass@127.0.0.1:55432/qtr_crm_test npm run test:integration
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createDb, type Db } from '../src/db/client.ts';
import { FileStore } from '../src/storage/files.ts';
import { migrate } from '../src/db/migrate.ts';
import { createApp } from '../src/server/app.ts';
import type { AuthConfig } from '../src/server/auth.ts';
import { identityId } from '../src/server/auth.ts';
import { runPermitExpiry, runPermitReviewControl } from '../src/permits/jobs.ts';
import { validIin } from '../src/permits/domain/request.ts';

/** ИИН с верным контрольным разрядом для тестовых работников. */
function makeIin(seed: number): string {
  for (let s = seed; ; s++) {
    const base = '8501013' + String(1000 + (s % 9000)).slice(-4);
    for (let d = 0; d < 10; d++) if (validIin(base + d)) return base + d;
  }
}
/** Сегодня по Алматы — так считает сервер. */
const almatyToday = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

const URL_ENV = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));

const PERMIT_TABLES = ['site_admissions', 'access_request_vehicles', 'access_request_workers', 'access_requests',
  'access_request_counters', 'crew_vehicles', 'crew_members', 'contractor_crews', 'worker_documents',
  'contractor_vehicles', 'contractor_workers', 'permit_files', 'lease_contract_facilities', 'lease_contracts'];

/** Журнал неизменяем; тестовая база очищается с явным флагом сеанса. */
async function purgeEvents(db: Db, sql: string, params: unknown[] = []) {
  await db.tx(async (t) => {
    await t.query(`SELECT set_config('qtr.audit_purge', 'on', true)`);
    await t.query(sql, params as never[]);
  });
}

describe('портал допусков с PostgreSQL', { skip: URL_ENV ? false : 'не задан TEST_DATABASE_URL' }, () => {
  let db: Db;
  let server: Server;
  let base: string;
  let storeRoot = '';

  const SECRET = 'p'.repeat(48);
  const ISSUER = 'https://sso.test/realms/qtr';
  const auth: AuthConfig = { enabled: true, proxySecret: SECRET, issuer: ISSUER, devIdentity: null };

  const users = {
    contractor: 'contractor@a.permits.test',
    contractorB: 'contractor@b.permits.test',
    contractorC: 'contractor@c.permits.test',
    customer: 'customer@a.permits.test',
    sua: 'sua@permits.test',
    oko: 'oko@permits.test',
    admin: 'admin@permits.test',
    director: 'director@permits.test',
    engineer: 'engineer@permits.test',
    stranger: 'stranger@permits.test',
  };
  const ids: Record<string, string> = {};

  let cpA = '';
  let cpABin = '';
  let cpB = '';
  let cpBlocked = '';
  let cpBlockedStatus = '';
  let facilityId = '';
  let facilityInv = '';
  let otherFacilityId = '';
  let branchId = '';
  let branchBackup: Record<string, unknown> = {};
  let tuId = '';
  const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const future = (days: number, time = '09:00') => day(days) + 'T' + time;

  const headersFor = (as: string): Record<string, string> => ({
    'x-qtr-proxy-key': SECRET,
    'x-qtr-user-id': 'subject-' + as,
    'x-qtr-user-email': as,
    'x-qtr-user-name': as,
  });

  async function call(method: string, path: string, options: { as?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.as ? headersFor(options.as) : {}) };
    const res = await fetch(base + path, {
      method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const type = res.headers.get('content-type') ?? '';
    const body = type.includes('application/json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: body as any, type };
  }

  async function upload(path: string, as: string, fields: Record<string, string>, file?: { name: string; data: Buffer }) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    if (file) form.set('file', new Blob([file.data]), file.name);
    const res = await fetch(base + path, { method: 'POST', headers: headersFor(as), body: form });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }

  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'utf8');

  before(async () => {
    db = createDb(URL_ENV!);
    await migrate(db, join(here, '..', 'src', 'db'));

    for (const table of PERMIT_TABLES) await db.query(`DELETE FROM ${table}`);
    await db.query(`DELETE FROM notifications WHERE recipient LIKE '%permits.test'`);
    await db.query(`UPDATE settings SET updated_by = NULL WHERE updated_by IN (SELECT id FROM users WHERE email LIKE '%permits.test')`);
    await purgeEvents(db, `DELETE FROM events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE '%permits.test')`);
    await db.query(`DELETE FROM documents WHERE number LIKE 'П-ТЕСТ-%'`);
    await db.query(`DELETE FROM contracts WHERE number LIKE 'П-ТЕСТ-%'`);
    await db.query(`UPDATE branches SET site_officer_id = NULL, director_id = NULL WHERE site_officer_id IN (SELECT id FROM users WHERE email LIKE '%permits.test')
                      OR director_id IN (SELECT id FROM users WHERE email LIKE '%permits.test')`);
    await db.query(`DELETE FROM users WHERE email LIKE '%permits.test'`);
    await db.query(`UPDATE settings SET value = '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft","order":"soft"}'
                     WHERE key = 'permits.basis_mode'`);

    const cps = await db.query<{ id: string; status: string; bin: string }>(`SELECT id, status, bin FROM counterparties ORDER BY bin`);
    assert.ok(cps.length >= 3, 'справочники не заполнены: выполните npm run seed:demo');
    cpA = cps[0].id;
    cpABin = cps[0].bin;
    cpB = cps[cps.length - 1].id;
    cpBlocked = cps[1].id;
    cpBlockedStatus = cps[1].status;
    const facilities = await db.query<{ id: string; inv_no: string; branch_id: string }>(
      `SELECT id, inv_no, branch_id FROM facilities WHERE is_active ORDER BY inv_no LIMIT 2`);
    facilityId = facilities[0].id;
    facilityInv = facilities[0].inv_no;
    branchId = facilities[0].branch_id;
    otherFacilityId = facilities[1].id;
    const other = await db.one<{ id: string }>(`SELECT id FROM branches WHERE id <> $1 LIMIT 1`, [branchId]);

    const roles: Record<keyof typeof users, string[]> = {
      contractor: ['contractor'], contractorB: ['contractor'], contractorC: ['contractor'], customer: ['customer'],
      sua: ['permits'], oko: ['oko'], admin: ['admin'], director: ['branch'], engineer: ['branch'], stranger: ['branch'],
    };
    // Организация A представлена в обоих кабинетах — разными учётными записями.
    const cpOf: Partial<Record<keyof typeof users, string>> = {
      contractor: cpA, contractorB: cpB, contractorC: cpBlocked, customer: cpA,
    };
    const branchOf: Partial<Record<keyof typeof users, string>> = {
      director: branchId, engineer: branchId, stranger: other?.id ?? branchId,
    };
    for (const [key, email] of Object.entries(users) as [keyof typeof users, string][]) {
      const u = await db.one<{ id: string }>(
        `INSERT INTO users (email, oidc_subject, full_name, counterparty_id, branch_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [email, identityId(ISSUER, 'subject-' + email), email, cpOf[key] ?? null, branchOf[key] ?? null]);
      for (const role of roles[key]) await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,$2)`, [u!.id, role]);
      ids[key] = u!.id;
    }
    // Руководство филиала объекта и ответственное лицо на объекте (п. 20 Инструкции).
    branchBackup = (await db.one(`SELECT director_id, curator_id, chief_engineer_id, site_officer_id FROM branches WHERE id = $1`, [branchId]))!;
    await db.query(`UPDATE branches SET director_id = $2, site_officer_id = $3 WHERE id = $1`, [branchId, ids.director, ids.engineer]);

    // Основания в реестрах системы: ТУ — в архиве, договор на СМР — в договорах ОР ПСД.
    tuId = (await db.one<{ id: string }>(
      `INSERT INTO documents (kind, number, facility_id, owner_id, doc_date, valid_until, approved, created_by)
       VALUES ('ТУ', 'П-ТЕСТ-ТУ-1', $1, $2, current_date - 10, current_date + 150, true, $3) RETURNING id`,
      [facilityId, cpA, ids.admin]))!.id;
    await db.query(
      `INSERT INTO contracts (number, counterparty_id, service, status, signed_at, valid_until)
       VALUES ('П-ТЕСТ-Д-ИСТЁК', $1, 'СМР', 'signed', current_date - 400, current_date - 30)`, [cpA]);

    storeRoot = await mkdtemp(join(tmpdir(), 'qtr-permits-'));
    const handle = createApp({
      db, auth, trustProxy: true, rateLimit: { max: 100_000 }, store: new FileStore(storeRoot),
      staticRoot: join(here, '..', 'design'),
    });
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await db.query(`UPDATE counterparties SET status = $2 WHERE id = $1`, [cpBlocked, cpBlockedStatus]).catch(() => {});
    await db.query(`UPDATE branches SET director_id = $2, curator_id = $3, chief_engineer_id = $4, site_officer_id = $5 WHERE id = $1`,
      [branchId, branchBackup.director_id, branchBackup.curator_id, branchBackup.chief_engineer_id, branchBackup.site_officer_id]).catch(() => {});
    await db.query(`UPDATE settings SET value = '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft","order":"soft"}',
                     updated_by = NULL WHERE key = 'permits.basis_mode'`).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  /* ------------------------------ помощники ------------------------------ */

  const appendix = (iin: string) => ({
    birthDate: '1985-01-01', birthPlace: 'г. Алматы', idDocNumber: '0' + iin.slice(-8), idDocIssuedAt: '2020-05-05',
    idDocIssuedBy: 'МВД РК', address: 'г. Алматы, ул. Абая, 1', position: 'Монтажник',
  });

  async function addWorker(as: string, fullName: string, iin: string, validUntil: string, extra: Record<string, unknown> = {}) {
    const w = await call('POST', '/api/v1/permits/workers', { as, body: { fullName, iin, ...appendix(iin), ...extra } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const d = await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, as,
      { title: 'Допуск к работам на высоте', number: 'В-' + iin.slice(-4), validUntil }, { name: 'udost.pdf', data: pdf(fullName) });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    return d.body.worker;
  }

  const letter = { letterNumber: '15-01/77', letterDate: day(0), signatoryName: 'Петров П.П.', signatoryPosition: 'Директор' };

  async function draft(as: string, body: Record<string, unknown>) {
    const res = await call('POST', '/api/v1/permits/requests', { as, body: { ...letter, ...body } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  /** Скан подписанного запроса со списком по Приложению 1 (п. 13). */
  async function attachLetter(as: string, card: any) {
    const res = await upload(`/api/v1/permits/requests/${card.request.id}/letter-file`, as, {}, { name: 'zapros.pdf', data: pdf('запрос') });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function submit(as: string, card: any, consent = true) {
    return call('POST', `/api/v1/permits/requests/${card.request.id}/submit`, {
      as, body: { version: card.request.version, consent },
    });
  }

  async function card(id: string, as = users.sua) {
    return (await call('GET', `/api/v1/permits/requests/${id}`, { as })).body;
  }

  const state: Record<string, any> = {};

  /* ------------------------------- доступ ------------------------------- */

  test('подрядчик входит только в портал допусков; заявки и справочники ОР ПСД ему закрыты', async () => {
    const me = await call('GET', '/api/v1/me', { as: users.contractor });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.modules, ['permits']);
    assert.equal(me.body.isExternal, true);
    for (const path of ['/api/v1/requests', '/api/v1/board', '/api/v1/rules', '/api/v1/facilities',
      '/api/v1/documents', '/api/v1/users', '/api/v1/assignments', '/api/v1/permits/leases', '/api/v1/permits/site']) {
      const res = await call('GET', path, { as: users.contractor });
      assert.equal(res.status, 403, `${path} должен быть закрыт подрядчику`);
    }
    const sua = await call('GET', '/api/v1/me', { as: users.sua });
    assert.deepEqual(sua.body.modules, ['orpsd', 'permits'], 'СУА видит архив актов и портал допусков');
    const branch = await call('GET', '/api/v1/me', { as: users.engineer });
    assert.ok(branch.body.modules.includes('permits'), 'филиал работает с допусками на свои объекты');
  });

  test('кабинеты не пересекаются: Заказчик не подаёт заявку на допуск, подрядчик — заявку на услуги', async () => {
    const me = await call('GET', '/api/v1/me', { as: users.customer });
    assert.deepEqual(me.body.modules, ['orpsd']);
    for (const [method, path] of [['GET', '/api/v1/permits/requests'], ['GET', '/api/v1/permits/meta'],
      ['GET', '/api/v1/permits/workers'], ['POST', '/api/v1/permits/requests']] as const) {
      const res = await call(method, path, { as: users.customer, body: method === 'POST' ? { facilityId } : undefined });
      assert.equal(res.status, 403, `${method} ${path} закрыт Заказчику`);
    }
    const order = await call('POST', '/api/v1/requests', {
      as: users.contractor, body: { draft: true, facilityId, services: [] } });
    assert.equal(order.status, 403);
    const combined = await call('POST', '/api/v1/users', {
      as: users.admin, body: { email: 'mixed@a.permits.test', fullName: 'Совмещённая учётная запись',
        roles: ['customer', 'contractor'], counterpartyId: cpA } });
    assert.equal(combined.status, 422);
    const customerId = ids.customer;
    await assert.rejects(db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'contractor')`, [customerId]),
      /не совмещается/);
  });

  test('портал открывается отдельной ссылкой /dopusk/', async () => {
    const redirect = await fetch(base + '/dopusk', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    const page = await fetch(base + '/dopusk/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Портал допусков/);
  });

  /* ------------------------ работники по Приложению 1 ------------------------ */

  test('работник: ИИН гражданина Казахстана обязателен, иностранцу — ФИО латиницей и паспорт', async () => {
    const bad = await call('POST', '/api/v1/permits/workers', {
      as: users.contractor, body: { fullName: 'Петров Пётр Петрович', iin: '850101300125' } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.fields.iin);
    const foreignBad = await call('POST', '/api/v1/permits/workers', {
      as: users.contractor, body: { fullName: 'Мюллер Ханс', citizenship: 'DE' } });
    assert.equal(foreignBad.status, 422);
    assert.ok(foreignBad.body.fields.fullNameLatin);
    assert.ok(foreignBad.body.fields.idDocNumber);

    state.w1 = await addWorker(users.contractor, 'Иванов Иван Иванович', '850101300124', day(200));
    state.w2 = await addWorker(users.contractor, 'Петров Пётр Петрович', '900515400133', day(2));
    assert.equal(state.w1.birth_date, '1985-01-01');
    assert.equal(state.w1.documents[0].fileName, 'udost.pdf');
  });

  test('транспорт и сохранённая бригада; чужие работники в бригаду не попадают', async () => {
    const v = await call('POST', '/api/v1/permits/vehicles', {
      as: users.contractor, body: { plate: '123 abc 02', model: 'ГАЗель', driverName: 'Иванов И.И.' } });
    assert.equal(v.status, 200);
    assert.equal(v.body.vehicle.plate, '123ABC02');
    state.vehicle = v.body.vehicle;
    const crew = await call('POST', '/api/v1/permits/crews', {
      as: users.contractor, body: { name: 'Монтажная бригада', workerIds: [state.w1.id, state.w2.id], vehicleIds: [state.vehicle.id] } });
    assert.equal(crew.status, 200, JSON.stringify(crew.body));
    state.crew = crew.body.crew;
    const foreign = await call('POST', '/api/v1/permits/crews', { as: users.contractorB, body: { name: 'Чужая', workerIds: [state.w1.id] } });
    assert.equal(foreign.body.crew.worker_ids.length, 0);
  });

  /* ---------------------- заявка: цель, основание, бригада ---------------------- */

  test('монтаж по ТУ: удостоверение, истекающее до начала работ, не пропускается; без запроса — нельзя', async () => {
    const options = await call('GET', `/api/v1/permits/basis-options?facilityId=${facilityId}`, { as: users.contractor });
    assert.ok(options.body.tu.some((t: any) => t.id === tuId), 'ТУ организации предлагаются к выбору');

    const wrongBasis = await call('POST', '/api/v1/permits/requests', {
      as: users.contractor, body: { workType: 'installation', facilityId, basisType: 'lease', basisNumber: 'А-1' } });
    assert.equal(wrongBasis.status, 422, 'для монтажа основание — ТУ (п. 9)');

    const c = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisRefId: tuId, periodStart: future(5), periodEnd: future(9, '18:00'),
      crewId: state.crew.id, workerIds: state.crew.worker_ids, vehicleIds: state.crew.vehicle_ids,
      description: 'Монтаж оборудования в аппаратной',
    });
    assert.equal(c.request.status, 'draft');
    assert.match(c.request.number, /^ЗД-\d{4}-\d{4}$/);
    assert.equal(c.request.basisNumber, 'П-ТЕСТ-ТУ-1', 'номер взят из реестра');
    assert.equal(c.basis.code, 'ok');
    assert.equal(c.issues.length, 1, 'у Петрова удостоверение истекает до начала работ');

    const res = await submit(users.contractor, c, false);
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.workers);
    assert.ok(res.body.fields.consent);
    assert.ok(res.body.fields.letterFile, 'нужен подписанный запрос (п. 13)');
    state.main = c;
  });

  test('печатная форма запроса с Приложением 1 — для подписи и печати организации', async () => {
    const page = await call('GET', `/api/v1/permits/requests/${state.main.request.id}/print/letter`, { as: users.contractor });
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    const html = page.body.toString('utf8');
    assert.match(html, /Приложение 1/);
    assert.match(html, /Иванов Иван Иванович/);
    assert.match(html, /МВД РК/);
  });

  test('после обновления удостоверения и скана запроса заявка уходит; срок СУА — 14 рабочих дней', async () => {
    const doc = state.w2.documents[0];
    const upd = await upload(`/api/v1/permits/workers/${state.w2.id}/documents`, users.contractor,
      { documentId: doc.id, title: doc.title, validUntil: day(300) });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    const withLetter = await attachLetter(users.contractor, state.main);
    assert.equal(withLetter.issues.length, 0);
    const res = await submit(users.contractor, withLetter);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending_review');
    assert.equal(res.body.request.branchApproval, 'not_required', 'монтаж в помещении силами 2 человек — без филиала');
    assert.ok(res.body.request.reviewDueAt > day(13), 'не раньше чем через 14 рабочих дней');
    assert.equal(res.body.request.assigneeName, null, 'подрядчику имя сотрудника не показывается');
    const seen = await card(res.body.request.id);
    assert.equal(seen.request.assigneeName, users.sua, 'рассматривает конкретный специалист СУА (п. 102)');
    const tasks = await call('GET', '/api/v1/tasks', { as: users.sua });
    assert.ok(tasks.body.tasks.some((t: any) => t.kind === 'permit' && t.ref === res.body.request.number && t.dueAt),
      'заявка — в «Моих задачах» СУА со сроком');
    state.main = res.body;
    const again = await call('PATCH', `/api/v1/permits/requests/${state.main.request.id}`, {
      as: users.contractor, body: { version: state.main.request.version, facilityId } });
    assert.equal(again.status, 409, 'отправленную заявку изменить нельзя');
  });

  test('Инструкция: монтаж на АМС — только работники Общества; ночью без аварии — нельзя', async () => {
    const ams = await draft(users.contractor, {
      workType: 'installation', onAms: true, facilityId, basisType: 'tu', basisRefId: tuId,
      periodStart: future(5), periodEnd: future(9, '18:00'), workerIds: [state.w1.id] });
    assert.match(ams.route.fields.workType, /п\. 11/);
    const night = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisRefId: tuId, workHoursFrom: '20:00', workHoursTo: '23:30',
      periodStart: future(5), periodEnd: future(9, '18:00'), workerIds: [state.w1.id] });
    const withLetter = await attachLetter(users.contractor, night);
    const res = await submit(users.contractor, withLetter);
    assert.equal(res.status, 422);
    assert.match(res.body.fields.workHours, /аварийно-восстановительных/);
  });

  test('чужая организация и чужой филиал не открывают заявку и сканы — отказ в журнале', async () => {
    const id = state.main.request.id;
    assert.equal((await call('GET', `/api/v1/permits/requests/${id}`, { as: users.contractorB })).status, 403);
    assert.equal((await call('GET', `/api/v1/permits/requests/${id}`, { as: users.stranger })).status, 403);
    const event = await db.one(`SELECT result FROM events WHERE entity = 'access_request' AND entity_id = $1 AND result = 'denied'`, [id]);
    assert.ok(event, 'попытка зафиксирована как отказ');
    const scan = state.main.workers[0].documents[0].fileId;
    assert.equal((await call('GET', `/api/v1/permits/files/${scan}`, { as: users.contractorB })).status, 403);
  });

  /* ------------------------- мягкий и строгий режим ------------------------- */

  test('мягкий режим: несуществующие ТУ — предупреждение; срочная заявка — первой в очереди', async () => {
    const c = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisNumber: 'НЕТ-ТАКИХ-ТУ', periodStart: future(3), periodEnd: future(8),
      workerIds: [state.w1.id], isUrgent: true,
    });
    assert.equal(c.basis.code, 'not_found');
    assert.equal(c.basis.blocking, false);
    const res = await submit(users.contractor, await attachLetter(users.contractor, c));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.basis.needsConfirmation, true);
    state.urgent = res.body;
    const queue = await call('GET', '/api/v1/permits/requests?queue=1', { as: users.sua });
    assert.equal(queue.body.requests[0].number, state.urgent.request.number, 'срочная — в начале очереди');
  });

  test('строгий режим: несуществующие ТУ и истёкший договор на СМР — отправить нельзя', async () => {
    const denied = await call('POST', '/api/v1/permits/settings', { as: users.sua, body: { modes: { tu: 'strict' } } });
    assert.equal(denied.status, 403, 'режим меняет ДИТ');
    const set = await call('POST', '/api/v1/permits/settings', {
      as: users.admin, body: { modes: { tu: 'strict', smr_contract: 'strict' } } });
    assert.equal(set.status, 200);
    const tu = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisNumber: 'НЕТ-ТАКИХ-ТУ', periodStart: future(3), periodEnd: future(8),
      workerIds: [state.w1.id] });
    const r1 = await submit(users.contractor, await attachLetter(users.contractor, tu));
    assert.equal(r1.status, 422);
    assert.match(r1.body.fields.basis, /отправить нельзя/);
    const contract = await draft(users.contractor, {
      workType: 'supervision', facilityId, basisType: 'smr_contract', basisNumber: 'П-ТЕСТ-Д-ИСТЁК', periodStart: future(3),
      periodEnd: future(8), workerIds: [state.w1.id] });
    assert.equal(contract.basis.code, 'expired');
    assert.equal((await submit(users.contractor, await attachLetter(users.contractor, contract))).status, 422);
    await call('POST', '/api/v1/permits/settings', { as: users.admin, body: { modes: {} } });
  });

  /* ------------------------- договор аренды и реестр ------------------------- */

  test('ТО и ремонт: договора нет в реестре — нужен скан и срок; СУА подтверждает и вносит договор в реестр', async () => {
    const c = await draft(users.contractor, {
      workType: 'maintenance', facilityId, basisType: 'lease', basisNumber: 'А-2026-17', periodStart: future(3), periodEnd: future(8),
      workerIds: [state.w1.id] });
    assert.equal(c.basis.code, 'not_found');
    assert.equal(c.basis.blocking, true, 'без скана договора отправить нельзя');
    const scanned = await upload(`/api/v1/permits/requests/${c.request.id}/basis-file`, users.contractor, {}, { name: 'arenda.pdf', data: pdf('аренда') });
    assert.equal(scanned.body.basis.blocking, false);
    const noUntil = await submit(users.contractor, await attachLetter(users.contractor, scanned.body));
    assert.equal(noUntil.status, 422);
    assert.ok(noUntil.body.fields.basisValidUntil, 'заявитель указывает срок договора аренды');
    const fresh = await card(c.request.id, users.contractor);
    const patched = await call('PATCH', `/api/v1/permits/requests/${c.request.id}`, { as: users.contractor, body: {
      ...letter, version: fresh.request.version, workType: 'maintenance', facilityId, basisType: 'lease', basisNumber: 'А-2026-17',
      basisValidUntil: day(5), periodStart: future(3), periodEnd: future(8), workerIds: [state.w1.id] } });
    const beyond = await submit(users.contractor, patched.body);
    assert.equal(beyond.status, 422);
    assert.match(beyond.body.fields.periodEnd, /срок действия договора аренды/, 'допуск не дольше договора аренды (п. 14)');
    const fixed = await call('PATCH', `/api/v1/permits/requests/${c.request.id}`, { as: users.contractor, body: {
      ...letter, version: patched.body.request.version, workType: 'maintenance', facilityId, basisType: 'lease',
      basisNumber: 'А-2026-17', basisValidUntil: day(120), periodStart: future(3), periodEnd: future(8), workerIds: [state.w1.id] } });
    const ok = await submit(users.contractor, fixed.body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    const confirmed = await call('POST', `/api/v1/permits/requests/${c.request.id}/confirm-basis`, {
      as: users.sua, body: { version: ok.body.request.version, note: 'Сверено с договором аренды', validUntil: day(120) } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const lease = await db.one<{ source: string; valid_until: string }>(
      `SELECT source, valid_until::text FROM lease_contracts WHERE number = 'А-2026-17' AND counterparty_id = $1`, [cpA]);
    assert.equal(lease?.source, 'confirmation', 'договор внесён в реестр аренды');
    state.lease = confirmed.body;
  });

  test('реестр договоров аренды: загрузка из таблицы с предпросмотром; договор из реестра подтверждает основание сам', async () => {
    const csv = `Номер;Дата;БИН;Арендатор;Объекты;Начало;Окончание\nА-РЕЕСТР-1;01.01.2026;${cpABin};;${facilityInv};01.01.2026;${day(60).split('-').reverse().join('.')}\n` +
      `А-ОШИБКА;01.01.2026;123;;;;\n`;
    const preview = await call('POST', '/api/v1/permits/leases/import', { as: users.sua, body: { csv, apply: false } });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.summary, { total: 2, save: 1, skip: 1 });
    const applied = await call('POST', '/api/v1/permits/leases/import', { as: users.sua, body: { csv, apply: true } });
    assert.equal(applied.body.summary.save, 1);
    const list = await call('GET', '/api/v1/permits/leases?q=А-РЕЕСТР', { as: users.oko });
    assert.equal(list.body.leases.length, 1);
    assert.equal((await call('POST', '/api/v1/permits/leases/import', { as: users.oko, body: { csv, apply: true } })).status, 403, 'ОКО только смотрит');

    const options = await call('GET', `/api/v1/permits/basis-options?facilityId=${facilityId}`, { as: users.contractor });
    const lease = options.body.lease.find((l: any) => l.number === 'А-РЕЕСТР-1');
    assert.ok(lease, 'договор из реестра предлагается к выбору');
    const c = await draft(users.contractor, {
      workType: 'maintenance', facilityId, basisType: 'lease', basisRefId: lease.id, periodStart: future(3), periodEnd: future(8),
      workerIds: [state.w1.id] });
    assert.equal(c.basis.ok, true);
    assert.equal(c.basis.reference.validUntil, day(60));
    const tooLong = await call('PATCH', `/api/v1/permits/requests/${c.request.id}`, { as: users.contractor, body: {
      ...letter, version: c.request.version, workType: 'maintenance', facilityId, basisType: 'lease', basisRefId: lease.id,
      periodStart: future(3), periodEnd: future(70), workerIds: [state.w1.id] } });
    const res = await submit(users.contractor, await attachLetter(users.contractor, tooLong.body));
    assert.equal(res.status, 422);
    assert.match(res.body.fields.periodEnd, /договора аренды/);
    await call('POST', `/api/v1/permits/requests/${c.request.id}/delete`, { as: users.contractor });
  });

  /* --------------------------- согласование филиала --------------------------- */

  test('ТО на АМС: согласует руководитель филиала (п. 8); до согласования выдать допуск нельзя', async () => {
    const c = await draft(users.contractor, {
      workType: 'maintenance', onAms: true, facilityId, basisType: 'lease', basisNumber: 'А-РЕЕСТР-1',
      periodStart: future(3), periodEnd: future(8), workerIds: [state.w1.id], vehicleIds: [state.vehicle.id] });
    const res = await submit(users.contractor, await attachLetter(users.contractor, c));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.branchApproval, 'pending');
    assert.deepEqual(res.body.request.branchReasons.map((x: any) => x.code), ['ams']);
    const sua = await card(res.body.request.id);
    assert.equal(sua.request.branchApproverName, users.director, 'согласует директор филиала объекта');
    assert.equal(sua.actions.approve, false);
    const early = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/approve`, { as: users.sua, body: { version: sua.request.version } });
    assert.equal(early.status, 409);

    const mail = await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_branch_approval' AND recipient = $1`, [users.director]);
    assert.ok(mail, 'руководителю филиала — письмо на согласование');
    const tasks = await call('GET', '/api/v1/tasks', { as: users.director });
    assert.ok(tasks.body.tasks.some((t: any) => t.ref === res.body.request.number), 'согласование — в «Моих задачах» директора');
    const approvals = await call('GET', '/api/v1/permits/requests?scope=approvals', { as: users.director });
    assert.ok(approvals.body.requests.some((r: any) => r.number === res.body.request.number));

    const stranger = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.stranger, body: { version: sua.request.version, approved: true } });
    assert.equal(stranger.status, 403, 'чужой филиал не согласует');
    const ok = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.director, body: { version: sua.request.version, approved: true, note: 'Работы согласованы' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.request.branchApproval, 'approved');
    state.ams = ok.body;
  });

  test('выдача допуска: код проверки, ответственный на объекте, ответ организации и копия в филиал (п. 15)', async () => {
    const c = await card(state.ams.request.id);
    assert.equal(c.actions.approve, true);
    const res = await call('POST', `/api/v1/permits/requests/${c.request.id}/approve`, { as: users.sua, body: { version: c.request.version } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'approved');
    assert.match(res.body.request.permitCode, /^[2-9A-HJ-NP-Z]{8}$/);
    assert.equal(res.body.request.siteOfficerName, users.engineer, 'ответственное лицо на объекте — по филиалу (п. 20)');
    for (const [key, to] of [['access_request_approved', users.contractor], ['access_request_approved_branch', users.engineer],
      ['access_request_approved_branch', users.director]] as const) {
      assert.ok(await db.one(`SELECT 1 FROM notifications WHERE event_key = $1 AND recipient = $2`, [key, to]), `${key} → ${to}`);
    }
    const inbox = await call('GET', '/api/v1/inbox', { as: users.contractor });
    assert.ok(inbox.body.unread > 0, 'уведомление и в «колокольчике»');
    assert.ok(inbox.body.items.some((i: any) => i.link === `/dopusk/#${res.body.request.number}`));
    const read = await call('POST', '/api/v1/inbox/read', { as: users.contractor, body: { all: true } });
    assert.equal(read.body.unread, 0);

    const page = await call('GET', `/api/v1/permits/requests/${c.request.id}/print/permit`, { as: users.contractor });
    assert.equal(page.status, 200);
    assert.match(page.body.toString('utf8'), new RegExp(res.body.request.permitCode));
    state.ams = res.body;
  });

  test('проверка на объекте: без инструктажа и СИЗ не допустить (пп. 21–22); допуск, недопуск, убытие, закрытие', async () => {
    const id = state.ams.request.id;
    const code = state.ams.request.permitCode;
    const verify = await call('GET', `/api/v1/permits/verify?q=${code}`, { as: users.engineer });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.results[0].number, state.ams.request.number);
    const outsider = await call('GET', `/api/v1/permits/verify?q=${code}`, { as: users.stranger });
    assert.equal(outsider.body.results.length, 0, 'чужой филиал допуск не видит');

    const workDate = future(4).slice(0, 10);
    const noPpe = await call('POST', `/api/v1/permits/requests/${id}/admissions`, { as: users.engineer, body: {
      workDate, workerId: state.w1.id, briefingDone: true, briefingRecord: '17', clothingOk: true, footwearOk: true,
      ppeOk: false, documentsOk: true } });
    assert.equal(noPpe.status, 422);
    assert.match(noPpe.body.fields.ppe, /п\. 22/);
    const stranger = await call('POST', `/api/v1/permits/requests/${id}/admissions`, { as: users.stranger, body: { workDate, workerId: state.w1.id } });
    assert.equal(stranger.status, 403);
    const ok = await call('POST', `/api/v1/permits/requests/${id}/admissions`, { as: users.engineer, body: {
      workDate, workerId: state.w1.id, briefingDone: true, briefingRecord: '17', clothingOk: true, footwearOk: true,
      ppeOk: true, documentsOk: true } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const car = await call('POST', `/api/v1/permits/requests/${id}/admissions`, { as: users.engineer, body: {
      workDate, vehicleId: state.vehicle.id } });
    assert.equal(car.status, 200);
    const outOfPeriod = await call('POST', `/api/v1/permits/requests/${id}/admissions`, { as: users.engineer, body: {
      workDate: day(30), workerId: state.w1.id } });
    assert.equal(outOfPeriod.status, 409, 'вне срока допуска отметка невозможна');
    const mark = ok.body.admissions.find((a: any) => a.worker_id === state.w1.id);
    const left = await call('POST', `/api/v1/permits/requests/${id}/admissions/${mark.id}/left`, { as: users.engineer });
    assert.equal(left.status, 200);
    assert.ok(left.body.admissions.find((a: any) => a.id === mark.id).left_at);

    const site = await call('GET', `/api/v1/permits/site?date=${workDate}`, { as: users.engineer });
    assert.ok(site.body.requests.some((r: any) => r.id === id && r.today.admitted === 1));
    const closed = await call('POST', `/api/v1/permits/requests/${id}/close`, { as: users.engineer,
      body: { version: (await card(id)).request.version, note: 'Замечаний нет' } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.request.status, 'closed');
    state.ams = closed.body;
  });

  test('продление (п. 19): новый запрос по прошлому допуску с той же бригадой', async () => {
    const res = await call('POST', `/api/v1/permits/requests/${state.ams.request.id}/extend`, { as: users.contractor });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'draft');
    assert.equal(res.body.request.extendsNumber, state.ams.request.number);
    assert.equal(res.body.request.periodStart, null);
    assert.equal(res.body.request.letterFileId, null, 'подписанный запрос — новый');
    assert.equal(res.body.workers.length, 1);
  });

  test('более 5 человек и изыскания — согласование филиала; отказ филиала отклоняет заявку', async () => {
    const crew = [state.w1.id];
    for (let i = 0; i < 5; i++) {
      crew.push((await addWorker(users.contractor, `Работник Номер ${i}`, makeIin(100 + i * 7), day(300))).id);
    }
    const big = await draft(users.contractor, {
      workType: 'survey', facilityId, periodStart: future(3), periodEnd: future(8), workerIds: crew });
    const res = await submit(users.contractor, await attachLetter(users.contractor, big));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.request.branchReasons.map((x: any) => x.code).sort(), ['crew', 'survey']);
    assert.equal(res.body.request.basisType, null, 'изыскания — без основания (п. 14)');
    const no = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.director, body: { version: (await card(res.body.request.id)).request.version, approved: false, note: 'Плановые работы на объекте' } });
    assert.equal(no.status, 200);
    assert.equal(no.body.request.status, 'rejected');
    assert.match(no.body.request.rejectionReason, /Не согласовано руководством филиала/);
  });

  /* ----------------------------- аварийный порядок ----------------------------- */

  test('авария (п. 18): ночью и в выходные, без запроса; устное согласование — допуск сразу, затем досылка и оформление', async () => {
    const c = await draft(users.contractor, {
      workType: 'emergency', facilityId, basisType: 'lease', basisNumber: 'А-РЕЕСТР-1', workHoursFrom: '20:00', workHoursTo: '04:00',
      weekendWork: true, periodStart: future(1, '20:00'), periodEnd: future(3, '04:00'), workerIds: [state.w1.id],
      letterNumber: '', letterDate: null, signatoryName: '', signatoryPosition: '' });
    assert.equal(c.request.isUrgent, true, 'авария всегда срочная');
    const res = await submit(users.contractor, c);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.branchApproval, 'pending');
    assert.ok(res.body.request.branchReasons.some((x: any) => x.code === 'emergency'));
    assert.equal(res.body.request.reviewDueAt, almatyToday(), 'аварийная заявка — в день обращения');

    // Директор не в системе — специалист СУА отмечает устное согласование.
    const noNote = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.sua, body: { version: res.body.request.version + 0, approved: true, channel: 'oral' } });
    assert.equal(noNote.status, 422, 'нужно указать, кто согласовал');
    const sua = await card(res.body.request.id);
    const oral = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.sua, body: { version: sua.request.version, approved: true, channel: 'oral', note: 'Директор филиала, по телефону' } });
    assert.equal(oral.status, 200, JSON.stringify(oral.body));
    assert.equal(oral.body.request.status, 'approved');
    assert.equal(oral.body.request.provisional, true);
    assert.equal(oral.body.request.branchChannel, 'oral');
    assert.ok(oral.body.request.permitCode);

    const closeEarly = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/close`, {
      as: users.engineer, body: { version: oral.body.request.version } });
    assert.equal(closeEarly.status, 409, 'неоформленный аварийный допуск закрыть нельзя');
    const finEarly = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/finalize`, {
      as: users.sua, body: { version: oral.body.request.version } });
    assert.equal(finEarly.status, 409, 'без оформленного запроса не оформить');
    const letterLater = await attachLetter(users.contractor, oral.body);
    assert.ok(letterLater.request.letterFileId);
    const fin = await call('POST', `/api/v1/permits/requests/${res.body.request.id}/finalize`, {
      as: users.sua, body: { version: letterLater.request.version } });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.request.provisional, false);
    assert.ok(fin.body.request.followupDoneAt);
    state.emergency = fin.body;
  });

  test('аварийный допуск без досылки за 2 дня — напоминание организации (п. 18)', async () => {
    const c = await draft(users.contractor, {
      workType: 'emergency', facilityId, basisType: 'lease', basisNumber: 'А-РЕЕСТР-1', periodStart: future(1), periodEnd: future(5),
      workerIds: [state.w1.id], letterNumber: '' });
    const res = await submit(users.contractor, c);
    await call('POST', `/api/v1/permits/requests/${res.body.request.id}/branch-decision`, {
      as: users.director, body: { version: res.body.request.version, approved: true } });
    await db.query(`UPDATE access_requests SET followup_due_at = now() - interval '1 hour' WHERE id = $1`, [res.body.request.id]);
    const result = await runPermitReviewControl(db);
    assert.ok(result.details!.some((d) => d.includes(res.body.request.number)));
    assert.ok(await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_followup_overdue' AND recipient = $1`, [users.contractor]));
  });

  /* ------------------------------ решение СУА ------------------------------ */

  test('одобрение без реестра — сначала подтверждение основания; файл ответа — по желанию', async () => {
    const id = state.urgent.request.id;
    const oko = await call('POST', `/api/v1/permits/requests/${id}/reject`, { as: users.oko, body: { version: state.urgent.request.version, reason: 'Тест' } });
    assert.equal(oko.status, 403, 'ОКО только просматривает');
    const early = await upload(`/api/v1/permits/requests/${id}/approve`, users.sua, { version: String(state.urgent.request.version) });
    assert.equal(early.status, 409, 'без подтверждения основания выдать нельзя');
    const confirmed = await call('POST', `/api/v1/permits/requests/${id}/confirm-basis`, {
      as: users.sua, body: { version: state.urgent.request.version, note: 'Сверено с ТУ на бумаге' } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const approved = await upload(`/api/v1/permits/requests/${id}/approve`, users.sua,
      { version: String(confirmed.body.request.version) }, { name: 'otvet.pdf', data: pdf('ответ СУА') });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const file = await call('GET', `/api/v1/permits/requests/${id}/pass-file`, { as: users.contractor });
    assert.equal(file.status, 200);
    assert.match(file.body.toString('utf8'), /ответ СУА/);
    assert.ok(await db.one(`SELECT 1 FROM events WHERE action = 'Скачивание файла' AND detail LIKE 'otvet.pdf%'`));
    state.urgent = approved.body;
  });

  test('отзыв выданного допуска — с причиной, организации и филиалу письма', async () => {
    const c = await card(state.urgent.request.id);
    const empty = await call('POST', `/api/v1/permits/requests/${c.request.id}/revoke`, { as: users.sua, body: { version: c.request.version, reason: '' } });
    assert.equal(empty.status, 422);
    const res = await call('POST', `/api/v1/permits/requests/${c.request.id}/revoke`, {
      as: users.sua, body: { version: c.request.version, reason: 'Нарушение пропускного режима' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'revoked');
    assert.ok(await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_permit_revoked' AND recipient = $1`, [users.engineer]));
  });

  test('отказ — только с причиной; организация видит причину; отзыв заявки организацией', async () => {
    const id = state.main.request.id;
    const empty = await call('POST', `/api/v1/permits/requests/${id}/reject`, { as: users.sua, body: { version: state.main.request.version, reason: '  ' } });
    assert.equal(empty.status, 422);
    const res = await call('POST', `/api/v1/permits/requests/${id}/reject`, {
      as: users.sua, body: { version: state.main.request.version, reason: 'Период работ пересекается с плановым ремонтом' } });
    assert.equal(res.status, 200);
    const seen = await card(id, users.contractor);
    assert.equal(seen.request.rejectionReason, 'Период работ пересекается с плановым ремонтом');
    assert.equal(seen.request.reviewedBy, null, 'имя специалиста подрядчику не показывается');

    const lease = await card(state.lease.request.id, users.contractor);
    const w = await call('POST', `/api/v1/permits/requests/${lease.request.id}/withdraw`, {
      as: users.contractor, body: { version: lease.request.version, reason: 'Работы перенесены' } });
    assert.equal(w.status, 200);
    assert.equal(w.body.request.status, 'withdrawn');
  });

  test('«Подать повторно»: новый черновик с той же бригадой, без периода', async () => {
    const res = await call('POST', `/api/v1/permits/requests/${state.main.request.id}/copy`, { as: users.contractor });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'draft');
    assert.equal(res.body.workers.length, 2);
    assert.equal(res.body.request.periodStart, null);
  });

  /* ------------------------------ иностранцы ------------------------------ */

  test('иностранец (п. 16): без копий паспорта и визы заявку не отправить', async () => {
    const w = await call('POST', '/api/v1/permits/workers', { as: users.contractor, body: {
      fullName: 'Мюллер Ханс', fullNameLatin: 'Mueller Hans', citizenship: 'DE', idDocNumber: 'C01X00T47',
      birthDate: '1980-02-02', birthPlace: 'Berlin', idDocIssuedAt: '2019-01-01', idDocIssuedBy: 'Stadt Berlin',
      address: 'Berlin, Unter den Linden 1', position: 'Инженер' } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractor,
      { title: 'Допуск к работам на высоте', validUntil: day(300) }, { name: 'q.pdf', data: pdf('q') });
    const c = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisRefId: tuId, periodStart: future(3), periodEnd: future(8),
      workerIds: [w.body.worker.id] });
    const res = await submit(users.contractor, await attachLetter(users.contractor, c));
    assert.equal(res.status, 422);
    assert.match(res.body.fields.workers, /паспорта/);
    assert.match(res.body.fields.workers, /визы/);
    await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractor,
      { kind: 'passport', validUntil: day(1000) }, { name: 'pass.pdf', data: pdf('p') });
    await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractor,
      { kind: 'visa', validUntil: day(60) }, { name: 'visa.pdf', data: pdf('v') });
    const ok = await submit(users.contractor, await card(c.request.id, users.contractor));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('заблокированная организация заявку подать не может', async () => {
    const w = await call('POST', '/api/v1/permits/workers', {
      as: users.contractorC, body: { fullName: 'Сидоров Сидор Сидорович', iin: '781231400145', ...appendix('781231400145') } });
    await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractorC,
      { title: 'Высота', validUntil: day(100) }, { name: 'u.pdf', data: pdf('s') });
    const c = await draft(users.contractorC, {
      workType: 'maintenance', facilityId, basisType: 'lease', basisNumber: 'А-1', basisValidUntil: day(100),
      periodStart: future(3), periodEnd: future(8), workerIds: [w.body.worker.id] });
    await upload(`/api/v1/permits/requests/${c.request.id}/basis-file`, users.contractorC, {}, { name: 'a.pdf', data: pdf('a') });
    await attachLetter(users.contractorC, c);
    await db.query(`UPDATE counterparties SET status = 'blocked' WHERE id = $1`, [cpBlocked]);
    const res = await submit(users.contractorC, await card(c.request.id, users.contractorC));
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.counterparty);
    await db.query(`UPDATE counterparties SET status = $2 WHERE id = $1`, [cpBlocked, cpBlockedStatus]);
  });

  /* --------------------------- замещение и сроки --------------------------- */

  test('замещение: на время отпуска задачи и письма специалиста СУА видит замещающий', async () => {
    const res = await call('POST', '/api/v1/absences', { as: users.sua, body: {
      substituteId: ids.oko, dateFrom: day(0), dateTo: day(10), reason: 'отпуск' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const overlap = await call('POST', '/api/v1/absences', { as: users.sua, body: { substituteId: ids.oko, dateFrom: day(5), dateTo: day(6) } });
    assert.equal(overlap.status, 409);
    const tasks = await call('GET', '/api/v1/tasks', { as: users.oko });
    assert.ok(tasks.body.tasks.some((t: any) => t.kind === 'permit' && t.onBehalfOf === users.sua), 'задачи отсутствующего — у замещающего');

    const c = await draft(users.contractor, {
      workType: 'installation', facilityId, basisType: 'tu', basisRefId: tuId, periodStart: future(3), periodEnd: future(8),
      workerIds: [state.w1.id] });
    const sent = await submit(users.contractor, await attachLetter(users.contractor, c));
    assert.equal(sent.status, 200);
    const copy = await db.one<{ subject: string }>(
      `SELECT subject FROM notifications WHERE event_key = 'access_request_submitted' AND recipient = $1 ORDER BY created_at DESC LIMIT 1`, [users.oko]);
    assert.match(copy?.subject ?? '', /\[за sua@permits\.test\]/, 'письмо отсутствующего дублируется замещающему');
    const other = await call('POST', '/api/v1/absences', { as: users.contractor, body: { substituteId: ids.oko, dateFrom: day(0), dateTo: day(1) } });
    assert.equal(other.status, 403, 'внешним пользователям замещение недоступно');
    await call('POST', `/api/v1/absences/${res.body.id}/delete`, { as: users.sua });
  });

  test('сроки: просрочка рассмотрения (14 р.д.) — письмо исполнителю; истекающие документы — организации', async () => {
    await db.query(`UPDATE access_requests SET review_due_at = current_date - 1 WHERE status = 'pending_review'`);
    const review = await runPermitReviewControl(db);
    assert.ok(review.affected >= 1);
    assert.ok(await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_review_overdue' AND recipient = $1`, [users.sua]));
    const again = await runPermitReviewControl(db);
    assert.equal(again.details!.filter((d) => d.includes('рассмотрение')).length, 0, 'повторно не напоминает');
    await upload(`/api/v1/permits/workers/${state.w1.id}/documents`, users.contractor,
      { title: 'Электробезопасность', validUntil: day(10) }, { name: 'el.pdf', data: pdf('эл') });
    const expiry = await runPermitExpiry(db);
    assert.ok(expiry.affected >= 1, 'удостоверение истекает через 10 дней');
    assert.ok(await db.one(`SELECT 1 FROM notifications WHERE event_key = 'worker_document_expiring' AND recipient = $1`, [users.contractor]));
  });

  /* -------------------------------- отчёт и журнал -------------------------------- */

  test('отчёт по заявкам: итоги и выгрузка XLSX', async () => {
    const res = await call('GET', '/api/v1/permits/reports/requests', { as: users.sua });
    assert.equal(res.status, 200);
    assert.ok(res.body.summary.approved >= 2);
    assert.ok(res.body.summary.rejected >= 2);
    assert.ok(res.body.summary.emergency >= 2);
    assert.ok(res.body.summary.branchApproval >= 3);
    const xlsx = await call('GET', '/api/v1/permits/reports/requests?format=xlsx', { as: users.oko });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
    assert.equal((await call('GET', '/api/v1/permits/reports/requests', { as: users.contractor })).status, 403);
  });

  test('журнал действий неизменяем: исправить или удалить запись нельзя и в обход приложения', async () => {
    const row = await db.one<{ id: string }>(`SELECT id FROM events ORDER BY id DESC LIMIT 1`);
    await assert.rejects(db.query(`UPDATE events SET detail = 'подмена' WHERE id = $1`, [row!.id]), /изменять и удалять нельзя/);
    await assert.rejects(db.query(`DELETE FROM events WHERE id = $1`, [row!.id]), /изменять и удалять нельзя/);
  });
});
