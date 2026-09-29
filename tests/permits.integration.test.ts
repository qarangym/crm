/**
 * Портал допусков: сквозной тест против настоящей PostgreSQL.
 *
 * Сценарии — критерии приёмки первого этапа (План модуля допусков, §10; ТЗ
 * портала §6.2): бригада и сроки удостоверений, проверка основания в мягком и
 * строгом режимах, рассмотрение специалистом СУА с файлом допуска, отказ с
 * причиной, срочные заявки, права, письма, отчёт.
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

const URL_ENV = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));

const PERMIT_TABLES = ['access_request_vehicles', 'access_request_workers', 'access_requests',
  'access_request_counters', 'crew_vehicles', 'crew_members', 'contractor_crews', 'worker_documents',
  'contractor_vehicles', 'contractor_workers', 'permit_files'];

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
  };

  let cpA = '';
  let cpB = '';
  let cpBlocked = '';
  let cpBlockedStatus = '';
  let facilityId = '';
  let otherFacilityId = '';
  let tuId = '';
  let actId = '';
  const future = (days: number, time = '09:00') =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) + 'T' + time;

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
    await db.query(`DELETE FROM events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE '%permits.test')`);
    await db.query(`DELETE FROM documents WHERE number LIKE 'П-ТЕСТ-%'`);
    await db.query(`DELETE FROM contracts WHERE number LIKE 'П-ТЕСТ-%'`);
    await db.query(`DELETE FROM users WHERE email LIKE '%permits.test'`);
    await db.query(`UPDATE settings SET value = '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft"}'
                     WHERE key = 'permits.basis_mode'`);

    const cps = await db.query<{ id: string; status: string }>(`SELECT id, status FROM counterparties ORDER BY bin`);
    assert.ok(cps.length >= 3, 'справочники не заполнены: выполните npm run seed:demo');
    cpA = cps[0].id;
    cpB = cps[cps.length - 1].id;
    cpBlocked = cps[1].id;
    cpBlockedStatus = cps[1].status;
    const facilities = await db.query<{ id: string }>(`SELECT id FROM facilities WHERE is_active ORDER BY inv_no LIMIT 2`);
    facilityId = facilities[0].id;
    otherFacilityId = facilities[1].id;

    const roles: Record<keyof typeof users, string[]> = {
      contractor: ['contractor'], contractorB: ['contractor'], contractorC: ['contractor'], customer: ['customer'],
      sua: ['permits'], oko: ['oko'], admin: ['admin'],
    };
    // Организация A представлена в обоих кабинетах — разными учётными записями.
    const cpOf: Partial<Record<keyof typeof users, string>> = {
      contractor: cpA, contractorB: cpB, contractorC: cpBlocked, customer: cpA,
    };
    let adminId = '';
    for (const [key, email] of Object.entries(users) as [keyof typeof users, string][]) {
      const u = await db.one<{ id: string }>(
        `INSERT INTO users (email, oidc_subject, full_name, counterparty_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [email, identityId(ISSUER, 'subject-' + email), email, cpOf[key] ?? null]);
      for (const role of roles[key]) await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1,$2)`, [u!.id, role]);
      if (key === 'admin') adminId = u!.id;
    }

    // Основания в реестрах системы: ТУ и акт — в архиве, договор на СМР — в договорах ОР ПСД.
    tuId = (await db.one<{ id: string }>(
      `INSERT INTO documents (kind, number, facility_id, owner_id, doc_date, valid_until, approved, created_by)
       VALUES ('ТУ', 'П-ТЕСТ-ТУ-1', $1, $2, current_date - 10, current_date + 150, true, $3) RETURNING id`,
      [facilityId, cpA, adminId]))!.id;
    actId = (await db.one<{ id: string }>(
      `INSERT INTO documents (kind, number, facility_id, owner_id, doc_date, approved, created_by)
       VALUES ('Акт приема-передачи', 'П-ТЕСТ-АПП-1', $1, $2, current_date - 5, true, $3) RETURNING id`,
      [facilityId, cpA, adminId]))!.id;
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
    await db.query(`UPDATE settings SET value = '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft"}',
                     updated_by = NULL WHERE key = 'permits.basis_mode'`).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  /* ------------------------------ помощники ------------------------------ */

  async function addWorker(as: string, fullName: string, iin: string, validUntil: string) {
    const w = await call('POST', '/api/v1/permits/workers', { as, body: { fullName, iin, position: 'Монтажник' } });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    const d = await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, as,
      { title: 'Допуск к работам на высоте', number: 'В-' + iin.slice(-4), validUntil }, { name: 'udost.pdf', data: pdf(fullName) });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    return d.body.worker;
  }

  async function draft(as: string, body: Record<string, unknown>) {
    const res = await call('POST', '/api/v1/permits/requests', { as, body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }

  async function submit(as: string, card: any, consent = true) {
    return call('POST', `/api/v1/permits/requests/${card.request.id}/submit`, {
      as, body: { version: card.request.version, consent },
    });
  }

  const state: Record<string, any> = {};

  /* ------------------------------- доступ ------------------------------- */

  test('подрядчик входит только в портал допусков; заявки и справочники ОР ПСД ему закрыты', async () => {
    const me = await call('GET', '/api/v1/me', { as: users.contractor });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.modules, ['permits']);
    assert.equal(me.body.isExternal, true);
    for (const path of ['/api/v1/requests', '/api/v1/board', '/api/v1/rules', '/api/v1/facilities',
      '/api/v1/documents', '/api/v1/users', '/api/v1/assignments']) {
      const res = await call('GET', path, { as: users.contractor });
      assert.equal(res.status, 403, `${path} должен быть закрыт подрядчику`);
    }
    const sua = await call('GET', '/api/v1/me', { as: users.sua });
    assert.deepEqual(sua.body.modules, ['orpsd', 'permits'], 'СУА видит архив актов и портал допусков');
  });

  test('кабинеты не пересекаются: Заказчик не подаёт заявку на допуск, подрядчик — заявку на услуги', async () => {
    // Заказчик той же организации, что и подрядчик, в портал допусков не входит.
    const me = await call('GET', '/api/v1/me', { as: users.customer });
    assert.deepEqual(me.body.modules, ['orpsd']);
    for (const [method, path] of [['GET', '/api/v1/permits/requests'], ['GET', '/api/v1/permits/meta'],
      ['GET', '/api/v1/permits/workers'], ['POST', '/api/v1/permits/requests']] as const) {
      const res = await call(method, path, { as: users.customer, body: method === 'POST' ? { facilityId } : undefined });
      assert.equal(res.status, 403, `${method} ${path} закрыт Заказчику`);
    }
    // Подрядчик не подаёт заявку на услуги ОР ПСД.
    const order = await call('POST', '/api/v1/requests', {
      as: users.contractor, body: { draft: true, facilityId, services: [] } });
    assert.equal(order.status, 403);

    // Совместить роли нельзя ни через API, ни записью в базу в обход него.
    const combined = await call('POST', '/api/v1/users', {
      as: users.admin, body: { email: 'mixed@a.permits.test', fullName: 'Совмещённая учётная запись',
        roles: ['customer', 'contractor'], counterpartyId: cpA } });
    assert.equal(combined.status, 422);
    assert.match(combined.body.fields.roles, /разные учётные записи/);
    const withStaff = await call('POST', '/api/v1/users', {
      as: users.admin, body: { email: 'mixed@a.permits.test', fullName: 'Совмещённая учётная запись',
        roles: ['contractor', 'orpsd'], counterpartyId: cpA } });
    assert.equal(withStaff.status, 422, 'внешняя роль не совмещается и с ролями сотрудников');
    const customerId = (await db.one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [users.customer]))!.id;
    await assert.rejects(db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'contractor')`, [customerId]),
      /не совмещается/);
  });

  test('портал открывается отдельной ссылкой /dopusk/', async () => {
    const redirect = await fetch(base + '/dopusk', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/dopusk/');
    const page = await fetch(base + '/dopusk/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Портал допусков/);
  });

  /* ------------------------ работники и бригады ------------------------ */

  test('работник: ИИН проверяется, удостоверение — со сроком и сканом', async () => {
    const bad = await call('POST', '/api/v1/permits/workers', {
      as: users.contractor, body: { fullName: 'Петров Пётр Петрович', iin: '850101300125' } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.fields.iin);

    const w = await call('POST', '/api/v1/permits/workers', {
      as: users.contractor, body: { fullName: 'Петров Пётр Петрович', iin: '900515400133' } });
    const noFile = await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractor,
      { title: 'Электробезопасность', validUntil: '2027-01-01' });
    assert.equal(noFile.status, 422);
    assert.ok(noFile.body.fields.file);

    state.w1 = await addWorker(users.contractor, 'Иванов Иван Иванович', '850101300124', future(200).slice(0, 10));
    state.w2 = await addWorker(users.contractor, 'Петров Пётр Петрович', '900515400133', future(2).slice(0, 10));
    assert.equal(state.w1.documents.length, 1);
    assert.equal(state.w1.documents[0].fileName, 'udost.pdf');
  });

  test('транспорт и сохранённая бригада', async () => {
    const v = await call('POST', '/api/v1/permits/vehicles', {
      as: users.contractor, body: { plate: '123 abc 02', model: 'ГАЗель', driverName: 'Иванов И.И.' } });
    assert.equal(v.status, 200);
    assert.equal(v.body.vehicle.plate, '123ABC02');
    state.vehicle = v.body.vehicle;

    const crew = await call('POST', '/api/v1/permits/crews', {
      as: users.contractor,
      body: { name: 'Монтажная бригада', workerIds: [state.w1.id, state.w2.id], vehicleIds: [state.vehicle.id] } });
    assert.equal(crew.status, 200, JSON.stringify(crew.body));
    assert.equal(crew.body.crew.worker_ids.length, 2);
    state.crew = crew.body.crew;

    // Чужая организация не видит сотрудников и не может взять их в свою бригаду.
    const foreign = await call('POST', '/api/v1/permits/crews', {
      as: users.contractorB, body: { name: 'Чужая', workerIds: [state.w1.id] } });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.crew.worker_ids.length, 0);
    const list = await call('GET', '/api/v1/permits/workers', { as: users.contractorB });
    assert.equal(list.body.workers.length, 0);
  });

  /* ---------------------- заявка: основание и бригада ---------------------- */

  test('заявка с сохранённой бригадой: удостоверение, истекающее до начала работ, не пропускается', async () => {
    const options = await call('GET', `/api/v1/permits/basis-options?facilityId=${facilityId}`, { as: users.contractor });
    assert.equal(options.status, 200);
    assert.ok(options.body.tu.some((t: any) => t.id === tuId), 'ТУ организации предлагаются к выбору');
    assert.ok(options.body.transfer_act.some((t: any) => t.id === actId));

    const card = await draft(users.contractor, {
      facilityId, basisType: 'tu', basisRefId: tuId, periodStart: future(5), periodEnd: future(7, '18:00'),
      crewId: state.crew.id, workerIds: state.crew.worker_ids, vehicleIds: state.crew.vehicle_ids,
      description: 'Монтаж антенны на отметке 45 м',
    });
    assert.equal(card.request.status, 'draft');
    assert.match(card.request.number, /^ЗД-\d{4}-\d{4}$/);
    assert.equal(card.request.basisNumber, 'П-ТЕСТ-ТУ-1', 'номер взят из реестра');
    assert.equal(card.basis.code, 'ok');
    assert.equal(card.issues.length, 1, 'у Петрова удостоверение истекает до начала работ');
    assert.equal(card.issues[0].code, 'expired');

    const res = await submit(users.contractor, card, false);
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.workers);
    assert.ok(res.body.fields.consent);
    state.main = card;
  });

  test('после обновления удостоверения заявка отправляется; основание подтверждено реестром', async () => {
    const doc = state.w2.documents[0];
    const upd = await upload(`/api/v1/permits/workers/${state.w2.id}/documents`, users.contractor,
      { documentId: doc.id, title: doc.title, validUntil: future(300).slice(0, 10) });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));

    const card = (await call('GET', `/api/v1/permits/requests/${state.main.request.id}`, { as: users.contractor })).body;
    assert.equal(card.issues.length, 0);
    const res = await submit(users.contractor, card);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'pending_review');
    assert.equal(res.body.basis.ok, true);
    assert.equal(res.body.actions.approve, false, 'подрядчик не рассматривает');
    state.main = res.body;

    const mail = await db.query<{ recipient: string; subject: string }>(
      `SELECT recipient, subject FROM notifications WHERE event_key = 'access_request_submitted'`);
    assert.ok(mail.some((m) => m.recipient === users.sua), 'СУА получает письмо о новой заявке');

    const again = await call('PATCH', `/api/v1/permits/requests/${state.main.request.id}`, {
      as: users.contractor, body: { version: state.main.request.version, facilityId } });
    assert.equal(again.status, 409, 'отправленную заявку изменить нельзя');
  });

  test('чужая организация не открывает заявку и сканы — отказ пишется в журнал', async () => {
    const id = state.main.request.id;
    const res = await call('GET', `/api/v1/permits/requests/${id}`, { as: users.contractorB });
    assert.equal(res.status, 403);
    const event = await db.one(`SELECT result FROM events WHERE entity = 'access_request' AND entity_id = $1 AND result = 'denied'`, [id]);
    assert.ok(event, 'попытка зафиксирована как отказ');

    const scan = state.main.workers[0].documents[0].fileId;
    const file = await call('GET', `/api/v1/permits/files/${scan}`, { as: users.contractorB });
    assert.equal(file.status, 403);
    const pass = await call('GET', `/api/v1/permits/requests/${id}/pass-file`, { as: users.contractorB });
    assert.equal(pass.status, 403);
  });

  test('черновик виден только организации, в очереди СУА его нет', async () => {
    const card = await draft(users.contractor, { facilityId, basisType: 'tu', basisRefId: tuId });
    const res = await call('GET', `/api/v1/permits/requests/${card.request.id}`, { as: users.sua });
    assert.equal(res.status, 403);
    const del = await call('POST', `/api/v1/permits/requests/${card.request.id}/delete`, { as: users.contractor });
    assert.equal(del.status, 200);
  });

  /* ------------------------- мягкий и строгий режим ------------------------- */

  test('мягкий режим: несуществующие ТУ — предупреждение; срочная заявка — первой в очереди', async () => {
    const card = await draft(users.contractor, {
      facilityId, basisType: 'tu', basisNumber: 'НЕТ-ТАКИХ-ТУ', periodStart: future(3), periodEnd: future(4),
      workerIds: [state.w1.id], isUrgent: true,
    });
    assert.equal(card.basis.code, 'not_found');
    assert.equal(card.basis.blocking, false);
    const res = await submit(users.contractor, card);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.basis.needsConfirmation, true);
    state.urgent = res.body;

    const queue = await call('GET', '/api/v1/permits/requests?queue=1', { as: users.sua });
    assert.equal(queue.status, 200);
    assert.equal(queue.body.requests[0].number, state.urgent.request.number, 'срочная — в начале очереди');
    assert.ok(queue.body.requests.some((r: any) => r.number === state.main.request.number));
  });

  test('строгий режим: несуществующие ТУ и истёкший договор — отправить нельзя', async () => {
    const denied = await call('POST', '/api/v1/permits/settings', { as: users.sua, body: { modes: { tu: 'strict' } } });
    assert.equal(denied.status, 403, 'режим меняет ДИТ');
    const set = await call('POST', '/api/v1/permits/settings', {
      as: users.admin, body: { modes: { tu: 'strict', smr_contract: 'strict', lease: 'strict' } } });
    assert.equal(set.status, 200);
    assert.equal(set.body.modes.lease, 'soft', 'для договора аренды строгий режим невозможен');

    const tu = await draft(users.contractor, {
      facilityId, basisType: 'tu', basisNumber: 'НЕТ-ТАКИХ-ТУ', periodStart: future(3), periodEnd: future(4),
      workerIds: [state.w1.id] });
    const r1 = await submit(users.contractor, tu);
    assert.equal(r1.status, 422);
    assert.match(r1.body.fields.basis, /отправить нельзя/);

    const contract = await draft(users.contractor, {
      facilityId, basisType: 'smr_contract', basisNumber: 'П-ТЕСТ-Д-ИСТЁК', periodStart: future(3), periodEnd: future(4),
      workerIds: [state.w1.id] });
    assert.equal(contract.basis.code, 'expired');
    const r2 = await submit(users.contractor, contract);
    assert.equal(r2.status, 422);

    await call('POST', '/api/v1/permits/settings', { as: users.admin, body: { modes: {} } });
  });

  test('акт приёма-передачи: без акта в архиве нужен скан; договор аренды — по скану', async () => {
    const act = await draft(users.contractor, {
      facilityId: otherFacilityId, basisType: 'transfer_act', basisNumber: 'АПП-НЕТ', periodStart: future(3),
      periodEnd: future(4), workerIds: [state.w1.id] });
    assert.equal(act.basis.blocking, true);
    const noScan = await submit(users.contractor, act);
    assert.equal(noScan.status, 422);
    const withScan = await upload(`/api/v1/permits/requests/${act.request.id}/basis-file`, users.contractor, {},
      { name: 'akt.pdf', data: pdf('акт') });
    assert.equal(withScan.status, 200);
    assert.equal(withScan.body.basis.blocking, false);
    const ok = await submit(users.contractor, withScan.body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    state.act = ok.body;

    const lease = await draft(users.contractor, {
      facilityId, basisType: 'lease', basisNumber: 'А-2025-17', periodStart: future(3), periodEnd: future(4),
      workerIds: [state.w1.id] });
    assert.equal(lease.basis.code, 'no_registry');
    assert.equal((await submit(users.contractor, lease)).status, 422, 'без скана договора аренды — нельзя');
  });

  /* ------------------------------ решение СУА ------------------------------ */

  test('одобрение: основание без реестра — сначала подтверждение вручную, затем файл допуска', async () => {
    const id = state.urgent.request.id;
    const oko = await call('POST', `/api/v1/permits/requests/${id}/reject`, {
      as: users.oko, body: { version: state.urgent.request.version, reason: 'Тест' } });
    assert.equal(oko.status, 403, 'ОКО только просматривает');

    const early = await upload(`/api/v1/permits/requests/${id}/approve`, users.sua,
      { version: String(state.urgent.request.version) }, { name: 'dopusk.pdf', data: pdf('допуск') });
    assert.equal(early.status, 409, 'без подтверждения основания одобрить нельзя');

    const confirmed = await call('POST', `/api/v1/permits/requests/${id}/confirm-basis`, {
      as: users.sua, body: { version: state.urgent.request.version, note: 'Сверено с письмом арендатора' } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.ok(confirmed.body.request.basisConfirmedAt);

    const noFile = await upload(`/api/v1/permits/requests/${id}/approve`, users.sua,
      { version: String(confirmed.body.request.version) });
    assert.equal(noFile.status, 422);

    const approved = await upload(`/api/v1/permits/requests/${id}/approve`, users.sua,
      { version: String(confirmed.body.request.version) }, { name: 'dopusk.pdf', data: pdf('допуск ЗД') });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.status, 'approved');

    const file = await call('GET', `/api/v1/permits/requests/${id}/pass-file`, { as: users.contractor });
    assert.equal(file.status, 200);
    assert.match(file.body.toString('utf8'), /допуск ЗД/);
    const logged = await db.one(`SELECT 1 FROM events WHERE action = 'Скачивание файла' AND detail LIKE 'dopusk.pdf%'`);
    assert.ok(logged, 'скачивание пишется в журнал');
    const mail = await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_request_approved' AND recipient = $1`,
      [users.contractor]);
    assert.ok(mail, 'подрядчику — письмо об одобрении');
  });

  test('отказ: без причины нельзя; с причиной — подрядчик видит её, решение окончательное', async () => {
    const id = state.main.request.id;
    const empty = await call('POST', `/api/v1/permits/requests/${id}/reject`, {
      as: users.sua, body: { version: state.main.request.version, reason: '   ' } });
    assert.equal(empty.status, 422);
    const res = await call('POST', `/api/v1/permits/requests/${id}/reject`, {
      as: users.sua, body: { version: state.main.request.version, reason: 'Период работ пересекается с плановым ремонтом' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'rejected');

    const seen = await call('GET', `/api/v1/permits/requests/${id}`, { as: users.contractor });
    assert.equal(seen.body.request.rejectionReason, 'Период работ пересекается с плановым ремонтом');
    assert.equal(seen.body.request.reviewedBy, null, 'имя специалиста подрядчику не показывается');
    const again = await call('POST', `/api/v1/permits/requests/${id}/reject`, {
      as: users.sua, body: { version: res.body.request.version, reason: 'Повторно' } });
    assert.equal(again.status, 409);
    const mail = await db.one(`SELECT 1 FROM notifications WHERE event_key = 'access_request_rejected' AND recipient = $1`,
      [users.contractor]);
    assert.ok(mail);
  });

  test('«Подать повторно»: новый черновик с той же бригадой, без периода', async () => {
    const res = await call('POST', `/api/v1/permits/requests/${state.main.request.id}/copy`, { as: users.contractor });
    assert.equal(res.status, 200);
    assert.equal(res.body.request.status, 'draft');
    assert.notEqual(res.body.request.number, state.main.request.number);
    assert.equal(res.body.workers.length, 2);
    assert.equal(res.body.request.periodStart, null);
  });

  test('СУА открывает скан удостоверения только в составе заявки', async () => {
    const scan = state.act.workers[0].documents[0].fileId;
    const direct = await call('GET', `/api/v1/permits/files/${scan}`, { as: users.sua });
    assert.equal(direct.status, 403);
    const inRequest = await call('GET', `/api/v1/permits/files/${scan}?request=${state.act.request.id}&preview=1`, { as: users.sua });
    assert.equal(inRequest.status, 200);
    const card = await call('GET', `/api/v1/permits/requests/${state.act.request.id}`, { as: users.oko });
    assert.equal(card.status, 200);
    assert.match(card.body.workers[0].iin, /^•+\d{4}$/, 'ОКО видит ИИН без первых цифр');
  });

  test('заблокированная организация заявку подать не может', async () => {
    const w = await call('POST', '/api/v1/permits/workers', {
      as: users.contractorC, body: { fullName: 'Сидоров Сидор Сидорович', iin: '781231400145' } });
    await upload(`/api/v1/permits/workers/${w.body.worker.id}/documents`, users.contractorC,
      { title: 'Высота', validUntil: future(100).slice(0, 10) }, { name: 'u.pdf', data: pdf('s') });
    const card = await draft(users.contractorC, {
      facilityId, basisType: 'lease', basisNumber: 'А-1', periodStart: future(3), periodEnd: future(4),
      workerIds: [w.body.worker.id] });
    await upload(`/api/v1/permits/requests/${card.request.id}/basis-file`, users.contractorC, {}, { name: 'a.pdf', data: pdf('a') });
    await db.query(`UPDATE counterparties SET status = 'blocked' WHERE id = $1`, [cpBlocked]);
    const fresh = (await call('GET', `/api/v1/permits/requests/${card.request.id}`, { as: users.contractorC })).body;
    const res = await submit(users.contractorC, fresh);
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.counterparty);
    await db.query(`UPDATE counterparties SET status = $2 WHERE id = $1`, [cpBlocked, cpBlockedStatus]);
  });

  /* -------------------------------- отчёт -------------------------------- */

  test('отчёт по заявкам: итоги и выгрузка XLSX', async () => {
    const res = await call('GET', '/api/v1/permits/reports/requests', { as: users.sua });
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.approved, 1);
    assert.equal(res.body.summary.rejected, 1);
    assert.equal(res.body.summary.manualBasis, 1);
    assert.ok(res.body.summary.total >= 3);

    const xlsx = await call('GET', '/api/v1/permits/reports/requests?format=xlsx', { as: users.oko });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.type, /spreadsheetml/);
    assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK');
    const forbidden = await call('GET', '/api/v1/permits/reports/requests', { as: users.contractor });
    assert.equal(forbidden.status, 403);
  });
});
