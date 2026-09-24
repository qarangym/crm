/**
 * Сквозной тест против настоящей PostgreSQL.
 *
 * Проверяет то, что нельзя проверить без базы: SQL-запросы, ограничения схемы,
 * транзакции, оптимистичные блокировки и поведение API целиком — от подачи
 * заявки до закрытия по Регламенту.
 *
 * База поднимается тестом самостоятельно, если задана TEST_DATABASE_URL:
 *   docker run -d --name qtr-pg-test -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_USER=qtr -e POSTGRES_DB=qtr_crm_test -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://qtr:testpass@127.0.0.1:55432/qtr_crm_test npm run test:integration
 *
 * Без переменной тест пропускается — обычный `npm test` от базы не зависит.
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
import { runAllJobs, runAvrSilence, runEscalations, runOfferExpiry } from '../src/process/scheduler.ts';
import { processQueue } from '../src/server/notifications.ts';

const URL_ENV = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));

describe('сквозной тест с PostgreSQL', { skip: URL_ENV ? false : 'не задан TEST_DATABASE_URL' }, () => {
  let db: Db;
  let server: Server;
  let base: string;

  const SECRET = 'i'.repeat(48);
  const ISSUER = 'https://sso.test/realms/qtr';
  const auth: AuthConfig = { enabled: true, proxySecret: SECRET, issuer: ISSUER, devIdentity: null };

  /** Запрос от имени пользователя: личность подставляется как это делает прокси. */
  async function call(
    method: string, path: string,
    options: { as?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.as) {
      headers['x-qtr-proxy-key'] = SECRET;
      headers['x-qtr-user-id'] = 'subject-' + options.as;
      headers['x-qtr-user-email'] = options.as;
      headers['x-qtr-user-name'] = options.as;
    }
    const res = await fetch(base + path, {
      method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const users = {
    admin: 'admin@qtr.kz',
    records: 'records@qtr.kz',
    orpsd: 'orpsd@qtr.kz',
    assets: 'assets@qtr.kz',
    customer: 'customer@spektr.kz',
    branchUser: 'branch@qtr.kz',
    oko: 'oko@qtr.kz',
    accounting: 'accounting@qtr.kz',
    stranger: 'stranger@other.kz',
  };

  let facilityId = '';
  let counterpartyId = '';
  let otherCounterpartyId = '';
  let tariffTu = '';
  let tariffPsd = '';
  let storeRoot = '';

  before(async () => {
    db = createDb(URL_ENV!);
    await migrate(db, join(here, '..', 'src', 'db'));

    // Чистим данные прошлых прогонов в порядке зависимостей.
    // TRUNCATE ... CASCADE здесь нельзя: через branches.curator_id → users
    // он снёс бы справочники филиалов и объектов. Адресатов эскалации
    // (п. 100), назначенных прошлым прогоном, отвязываем от филиалов.
    await db.query(
      `UPDATE branches SET curator_id = NULL, director_id = NULL, chief_engineer_id = NULL, board_curator_id = NULL`);
    for (const table of ['file_versions', 'documents', 'escalations', 'memos', 'assignments',
      'request_remarks', 'request_stages', 'request_services', 'contracts', 'requests',
      'request_counters', 'notifications', 'events', 'registry_versions', 'user_roles', 'users']) {
      await db.query(`DELETE FROM ${table}`);
    }

    const facility = await db.one<{ id: string }>(`SELECT id FROM facilities WHERE inv_no = '1187'`);
    assert.ok(facility, 'справочники не заполнены: выполните npm run seed:demo');
    facilityId = facility!.id;

    const cp = await db.one<{ id: string }>(`SELECT id FROM counterparties ORDER BY bin LIMIT 1`);
    counterpartyId = cp!.id;
    const other = await db.one<{ id: string }>(`SELECT id FROM counterparties ORDER BY bin DESC LIMIT 1`);
    otherCounterpartyId = other!.id;

    tariffTu = (await db.one<{ id: string }>(`SELECT id FROM tariffs WHERE service = 'ТУ' ORDER BY amount DESC LIMIT 1`))!.id;
    tariffPsd = (await db.one<{ id: string }>(`SELECT id FROM tariffs WHERE service = 'ПСД' ORDER BY amount DESC LIMIT 1`))!.id;

    // Пользователи с ролями заводятся так же, как это делает администратор ДИТ.
    for (const [role, email] of Object.entries(users)) {
      if (role === 'stranger') continue;
      const u = await db.one<{ id: string }>(
        `INSERT INTO users (email, oidc_subject, full_name, counterparty_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, identityId(ISSUER, 'subject-' + email), email,
         role === 'customer' ? counterpartyId : null]);
      const dbRole = role === 'branchUser' ? 'branch' : role;
      await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, $2)`, [u!.id, dbRole]);
    }

    storeRoot = await mkdtemp(join(tmpdir(), 'qtr-files-'));
    const handle = createApp({
      db, auth, staticRoot: undefined, trustProxy: true,
      store: new FileStore(storeRoot),
    });
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
  });

  /** Загрузка файла как это делает браузер: multipart/form-data. */
  async function upload(
    path: string, as: string,
    fields: Record<string, string>, file: { name: string; data: Buffer },
  ): Promise<{ status: number; body: any }> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new Blob([file.data]), file.name);
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'x-qtr-proxy-key': SECRET,
        'x-qtr-user-id': 'subject-' + as,
        'x-qtr-user-email': as,
        'x-qtr-user-name': as,
      },
      body: form,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** Минимальный корректный PDF: проверяется сигнатура файла. */
  const pdf = (text: string) => Buffer.from(`%PDF-1.4
% ${text}
%%EOF
`, 'utf8');

  /* ------------------------------- доступ ------------------------------- */

  test('без доверенных заголовков API отвечает 401', async () => {
    const res = await call('GET', '/api/v1/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'unauthorized');
  });

  test('подделка заголовков без секрета отклоняется', async () => {
    const res = await fetch(base + '/api/v1/me', {
      headers: { 'x-qtr-user-email': users.admin, 'x-qtr-user-id': 'subject-' + users.admin },
    });
    assert.equal(res.status, 401);
  });

  test('неизвестная учётная запись получает понятный отказ, а не создаётся сама', async () => {
    const res = await call('GET', '/api/v1/me', { as: users.stranger });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /не заведена/);
  });

  test('проверка доступности работает без входа', async () => {
    const res = await call('GET', '/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  test('роли и права возвращаются из базы', async () => {
    const res = await call('GET', '/api/v1/me', { as: users.orpsd });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.roles, ['orpsd']);
    assert.ok(res.body.permissions.includes('request.transition'));
    assert.ok(!res.body.permissions.includes('registry.edit'), 'реестр правит только техучёт (п. 12)');
  });

  test('конфигурация процесса отдаётся со ссылками на пункты', async () => {
    const res = await call('GET', '/api/v1/config');
    assert.equal(res.body.stages.length, 15);
    assert.equal(res.body.rules.length, 21);
    assert.ok(res.body.stages.every((s: any) => s.regulationRef));
  });

  /* ---------------------------- подача заявки ---------------------------- */

  const application = () => ({
    facilityId,
    applicant: {
      company: 'ТОО «Спектр Телеком»',
      bin: '501400004114',
      contact: 'Оспанов Дархан Маратович',
      email: 'info@spektr.kz',
      phone: '+7 701 000-11-22',
    },
    services: [
      {
        service: 'ТУ', placement: 'ams', tariffId: tariffTu, tariffQuantity: 1,
        params: {
          scope: 'Размещение трёх антенных модулей на существующих конструкциях',
          equipment: 'Антенна панельная и радиомодуль',
          quantity: 3, power: 2.4, weight: 48, windage: 1.2, height: 35,
        },
      },
      {
        service: 'ПСД', placement: 'ams', tariffId: tariffPsd, tariffQuantity: 1,
        params: {
          scope: 'Разработка рабочего проекта на размещение оборудования',
          equipment: 'Антенна панельная и радиомодуль',
          quantity: 3, power: 2.4, weight: 48, windage: 1.2, height: 35,
          designTask: 'Разработать РП по разделам РТ, АС и ЭС',
        },
      },
    ],
  });

  let requestId = '';
  let requestNumber = '';

  const todayIso = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  /** Переход по этапу с проверкой успеха. */
  async function go(id: string, to: string, as: string = users.orpsd, extra: Record<string, unknown> = {}) {
    const res = await call('POST', `/api/v1/requests/${id}/transition`, { as, body: { to, ...extra } });
    assert.equal(res.status, 200, `${to}: ${JSON.stringify(res.body)}`);
    return res.body.request;
  }

  /** Регистрация делопроизводством, оценка ТВ и переход к КП — только через API. */
  async function toOffer(id: string, incoming: string) {
    const reg = await call('POST', `/api/v1/requests/${id}/registration`,
      { as: users.records, body: { incomingNumber: incoming, incomingDate: todayIso() } });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    await go(id, 'tv_review', users.records);
    const tv = await call('POST', `/api/v1/requests/${id}/tv`, {
      as: users.orpsd,
      body: { status: 'confirmed', masterFileVersion: '2026-09-01', verificationCalc: 'not_required' },
    });
    assert.equal(tv.status, 200, JSON.stringify(tv.body));
    await go(id, 'offer');
  }

  /** Договор на услугу заявки (пп. 21, 32, 48). */
  async function signContract(id: string, service: string, number: string, as: string = users.orpsd) {
    const res = await call('POST', `/api/v1/requests/${id}/contracts`, {
      as, body: { service, number, amount: 100000, signedAt: daysAgo(3), invoiceAt: daysAgo(3) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.contract;
  }

  /** Поступление 100 % оплаты (п. 86) — фиксирует расчёты с контрагентами. */
  async function pay(contractId: string, paidAt: string = todayIso()) {
    const res = await call('POST', `/api/v1/contracts/${contractId}/payment`, { as: users.orpsd, body: { paidAt } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.request;
  }

  async function flags(id: string, body: Record<string, unknown>, as: string = users.orpsd) {
    const res = await call('POST', `/api/v1/requests/${id}/flags`, { as, body });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.request;
  }

  test('заявка с двумя услугами подаётся и получает номер сразу (п. 6, ТЗ №7)', async () => {
    const res = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    requestId = res.body.request.uuid;
    requestNumber = res.body.request.number;
    assert.match(requestNumber, /^ЗК-\d{4}-\d{4}$/);
    assert.deepEqual(res.body.request.services.sort(), ['ПСД', 'ТУ']);
    assert.equal(res.body.request.stageCode, 'registered');
    assert.equal(res.body.request.branchName, 'Карагандинский филиал', 'филиал определён по объекту');
  });

  test('стоимость сохранена суммой позиций (п. 21)', async () => {
    const res = await call('GET', `/api/v1/requests/${requestId}`, { as: users.orpsd });
    assert.equal(res.status, 200);
    assert.equal(Number(res.body.request.totalAmount), 420000 + 980000);
    assert.equal(res.body.services.length, 2);
  });

  test('номера заявок не повторяются', async () => {
    const second = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    assert.equal(second.status, 200);
    assert.notEqual(second.body.request.number, requestNumber);
  });

  test('неполная заявка отклоняется с указанием полей (ТЗ №4)', async () => {
    const broken = application();
    broken.applicant.bin = '111111111111';
    broken.services[0].params.weight = 'много' as never;
    const res = await call('POST', '/api/v1/requests', { as: users.customer, body: broken });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'validation_failed');
    assert.ok(res.body.fields.bin);
    assert.ok(res.body.fields['services.0.weight']);
  });

  test('Заказчик не видит чужие заявки', async () => {
    await db.query('UPDATE users SET counterparty_id = $1 WHERE email = $2',
      [otherCounterpartyId, users.customer]);
    const res = await call('GET', `/api/v1/requests/${requestId}`, { as: users.customer });
    assert.equal(res.status, 403);
    await db.query('UPDATE users SET counterparty_id = $1 WHERE email = $2',
      [counterpartyId, users.customer]);
  });

  /* ------------------- заявка от имени Заказчика (п. 6) ------------------- */

  test('сотрудник вносит бумажную заявку: организация определяется по БИН (п. 6)', async () => {
    const paper = {
      facilityId,
      applicant: {
        company: 'ТОО «Бумажный Заявитель»',
        bin: '501400005251',                       // БИН уже есть в справочнике
        contact: 'Секретарь Общества',
        email: 'paper@demo.kz',
        phone: '+7 701 555-11-22',
      },
      services: [{
        service: 'ТУ', placement: 'ams',
        params: {
          scope: 'Размещение оборудования по заявке, поступившей на бумажном носителе',
          equipment: 'Антенна панельная и радиомодуль',
          quantity: 1, power: 1.2, weight: 20, windage: 0.6, height: 30,
        },
      }],
    };
    const res = await call('POST', '/api/v1/requests', { as: users.records, body: paper });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const linked = await db.one<{ bin: string }>(
      `SELECT cp.bin FROM requests r JOIN counterparties cp ON cp.id = r.counterparty_id
        WHERE r.id = $1`, [res.body.request.uuid]);
    assert.equal(linked!.bin, '501400005251', 'заявка привязана к существующей организации');
  });

  test('неизвестный БИН заводит карточку со статусом «на проверке»', async () => {
    const newBin = '501400009600';
    await db.query('DELETE FROM counterparties WHERE bin = $1', [newBin]);

    const res = await call('POST', '/api/v1/requests', {
      as: users.records,
      body: {
        facilityId,
        applicant: {
          company: 'ТОО «Новый Заявитель»', bin: newBin,
          contact: 'Представитель', email: 'new@demo.kz', phone: '+7 701 555-33-44',
        },
        services: [{
          service: 'ТУ', placement: 'ams',
          params: {
            scope: 'Размещение оборудования по вновь поступившей заявке',
            equipment: 'Антенна панельная', quantity: 1, power: 1, weight: 15, windage: 0.5, height: 25,
          },
        }],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const created = await db.one<{ status: string; name_full: string }>(
      'SELECT status, name_full FROM counterparties WHERE bin = $1', [newBin]);
    assert.equal(created!.status, 'pending', 'реквизиты подлежат проверке, прав это не даёт');
    assert.equal(created!.name_full, 'ТОО «Новый Заявитель»');

    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE entity = 'counterparty' AND action LIKE 'Заведена карточка%'`);
    assert.ok(Number(logged!.n) > 0, 'создание карточки записано в журнал');
  });

  test('Заказчик подаёт заявку только от своей организации', async () => {
    const res = await call('POST', '/api/v1/requests', {
      as: users.customer,
      body: {
        facilityId,
        // Чужой БИН в форме не должен переносить заявку на другую организацию.
        applicant: { ...application().applicant, bin: '501400005251' },
        services: application().services,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const linked = await db.one<{ id: string }>(
      'SELECT counterparty_id AS id FROM requests WHERE id = $1', [res.body.request.uuid]);
    assert.equal(linked!.id, counterpartyId, 'организация взята из учётной записи, а не из формы');
  });

  /* ------------------------- переходы по Регламенту ------------------------ */

  test('без входящего номера заявка не уходит на оценку ТВ (п. 6)', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.records, body: { to: 'tv_review' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.failures.some((f: any) => f.code === 'not_registered'));
  });

  test('регистрацию выполняет делопроизводство, а не ОР ПСД (п. 6)', async () => {
    const wrongRole = await call('POST', `/api/v1/requests/${requestId}/registration`,
      { as: users.orpsd, body: { incomingNumber: 'вх-1201', incomingDate: '2026-09-22' } });
    assert.equal(wrongRole.status, 403);

    const badDate = await call('POST', `/api/v1/requests/${requestId}/registration`,
      { as: users.records, body: { incomingNumber: 'вх-1201', incomingDate: '2099-01-01' } });
    assert.equal(badDate.status, 422);
    assert.ok(badDate.body.fields.incomingDate);

    const ok = await call('POST', `/api/v1/requests/${requestId}/registration`, {
      as: users.records,
      body: { incomingNumber: 'вх-1201', incomingDate: new Date().toISOString().slice(0, 10) },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.request.incomingNumber, 'вх-1201');
  });

  test('переход к КП без подтверждённой ТВ отклоняется (пп. 16.3, 16.5)', async () => {
    const moved = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.records, body: { to: 'tv_review' } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'offer' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'regulation_violation');
    const codes = res.body.failures.map((f: any) => f.code);
    assert.ok(codes.includes('tv_not_confirmed'));
    assert.ok(codes.includes('no_master_version'));
  });

  test('ТВ без версии мастер-файла не фиксируется (п. 16.5)', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/tv`,
      { as: users.orpsd, body: { status: 'confirmed', verificationCalc: 'not_required' } });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /16\.5/);
  });

  test('ТВ фиксируется с версией реестра и решением инженера (пп. 16.3–16.5)', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/tv`, {
      as: users.orpsd,
      body: { status: 'confirmed', masterFileVersion: '2026-09-01', verificationCalc: 'not_required' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.tvStatus, 'confirmed');
    assert.equal(res.body.request.masterFileVersion, '2026-09-01');
  });

  test('переход выполняет только уполномоченная роль', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.assets, body: { to: 'offer' } });
    assert.equal(res.status, 403);
  });

  test('после подтверждения ТВ переход к КП проходит', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'offer' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.stageCode, 'offer');
  });

  test('без договора счёт не выставить (пп. 21, 83)', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'awaiting_payment' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.failures.some((f: any) => f.code === 'no_contract'));
  });

  const contractIds: Record<string, string> = {};

  test('договор регистрируется через API на каждую услугу (пп. 21, 32, 83)', async () => {
    const byCustomer = await call('POST', `/api/v1/requests/${requestId}/contracts`,
      { as: users.customer, body: { service: 'ТУ', number: 'ДП-101/26' } });
    assert.equal(byCustomer.status, 403, 'договор регистрирует ОР ПСД или расчёты с контрагентами');

    const notOrdered = await call('POST', `/api/v1/requests/${requestId}/contracts`,
      { as: users.orpsd, body: { service: 'СМР', number: 'ДП-199/26' } });
    assert.equal(notOrdered.status, 422);
    assert.ok(notOrdered.body.fields.service);

    contractIds['ТУ'] = (await signContract(requestId, 'ТУ', 'ДП-101/26')).id;

    const onlyTu = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'awaiting_payment' } });
    assert.equal(onlyTu.status, 422, 'договора на ПСД ещё нет');
    assert.ok(onlyTu.body.failures.some((f: any) => f.code === 'no_contract' && f.message.includes('ПСД')));

    const duplicate = await call('POST', `/api/v1/requests/${requestId}/contracts`,
      { as: users.orpsd, body: { service: 'ТУ', number: 'ДП-102/26' } });
    assert.equal(duplicate.status, 409, 'один действующий договор на услугу');

    contractIds['ПСД'] = (await signContract(requestId, 'ПСД', 'ДП-103/26')).id;
    const card = await call('GET', `/api/v1/requests/${requestId}`, { as: users.orpsd });
    assert.equal(card.body.contracts.length, 2);
    assert.deepEqual(card.body.request.contracts.map((c: any) => c.service).sort(), ['ПСД', 'ТУ']);
  });

  test('услуги не начинаются без 100 % предоплаты (пп. 86, 89)', async () => {
    await go(requestId, 'awaiting_payment');
    const early = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'tu' } });
    assert.equal(early.status, 422);
    assert.ok(early.body.failures.some((f: any) => f.code === 'not_paid'));
  });

  test('дата оплаты фиксируется фактическая: не в будущем и не раньше договора (п. 88)', async () => {
    const future = await call('POST', `/api/v1/contracts/${contractIds['ТУ']}/payment`,
      { as: users.orpsd, body: { paidAt: '2099-01-01' } });
    assert.equal(future.status, 422);
    const beforeSigning = await call('POST', `/api/v1/contracts/${contractIds['ТУ']}/payment`,
      { as: users.orpsd, body: { paidAt: daysAgo(30) } });
    assert.equal(beforeSigning.status, 422);
  });

  test('после оплаты услуга стартует, срок считается в рабочих днях (п. 24)', async () => {
    await pay(contractIds['ТУ']);
    const again = await call('POST', `/api/v1/contracts/${contractIds['ТУ']}/payment`,
      { as: users.orpsd, body: { paidAt: todayIso() } });
    assert.equal(again.status, 409, 'дата оплаты не перезаписывается');

    await go(requestId, 'tu');
    const card = await call('GET', `/api/v1/requests/${requestId}`, { as: users.orpsd });
    assert.equal(card.body.currentStage.stageCode, 'tu');
    assert.equal(card.body.currentStage.slaValue, 5);
    assert.ok(card.body.currentStage.dueAt, 'контрольная дата рассчитана');
  });

  test('история этапов пишется и закрывается — основа показателей', async () => {
    const res = await call('GET', `/api/v1/requests/${requestId}`, { as: users.orpsd });
    const history = res.body.history;
    assert.ok(history.length >= 5, 'все пройденные этапы записаны');
    const closed = history.filter((h: any) => h.left_at);
    assert.ok(closed.length >= 4, 'пройденные этапы имеют дату выхода');
    assert.equal(history.at(-1).stage_code, 'tu');
    assert.equal(history.at(-1).left_at, null);
  });

  test('непредусмотренный переход отклоняется', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'closed_done' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.failures[0].code, 'no_transition');
  });

  test('ПСД не начинается, пока не оплачен договор на ПСД (пп. 32, 86)', async () => {
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'psd' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.failures.some((f: any) => f.code === 'not_paid'));
  });

  test('устаревшая версия карточки приводит к конфликту', async () => {
    await pay(contractIds['ПСД']);
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'psd', version: 1 } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'conflict');
  });

  /* ------------------------ замечания и возврат -------------------------- */

  test('возврат на доработку требует хотя бы одного замечания (ТЗ №11)', async () => {
    const empty = await call('POST', `/api/v1/requests/${requestId}/remarks`,
      { as: users.orpsd, body: { remarks: [] } });
    assert.equal(empty.status, 422);

    const ok = await call('POST', `/api/v1/requests/${requestId}/remarks`, {
      as: users.orpsd,
      body: { remarks: [{ field: 'Масса оборудования', text: 'Приложите паспорт оборудования' }] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.remarks.length, 1);
    assert.equal(ok.body.request.openRemarks, 1);
  });

  test('открытые замечания переводят заявку в «Требуются уточнения» (ТЗ №10)', async () => {
    const res = await call('GET', `/api/v1/requests/${requestId}`, { as: users.customer });
    assert.equal(res.body.request.customerStatus, 'clarification');
  });

  /* --------------------------- доска и показатели ------------------------- */

  test('доска отдаёт колонки-этапы и карточки', async () => {
    const res = await call('GET', '/api/v1/board', { as: users.orpsd });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.columns.length, 11);
    assert.ok(res.body.columns.every((c: any) => c.regulationRef));
    assert.ok(res.body.cards.length >= 2);
  });

  test('показатели считаются по истории этапов', async () => {
    const res = await call('GET', '/api/v1/metrics', { as: users.orpsd });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.stages.length > 0);
    assert.ok(Array.isArray(res.body.bottlenecks));
    assert.ok(res.body.byParty.every((p: any) => p.ownerName));
  });

  test('показатели закрыты для роли без права', async () => {
    const res = await call('GET', '/api/v1/metrics', { as: users.customer });
    assert.equal(res.status, 403);
  });

  /* ------------------------------ архив актов ----------------------------- */

  let actId = '';

  test('филиал загружает акт приёма-передачи с реквизитами (п. 58)', async () => {
    const branchUser = await db.one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [users.branchUser]);
    const branch = await db.one<{ branch_id: string }>(`SELECT branch_id FROM facilities WHERE id = $1`, [facilityId]);
    await db.query('UPDATE users SET branch_id = $1 WHERE id = $2', [branch!.branch_id, branchUser!.id]);

    const res = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи',
      number: 'АПП-026',
      facilityId,
      ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»',
      docDate: new Date().toISOString().slice(0, 10),
    }, { name: 'akt.pdf', data: pdf('акт приёма-передачи') });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    actId = res.body.document.id;
    assert.equal(res.body.document.kind, 'Акт приема-передачи');
    assert.equal(res.body.document.file_name, 'akt.pdf');
    assert.equal(res.body.document.approved, false);
  });

  test('повторная загрузка акта с теми же реквизитами блокируется (архив №11)', async () => {
    const res = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи',
      number: 'АПП-026',
      facilityId,
      ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»',
      docDate: new Date().toISOString().slice(0, 10),
    }, { name: 'akt-copy.pdf', data: pdf('копия') });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /уже зарегистрирован/);
  });

  test('исполняемый файл и подделка расширения отклоняются', async () => {
    const exe = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-027', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: new Date().toISOString().slice(0, 10),
    }, { name: 'virus.exe', data: Buffer.from([0x4d, 0x5a, 0x90, 0x00]) });
    assert.equal(exe.status, 400);

    const fake = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-028', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: new Date().toISOString().slice(0, 10),
    }, { name: 'akt.pdf', data: Buffer.from('это не PDF', 'utf8') });
    assert.equal(fake.status, 400);
    assert.match(fake.body.error, /не соответствует расширению/);
  });

  test('дата акта в будущем не принимается', async () => {
    const res = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-029', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: '2099-01-01',
    }, { name: 'akt.pdf', data: pdf('будущее') });
    assert.equal(res.status, 422);
    assert.ok(res.body.fields.docDate);
  });

  test('поиск по архиву комбинирует критерии (архив №4)', async () => {
    const byOwner = await call('GET',
      `/api/v1/documents?owner=${encodeURIComponent('Спектр')}&kind=${encodeURIComponent('Акт приема-передачи')}`,
      { as: users.orpsd });
    assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
    assert.ok(byOwner.body.documents.length >= 1);

    const byDate = await call('GET',
      `/api/v1/documents?dateFrom=2000-01-01&dateTo=${new Date().toISOString().slice(0, 10)}`,
      { as: users.orpsd });
    assert.ok(byDate.body.documents.length >= 1);

    const nothing = await call('GET', '/api/v1/documents?owner=несуществующаяорганизация', { as: users.orpsd });
    assert.equal(nothing.body.documents.length, 0);
  });

  test('СУА видит архив, ОКО — нет (ТЗ, раздел 4)', async () => {
    assert.equal((await call('GET', '/api/v1/documents', { as: users.assets })).status, 200);
    assert.equal((await call('GET', '/api/v1/documents', { as: users.oko })).status, 403);
  });

  test('скачивание файла фиксируется в журнале с именем файла', async () => {
    const res = await fetch(base + `/api/v1/documents/${actId}/file`, {
      headers: {
        'x-qtr-proxy-key': SECRET, 'x-qtr-user-id': 'subject-' + users.orpsd,
        'x-qtr-user-email': users.orpsd, 'x-qtr-user-name': users.orpsd,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition') ?? '', /akt\.pdf/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString(), '%PDF', 'файл отдан без искажения');

    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE entity = 'document' AND action = 'Скачивание файла' AND detail LIKE '%akt.pdf%'`);
    assert.ok(Number(logged!.n) > 0);
  });

  test('новая версия файла снимает визирование', async () => {
    const replaced = await upload(`/api/v1/documents/${actId}/versions`, users.branchUser, {},
      { name: 'akt-v2.pdf', data: pdf('исправленный акт') });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.equal(replaced.body.version, 2);
    assert.equal(replaced.body.document.approved, false);

    const card = await call('GET', `/api/v1/documents/${actId}`, { as: users.orpsd });
    assert.equal(card.body.versions.length, 2);
    assert.ok(card.body.versions[0].sha256);
  });

  test('визирование закрывает документ от удаления', async () => {
    const wrongRole = await call('POST', `/api/v1/documents/${actId}/approve`, { as: users.branchUser });
    assert.equal(wrongRole.status, 403, 'филиал не визирует');

    const ok = await call('POST', `/api/v1/documents/${actId}/approve`, { as: users.orpsd });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.document.approved, true);

    const twice = await call('POST', `/api/v1/documents/${actId}/approve`, { as: users.orpsd });
    assert.equal(twice.status, 409);

    const removal = await call('POST', `/api/v1/documents/${actId}/delete`, { as: users.branchUser });
    assert.equal(removal.status, 403);
    assert.match(removal.body.error, /удалить нельзя/);
  });

  test('невизированную карточку филиал удаляет вместе с файлом', async () => {
    const created = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-030', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: new Date().toISOString().slice(0, 10),
    }, { name: 'draft.pdf', data: pdf('черновик') });
    assert.equal(created.status, 200);

    const removed = await call('POST', `/api/v1/documents/${created.body.document.id}/delete`,
      { as: users.branchUser });
    assert.equal(removed.status, 200);

    const gone = await call('GET', `/api/v1/documents/${created.body.document.id}`, { as: users.orpsd });
    assert.equal(gone.status, 404);
  });

  let smrRequestId = '';

  test('завизированный акт приёма-передачи открывает переход к СМР (пп. 58, 60)', async () => {
    const withSmr = await call('POST', '/api/v1/requests', {
      as: users.customer,
      body: {
        facilityId,
        applicant: application().applicant,
        services: [{
          service: 'СМР', placement: 'ams', basisReference: 'ПСД-2026-11',
          params: {
            scope: 'Монтаж оборудования по утверждённой проектно-сметной документации',
            equipment: 'Антенна панельная и радиомодуль', quantity: 3, power: 2.4,
            weight: 48, windage: 1.2, height: 35,
          },
        }],
      },
    });
    assert.equal(withSmr.status, 200, JSON.stringify(withSmr.body));
    const id = withSmr.body.request.uuid;
    smrRequestId = id;
    await toOffer(id, 'вх-1300');

    const beforeEstimate = await call('POST', `/api/v1/requests/${id}/contracts`,
      { as: users.orpsd, body: { service: 'СМР', number: 'ДП-200/26' } });
    assert.equal(beforeEstimate.status, 422, 'договор на СМР — не ранее утверждения сметы (п. 53)');
    assert.equal(beforeEstimate.body.failures[0].code, 'estimate_not_approved');

    await flags(id, { estimateApproved: true });
    const smrContract = await signContract(id, 'СМР', 'ДП-200/26');
    await go(id, 'awaiting_payment');
    await pay(smrContract.id);
    await go(id, 'smr_prep');

    const withoutAct = await call('POST', `/api/v1/requests/${id}/transition`,
      { as: users.orpsd, body: { to: 'smr' } });
    assert.equal(withoutAct.status, 422);
    assert.ok(withoutAct.body.failures.some((f: any) => f.code === 'no_transfer_act'));
    assert.ok(withoutAct.body.failures.some((f: any) => f.code === 'no_order'));

    // Акт по этой заявке: загружает филиал, визирует ОР ПСД.
    const act = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-031', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(),
      requestId: id,
    }, { name: 'akt-smr.pdf', data: pdf('приём оборудования') });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    assert.equal(act.body.document.form_code, 'произвольная', 'акт приёма-передачи — в произвольной форме (п. 58)');
    await call('POST', `/api/v1/documents/${act.body.document.id}/approve`, { as: users.orpsd });

    const byBranch = await call('POST', `/api/v1/requests/${id}/flags`,
      { as: users.branchUser, body: { orderNumber: 'Р-77' } });
    assert.equal(byBranch.status, 403, 'распоряжение оформляет ОР ПСД (п. 60)');
    await flags(id, { orderNumber: 'Р-77' });

    const started = await go(id, 'smr');
    assert.equal(started.stageCode, 'smr');
  });

  test('СМР завершаются только по техническому АВР филиала (п. 66)', async () => {
    const res = await call('POST', `/api/v1/requests/${smrRequestId}/transition`,
      { as: users.branchUser, body: { to: 'avr' } });
    assert.equal(res.status, 422);
    assert.ok(res.body.failures.some((f: any) => f.code === 'no_technical_avr'));
  });

  /* ------------------ полный маршрут ТУ + ПСД + СМР через API ------------------ */

  test('заявка ТУ + ПСД + СМР проходит от подачи до закрытия без прямых записей в базу', async () => {
    const body = application();
    body.services.push({
      service: 'СМР', placement: 'ams',
      params: {
        scope: 'Монтаж оборудования по разработанному рабочему проекту',
        equipment: 'Антенна панельная и радиомодуль', quantity: 3, power: 2.4, weight: 48, windage: 1.2, height: 35,
      },
    } as never);
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.request.uuid;

    await toOffer(id, 'вх-1500');
    // Первый цикл: договоры на ТУ и ПСД; СМР — после утверждения сметы по ПСД (пп. 49, 53).
    const tu = await signContract(id, 'ТУ', 'ДП-501/26');
    const psd = await signContract(id, 'ПСД', 'ДП-502/26', users.orpsd);
    await go(id, 'awaiting_payment', users.accounting);
    await pay(tu.id);
    await pay(psd.id);
    await go(id, 'tu');
    await go(id, 'psd');

    // Продление ПСД — только с основанием и не более 15 рабочих дней (п. 33).
    const noReason = await call('POST', `/api/v1/requests/${id}/extension`, { as: users.orpsd, body: { days: 5 } });
    assert.equal(noReason.status, 422);
    const extended = await call('POST', `/api/v1/requests/${id}/extension`,
      { as: users.orpsd, body: { days: 10, reason: 'Письменное уведомление Заказчика исх. 145' } });
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.currentStage.extendedBy, 10);
    const tooLong = await call('POST', `/api/v1/requests/${id}/extension`,
      { as: users.orpsd, body: { days: 10, reason: 'Повторное продление' } });
    assert.equal(tooLong.status, 422);
    assert.match(tooLong.body.error, /15/);

    // Оплата ПСД не открывает СМР.
    await flags(id, { estimateApproved: true });
    const direct = await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'smr_prep' } });
    assert.equal(direct.status, 422);
    assert.ok(direct.body.failures.some((f: any) => f.code === 'no_contract'));

    // Второй цикл: КП и договор на СМР, своя оплата (пп. 48–54, 59).
    await go(id, 'offer');
    const smr = await signContract(id, 'СМР', 'ДП-503/26');
    await go(id, 'awaiting_payment');
    const psdAgain = await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'psd' } });
    assert.equal(psdAgain.status, 422, 'этап ПСД не повторяется');
    await pay(smr.id);
    await go(id, 'smr_prep');

    const act = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-501', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(), requestId: id,
    }, { name: 'app-501.pdf', data: pdf('приём оборудования') });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    await call('POST', `/api/v1/documents/${act.body.document.id}/approve`, { as: users.orpsd });
    await flags(id, { orderNumber: 'Р-501' });
    await go(id, 'smr', users.branchUser);

    const technical = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Технический АВР', number: 'ТАВР-501', facilityId, ownerId: counterpartyId,
      contractor: 'Карагандинский филиал', docDate: todayIso(), requestId: id,
    }, { name: 'tavr-501.pdf', data: pdf('технический АВР') });
    assert.equal(technical.status, 200, JSON.stringify(technical.body));
    assert.equal(technical.body.document.form_code, 'Прил. 6');
    await call('POST', `/api/v1/documents/${technical.body.document.id}/approve`, { as: users.orpsd });
    await go(id, 'avr', users.branchUser);

    // В заявке и услуги (Р-1), и СМР (№ 2В): форму акта указывают явно (п. 70).
    const ambiguous = await upload('/api/v1/documents', users.orpsd, {
      kind: 'АВР', number: 'АВР-501', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(), requestId: id,
    }, { name: 'avr-501.pdf', data: pdf('АВР') });
    assert.equal(ambiguous.status, 422);
    assert.ok(ambiguous.body.fields.formCode);
    const avr = await upload('/api/v1/documents', users.orpsd, {
      kind: 'АВР', number: 'АВР-501', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(), requestId: id, formCode: '2В',
    }, { name: 'avr-501.pdf', data: pdf('АВР') });
    assert.equal(avr.status, 200, JSON.stringify(avr.body));
    assert.equal(avr.body.document.form_code, '2В');

    const notSent = await call('POST', `/api/v1/requests/${id}/transition`, { as: users.accounting, body: { to: 'closing' } });
    assert.equal(notSent.status, 422);
    assert.ok(notSent.body.failures.some((f: any) => f.code === 'no_avr'));

    await call('POST', `/api/v1/documents/${avr.body.document.id}/approve`, { as: users.orpsd });
    // АВР направлен Заказчику 20 дней назад — 10 рабочих дней на замечания истекли (п. 94).
    await flags(id, { avrSentAt: daysAgo(20) }, users.accounting);
    await go(id, 'closing', users.accounting);

    const result = await runAvrSilence(db);
    assert.ok(result.affected >= 1);
    const closed = await call('GET', `/api/v1/requests/${id}`, { as: users.orpsd });
    assert.equal(closed.body.request.stageCode, 'closed_done');
    assert.equal(closed.body.request.customerStatus, 'done');
    assert.deepEqual(closed.body.contracts.map((c: any) => c.status).sort(), ['paid', 'paid', 'paid']);
  });

  test('АВР по услугам без СМР оформляется по форме Р-1 (п. 70, ТЗ)', async () => {
    const res = await upload('/api/v1/documents', users.orpsd, {
      kind: 'АВР', number: 'АВР-101', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(), requestId,
    }, { name: 'avr-101.pdf', data: pdf('АВР по ТУ и ПСД') });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.document.form_code, 'Р-1');
  });

  test('замечания Заказчика к АВР останавливают приёмку по молчанию (п. 94)', async () => {
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body: {
      ...application(), services: [application().services[0]],
    } });
    const id = created.body.request.uuid;
    await toOffer(id, 'вх-1600');
    const tu = await signContract(id, 'ТУ', 'ДП-601/26');
    await go(id, 'awaiting_payment');
    await pay(tu.id);
    await go(id, 'tu');
    await flags(id, { resultDelivered: true });
    await go(id, 'avr');
    const avr = await upload('/api/v1/documents', users.orpsd, {
      kind: 'АВР', number: 'АВР-601', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: todayIso(), requestId: id,
    }, { name: 'avr-601.pdf', data: pdf('АВР') });
    await call('POST', `/api/v1/documents/${avr.body.document.id}/approve`, { as: users.orpsd });
    await flags(id, { avrSentAt: daysAgo(20) });
    await go(id, 'closing');
    await flags(id, { avrObjection: 'Не выполнен пункт 3 технических условий: заземление не смонтировано' });

    await runAvrSilence(db);
    const still = await call('GET', `/api/v1/requests/${id}`, { as: users.orpsd });
    assert.equal(still.body.request.stageCode, 'closing', 'мотивированные замечания — приёмки по молчанию нет');

    await flags(id, { avrObjection: null, closingConfirmed: true });
    const done = await go(id, 'closed_done');
    assert.equal(done.stageCode, 'closed_done');
  });

  /* -------------------------------- журнал -------------------------------- */

  test('действия и отказы фиксируются в журнале с адресом и ссылкой на пункт', async () => {
    const res = await call('GET', `/api/v1/requests/${requestId}`, { as: users.orpsd });
    const events = res.body.events;
    assert.ok(events.length > 0);
    assert.ok(events.some((e: any) => e.result === 'denied'), 'отказ по правам записан');
    assert.ok(events.some((e: any) => e.regulation_ref), 'ссылка на пункт сохранена');

    const ip = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE ip_address IS NOT NULL`);
    assert.ok(Number(ip!.n) > 0, 'адрес источника пишется в журнал');
  });

  /* ------------------------ пользователи и журнал ------------------------- */

  test('роли назначает только ДИТ (п. 12, ТЗ раздел 4)', async () => {
    const byOrpsd = await call('POST', '/api/v1/users', {
      as: users.orpsd,
      body: { email: 'new@qtr.kz', fullName: 'Новый Сотрудник', roles: ['orpsd'] },
    });
    assert.equal(byOrpsd.status, 403);

    const created = await call('POST', '/api/v1/users', {
      as: users.admin,
      body: { email: 'New@QTR.kz', fullName: 'Новый Сотрудник', department: 'ОР ПСД', roles: ['orpsd'] },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.user.email, 'new@qtr.kz', 'адрес приводится к нижнему регистру');
  });

  test('новый сотрудник сразу получает назначенные права', async () => {
    const me = await call('GET', '/api/v1/me', { as: 'new@qtr.kz' });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.roles, ['orpsd']);
    assert.ok(me.body.permissions.includes('request.transition'));
  });

  test('роль «Филиал» без филиала и «Заказчик» без организации не назначаются', async () => {
    const noBranch = await call('POST', '/api/v1/users', {
      as: users.admin,
      body: { email: 'b2@qtr.kz', fullName: 'Сотрудник Филиала', roles: ['branch'] },
    });
    assert.equal(noBranch.status, 422);
    assert.ok(noBranch.body.fields.branchId);

    const noCounterparty = await call('POST', '/api/v1/users', {
      as: users.admin,
      body: { email: 'c2@spektr.kz', fullName: 'Представитель Заказчика', roles: ['customer'] },
    });
    assert.equal(noCounterparty.status, 422);
    assert.ok(noCounterparty.body.fields.counterpartyId);
  });

  test('администратор не может снять с себя права или отключить себя', async () => {
    const strip = await call('POST', '/api/v1/users', {
      as: users.admin,
      body: { email: users.admin, fullName: 'Администратор ДИТ', roles: ['orpsd'] },
    });
    assert.equal(strip.status, 422);
    assert.ok(strip.body.fields.roles);

    const me = await call('GET', '/api/v1/me', { as: users.admin });
    const self = await call('POST', `/api/v1/users/${me.body.id}/disable`, { as: users.admin });
    assert.equal(self.status, 422);
  });

  test('отключённая учётная запись теряет доступ', async () => {
    const list = await call('GET', '/api/v1/users?q=new@qtr.kz', { as: users.admin });
    const target = list.body.users.find((u: any) => u.email === 'new@qtr.kz');
    assert.ok(target);

    const off = await call('POST', `/api/v1/users/${target.id}/disable`, { as: users.admin });
    assert.equal(off.status, 200);

    const denied = await call('GET', '/api/v1/me', { as: 'new@qtr.kz' });
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /отключена/);
  });

  test('журнал действий доступен ДИТ и ОКО, остальным закрыт (ТЗ №12)', async () => {
    const asAdmin = await call('GET', '/api/v1/audit?limit=20', { as: users.admin });
    assert.equal(asAdmin.status, 200);
    assert.ok(asAdmin.body.events.length > 0);
    assert.ok(asAdmin.body.events[0].occurred_at);

    assert.equal((await call('GET', '/api/v1/audit', { as: users.oko })).status, 200);
    assert.equal((await call('GET', '/api/v1/audit', { as: users.customer })).status, 403);
    assert.equal((await call('GET', '/api/v1/audit', { as: users.branchUser })).status, 403);
  });

  test('журнал фильтруется по отказам — видно попытки недоступных действий', async () => {
    const denied = await call('GET', '/api/v1/audit?result=denied&limit=50', { as: users.admin });
    assert.equal(denied.status, 200);
    assert.ok(denied.body.events.length > 0);
    assert.ok(denied.body.events.every((e: any) => e.result === 'denied'));
  });

  /* --------------------------- фоновые задания ---------------------------- */

  /** Справочник филиала: куратор, директор, курирующий член Правления (Приложение 7, п. 100). */
  async function branchContacts() {
    const ids: Record<string, string> = {};
    for (const who of ['curator', 'director', 'board']) {
      const row = await db.one<{ id: string }>(
        `INSERT INTO users (email, full_name) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET full_name = excluded.full_name RETURNING id`,
        [`${who}@qtr.kz`, who]);
      ids[who] = row!.id;
    }
    await db.query(
      `UPDATE branches SET curator_id = $1, director_id = $2, board_curator_id = $3
        WHERE id = (SELECT branch_id FROM facilities WHERE id = $4)`,
      [ids.curator, ids.director, ids.board, facilityId]);
  }

  test('эскалация по п. 100: филиалу — куратору с копией директору, затем члену Правления', async () => {
    await branchContacts();
    const cal = { holidays: [], workingDays: [] };

    // Срок СМР (филиал) нарушен вчера. Время сдвигается в базе: так имитируется течение дней.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 1, escalation_level = 0
        WHERE request_id = $1 AND left_at IS NULL`, [smrRequestId]);
    // Срок этапа ОР ПСД тоже нарушен — но это не нарушение филиала.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 10 WHERE request_id = $1 AND left_at IS NULL`, [requestId]);

    await runEscalations(db, cal);
    const lvl1 = await db.query<{ level: number; notified: string; copy: string }>(
      `SELECT e.level, n.email AS notified, c.email AS copy
         FROM escalations e LEFT JOIN users n ON n.id = e.notified_user_id LEFT JOIN users c ON c.id = e.copy_user_id
        WHERE e.request_id = $1`, [smrRequestId]);
    assert.equal(lvl1.length, 1);
    assert.deepEqual(lvl1[0], { level: 1, notified: 'curator@qtr.kz', copy: 'director@qtr.kz' });
    const mail = await db.query<{ recipient: string }>(
      `SELECT recipient FROM notifications WHERE event_key LIKE 'escalation_level_1%' AND payload->>'requestId' = $1`,
      [smrRequestId]);
    assert.deepEqual(mail.map((m) => m.recipient).sort(), ['curator@qtr.kz', 'director@qtr.kz']);

    const orpsdStage = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM escalations WHERE request_id = $1`, [requestId]);
    assert.equal(Number(orpsdStage!.n), 0, 'просрочка ОР ПСД не эскалируется по п. 100');

    // Повторный проход в тот же день не создаёт дубликат и не поднимает уровень.
    await runEscalations(db, cal);
    const repeated = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM escalations WHERE request_id = $1`, [smrRequestId]);
    assert.equal(Number(repeated!.n), 1);

    // Уведомление первого уровня направлено неделю назад — нарушение не устранено.
    await db.query(
      `UPDATE escalations SET created_at = now() - interval '7 days' WHERE request_id = $1`, [smrRequestId]);
    await runEscalations(db, cal);
    const lvl2 = await db.one<{ level: number; notified: string }>(
      `SELECT e.level, n.email AS notified FROM escalations e JOIN users n ON n.id = e.notified_user_id
        WHERE e.request_id = $1 AND e.level = 2`, [smrRequestId]);
    assert.equal(lvl2!.notified, 'board@qtr.kz', 'второй уровень — курирующему члену Правления');

    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE entity = 'request' AND entity_id = $1 AND regulation_ref = 'п. 100'`, [smrRequestId]);
    assert.ok(Number(logged!.n) >= 2, 'эскалации записаны в журнал со ссылкой на пункт');
  });

  test('неоплата Заказчиком не эскалируется, а закрывается по оферте (табл. 1)', async () => {
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    const id = created.body.request.uuid;
    await toOffer(id, 'вх-1400');
    await signContract(id, 'ТУ', 'ДП-300/26');
    await signContract(id, 'ПСД', 'ДП-301/26');
    await go(id, 'awaiting_payment');

    // Срок оферты истёк.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 3 WHERE request_id = $1 AND left_at IS NULL`, [id]);

    await runEscalations(db, { holidays: [], workingDays: [] });
    const escalated = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM escalations WHERE request_id = $1`, [id]);
    assert.equal(Number(escalated!.n), 0, 'просрочка оплаты — сторона Заказчика');

    const result = await runOfferExpiry(db, { holidays: [], workingDays: [] });
    assert.ok(result.affected >= 1);

    const after = await call('GET', `/api/v1/requests/${id}`, { as: users.orpsd });
    assert.equal(after.body.request.stageCode, 'closed_expired');
    assert.equal(after.body.request.customerStatus, 'rejected');

    const notice = await db.one<{ subject: string }>(
      `SELECT subject FROM notifications WHERE event_key = 'offer_expired' ORDER BY created_at DESC LIMIT 1`);
    assert.match(notice!.subject, /истёк срок оферты/);
  });

  test('оплаченная заявка по оферте не закрывается', async () => {
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    const id = created.body.request.uuid;
    await toOffer(id, 'вх-1401');
    const tu = await signContract(id, 'ТУ', 'ДП-310/26');
    await signContract(id, 'ПСД', 'ДП-311/26');
    await go(id, 'awaiting_payment');
    await pay(tu.id);
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 3 WHERE request_id = $1 AND left_at IS NULL`, [id]);

    await runOfferExpiry(db, { holidays: [], workingDays: [] });
    const row = await call('GET', `/api/v1/requests/${id}`, { as: users.orpsd });
    assert.equal(row.body.request.stageCode, 'awaiting_payment', 'оплата поступила — закрывать нельзя');
  });

  /* ---------------------- поручения ОКО (ТЗ №7, №8) ---------------------- */

  test('при подаче заявки создаётся поручение со всеми сведениями заявки', async () => {
    const res = await call('GET', '/api/v1/assignments?status=all', { as: users.oko });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const found = res.body.assignments.find((a: any) => a.request_number === requestNumber);
    assert.ok(found, 'поручение по основной заявке есть в очереди ОКО');
    assert.equal(found.department, 'ОР ПСД');
    assert.ok(found.due_at, 'срок ответа по п. 9');
    assert.equal(found.payload.customer.bin, '501400004114');
    assert.equal(found.payload.services.length, 2);
    assert.equal(Number(found.payload.estimate), 420000 + 980000);

    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE entity_id = $1 AND action = 'Создано поручение ОР ПСД'`, [requestId]);
    assert.equal(Number(logged!.n), 1);

    assert.equal((await call('GET', '/api/v1/assignments', { as: users.customer })).status, 403);
  });

  test('ОР ПСД принимает поручение в работу, ОКО закрывает с отметкой в журнале', async () => {
    const list = await call('GET', '/api/v1/assignments', { as: users.orpsd });
    const target = list.body.assignments.find((a: any) => a.request_number === requestNumber);

    assert.equal((await call('POST', `/api/v1/assignments/${target.id}/accept`, { as: users.oko })).status, 403);
    const accepted = await call('POST', `/api/v1/assignments/${target.id}/accept`, { as: users.orpsd });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.assignment.status, 'in_progress');

    const noNote = await call('POST', `/api/v1/assignments/${target.id}/close`, { as: users.oko, body: {} });
    assert.equal(noNote.status, 422);
    const closed = await call('POST', `/api/v1/assignments/${target.id}/close`,
      { as: users.oko, body: { note: 'Ответ о ТВ направлен, договоры заключены' } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.assignment.status, 'done');
  });

  test('выгрузка поручений для ОКО — CSV (ТЗ, раздел 5)', async () => {
    const res = await fetch(base + '/api/v1/assignments/export', {
      headers: {
        'x-qtr-proxy-key': SECRET, 'x-qtr-user-id': 'subject-' + users.oko,
        'x-qtr-user-email': users.oko, 'x-qtr-user-name': users.oko,
      },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    const text = await res.text();
    assert.ok(text.includes(requestNumber));
    assert.ok(text.includes('Номер заявки'));
  });

  /* ------------------- служебные записки в филиал (п. 10) ------------------- */

  test('ОР ПСД направляет служебную записку в филиал, филиал отвечает', async () => {
    const short = await call('POST', `/api/v1/requests/${requestId}/memos`,
      { as: users.orpsd, body: { subject: 'Запрос', body: 'Мало' } });
    assert.equal(short.status, 422);

    const created = await call('POST', `/api/v1/requests/${requestId}/memos`, {
      as: users.orpsd,
      body: { subject: 'Загрузка яруса 35 м', body: 'Подтвердите фактическую загрузку яруса 35 м и свободную мощность ввода' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const memo = created.body.memo;
    assert.ok(memo.due_at > todayIso(), 'срок ответа — 3 рабочих дня');
    assert.equal(memo.addressee_name, 'curator');

    const queue = await call('GET', '/api/v1/memos?open=1', { as: users.branchUser });
    assert.ok(queue.body.memos.some((m: any) => m.id === memo.id), 'записка в очереди филиала');

    assert.equal((await call('POST', `/api/v1/memos/${memo.id}/answer`,
      { as: users.orpsd, body: { answer: 'Ответ от имени ОР ПСД' } })).status, 403);
    const answered = await call('POST', `/api/v1/memos/${memo.id}/answer`,
      { as: users.branchUser, body: { answer: 'Ярус 35 м загружен на 60 %, свободная мощность 4 кВт' } });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.ok(answered.body.memo.answered_at);
  });

  test('просроченная служебная записка эскалируется и учитывается в показателе', async () => {
    const created = await call('POST', `/api/v1/requests/${requestId}/memos`, {
      as: users.orpsd,
      body: { subject: 'Паспорт АМС', body: 'Направьте актуальный паспорт АМС с допустимой нагрузкой по ярусам' },
    });
    const memoId = created.body.memo.id;
    await db.query(`UPDATE memos SET due_at = current_date - 1 WHERE id = $1`, [memoId]);

    await runEscalations(db, { holidays: [], workingDays: [] });
    const esc = await db.one<{ level: number }>(`SELECT level FROM escalations WHERE memo_id = $1`, [memoId]);
    assert.equal(esc!.level, 1);

    const stats = await call('GET', '/api/v1/memos/stats', { as: users.orpsd });
    assert.equal(stats.status, 200);
    assert.equal(stats.body.stats.answered, 1);
    assert.equal(stats.body.stats.onTime, 1);
    assert.ok(stats.body.stats.overdueOpen >= 1);
    const metrics = await call('GET', '/api/v1/metrics', { as: users.orpsd });
    assert.ok(metrics.body.memos, 'показатель п. 10 — на дашборде');
  });

  /* -------------- исправление заявки по замечаниям (ТЗ №11) -------------- */

  test('Заказчик исправляет заявку по замечаниям и отправляет повторно с тем же номером', async () => {
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    const id = created.body.request.uuid;
    const number = created.body.request.number;
    const reg = await call('POST', `/api/v1/requests/${id}/registration`,
      { as: users.records, body: { incomingNumber: 'вх-1700', incomingDate: todayIso() } });
    assert.equal(reg.status, 200);
    await go(id, 'tv_review', users.records);
    await call('POST', `/api/v1/requests/${id}/tv`, {
      as: users.orpsd, body: { status: 'confirmed', masterFileVersion: '2026-09-01', verificationCalc: 'not_required' },
    });

    const noRemarks = await call('PATCH', `/api/v1/requests/${id}`, { as: users.customer, body: application() });
    assert.equal(noRemarks.status, 409, 'без замечаний поданная заявка не правится');

    // Услуги хранятся упорядоченными по виду: services.0 — ПСД, services.1 — ТУ.
    const returned = await call('POST', `/api/v1/requests/${id}/remarks`, {
      as: users.orpsd,
      body: { remarks: [
        { field: 'services.0.weight', text: 'Масса не совпадает с паспортом оборудования' },
        { field: 'Общее', text: 'Приложите паспорт оборудования' },
      ] },
    });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));

    const blocked = await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'offer' } });
    assert.equal(blocked.status, 422);
    assert.ok(blocked.body.failures.some((f: any) => f.code === 'open_remarks'), 'переход не снимает замечания');

    const same = await call('PATCH', `/api/v1/requests/${id}`, { as: users.customer, body: application() });
    assert.equal(same.status, 422, 'изменений нет');

    const fixedBody = application();
    const psdItem = fixedBody.services.find((s) => s.service === 'ПСД')!;
    psdItem.params.weight = 52;
    const invalid = application();
    invalid.services[0].params.weight = 'много' as never;
    assert.equal((await call('PATCH', `/api/v1/requests/${id}`, { as: users.customer, body: invalid })).status, 422,
      'исправленная заявка проверяется так же, как при подаче');

    const fixed = await call('PATCH', `/api/v1/requests/${id}`, { as: users.customer, body: fixedBody });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.request.number, number, 'номер сохраняется');
    const open = fixed.body.remarks.filter((r: any) => !r.resolved_at);
    assert.deepEqual(open.map((r: any) => r.field_key), ['Общее'], 'снято только замечание к исправленному полю');
    assert.equal(fixed.body.request.tvStatus, 'pending', 'исходные данные изменились — оценка ТВ повторяется');

    const early = await call('POST', `/api/v1/requests/${id}/resubmit`, { as: users.customer });
    assert.equal(early.status, 422);
    assert.ok(early.body.fields['Общее']);

    const general = open[0];
    assert.equal((await call('POST', `/api/v1/requests/${id}/remarks/${general.id}/resolve`,
      { as: users.customer, body: {} })).status, 403);
    const resolved = await call('POST', `/api/v1/requests/${id}/remarks/${general.id}/resolve`,
      { as: users.orpsd, body: { note: 'Паспорт приложен к письму' } });
    assert.equal(resolved.status, 200);

    const resubmitted = await call('POST', `/api/v1/requests/${id}/resubmit`, { as: users.customer });
    assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
    assert.equal(resubmitted.body.request.customerStatus, 'review');

    const history = await call('GET', `/api/v1/requests/${id}`, { as: users.orpsd });
    assert.ok(history.body.events.some((ev: any) => ev.action === 'Заявка исправлена по замечаниям'));
    assert.ok(history.body.events.some((ev: any) => ev.action === 'Исправленная заявка отправлена повторно'));
  });

  test('черновик подаётся только после полной проверки формы (ТЗ №4)', async () => {
    const draft = await call('POST', '/api/v1/requests', {
      as: users.customer,
      body: { ...application(), draft: true, services: [{ ...application().services[0], params: { scope: 'Кратко' } }] },
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const id = draft.body.request.uuid;
    const submit = await call('POST', `/api/v1/requests/${id}/transition`, { as: users.customer, body: { to: 'registered' } });
    assert.equal(submit.status, 422);
    assert.ok(submit.body.fields['services.0.scope']);

    const completed = await call('PATCH', `/api/v1/requests/${id}`,
      { as: users.customer, body: { facilityId, services: [application().services[0]] } });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    await go(id, 'registered', users.customer);
    const assignment = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM assignments WHERE request_id = $1`, [id]);
    assert.equal(Number(assignment!.n), 1, 'поручение создаётся при подаче черновика');
  });

  test('уведомление Заказчику о принятии заявки ставится в очередь (ТЗ №9)', async () => {
    const notice = await db.one<{ subject: string; payload: any; recipient: string }>(
      `SELECT subject, payload, recipient FROM notifications
        WHERE event_key = 'request_submitted' ORDER BY created_at DESC LIMIT 1`);
    assert.ok(notice, 'уведомление создано при подаче заявки');
    assert.match(notice!.subject, /^Заявка ЗК-\d{4}-\d{4} принята$/);
    assert.match(String(notice!.payload.body), /5 рабочих дней/);
    assert.equal(notice!.recipient, 'info@spektr.kz');
  });

  test('очередь уведомлений отправляется и помечается', async () => {
    const outbox: { to: string; subject: string }[] = [];
    const mailer = {
      async send(to: string, subject: string) { outbox.push({ to, subject }); },
    };
    const before = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE status = 'queued' AND channel = 'email'`);
    assert.ok(Number(before!.n) > 0);

    const result = await processQueue(db, mailer, 100);
    assert.ok(result.sent > 0);
    assert.equal(outbox.length, result.sent);

    const left = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE status = 'queued' AND channel = 'email'`);
    assert.equal(Number(left!.n), 0, 'очередь разобрана');
  });

  test('сбой отправки не теряет сообщение, а повторяется', async () => {
    await db.query(
      `INSERT INTO notifications (event_key, channel, recipient, subject, payload)
       VALUES ('test_retry', 'email', 'fail@qtr.kz', 'Проверка повтора', '{"body":"тело"}'::jsonb)`);
    const failing = { async send() { throw new Error('SMTP недоступен'); } };

    await processQueue(db, failing, 10);
    const row = await db.one<{ status: string; attempts: number; error: string }>(
      `SELECT status, attempts, error FROM notifications WHERE event_key = 'test_retry'`);
    assert.equal(row!.status, 'queued', 'сообщение остаётся в очереди');
    assert.equal(row!.attempts, 1);
    assert.match(row!.error, /SMTP недоступен/);

    for (let i = 0; i < 5; i++) await processQueue(db, failing, 10);
    const exhausted = await db.one<{ status: string }>(
      `SELECT status FROM notifications WHERE event_key = 'test_retry'`);
    assert.equal(exhausted!.status, 'failed', 'после исчерпания попыток помечается сбойным');
  });

  test('без настроенной почты сообщения остаются в очереди', async () => {
    await db.query(
      `INSERT INTO notifications (event_key, channel, recipient, subject, payload)
       VALUES ('test_no_mailer', 'email', 'a@qtr.kz', 'Без почты', '{"body":"тело"}'::jsonb)`);
    const result = await processQueue(db, null, 10);
    assert.equal(result.sent, 0);
    assert.ok(result.skipped > 0);
    const row = await db.one<{ status: string }>(
      `SELECT status FROM notifications WHERE event_key = 'test_no_mailer'`);
    assert.equal(row!.status, 'queued');
  });

  test('полный проход заданий выполняется без ошибок', async () => {
    const results = await runAllJobs(db);
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.regulationRef));
  });

  /* ------------------------ ограничения схемы ---------------------------- */

  test('схема не даёт подтвердить ТВ без версии мастер-файла (п. 16.5)', async () => {
    await assert.rejects(
      () => db.query(
        `UPDATE requests SET tv_status = 'confirmed', master_file_version = NULL WHERE id = $1`,
        [requestId]),
      /chk_tv_master_version/,
      'ограничение базы страхует правило Регламента даже при обходе приложения');
  });

  test('схема не даёт продлить срок без основания (пп. 33, 45)', async () => {
    await assert.rejects(
      () => db.query(
        `UPDATE request_stages SET extended_by = 5, extension_reason = NULL
          WHERE request_id = $1 AND left_at IS NULL`, [requestId]),
      /chk_extension_reason/);
  });

  test('повторный номер заявки невозможен', async () => {
    await assert.rejects(
      () => db.query(
        `INSERT INTO requests (number, counterparty_id, facility_id, branch_id, created_by, stage_code)
         SELECT number, counterparty_id, facility_id, branch_id, created_by, stage_code
           FROM requests WHERE id = $1`, [requestId]),
      /requests_number_key/);
  });
});
