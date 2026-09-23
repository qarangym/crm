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
    // он снёс бы справочники филиалов и объектов.
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

  test('услуги не начинаются без 100 % предоплаты (пп. 86, 89)', async () => {
    await db.query(
      `INSERT INTO contracts (number, request_id, counterparty_id, status)
       VALUES ('ДП-101/26', $1, $2, 'signed')`, [requestId, counterpartyId]);
    const toPayment = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'awaiting_payment' } });
    assert.equal(toPayment.status, 200, JSON.stringify(toPayment.body));

    const early = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'tu' } });
    assert.equal(early.status, 422);
    assert.ok(early.body.failures.some((f: any) => f.code === 'not_paid'));
  });

  test('после оплаты услуга стартует, срок считается в рабочих днях (п. 24)', async () => {
    await db.query(`UPDATE contracts SET paid_at = current_date WHERE request_id = $1`, [requestId]);
    const res = await call('POST', `/api/v1/requests/${requestId}/transition`,
      { as: users.orpsd, body: { to: 'tu' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));

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

  test('устаревшая версия карточки приводит к конфликту', async () => {
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

    await call('POST', `/api/v1/requests/${id}/registration`, {
      as: users.records,
      body: { incomingNumber: 'вх-1300', incomingDate: new Date().toISOString().slice(0, 10) },
    });
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.records, body: { to: 'tv_review' } });
    await call('POST', `/api/v1/requests/${id}/tv`, {
      as: users.orpsd,
      body: { status: 'confirmed', masterFileVersion: '2026-09-01', verificationCalc: 'not_required' },
    });
    await db.query(
      `INSERT INTO contracts (number, request_id, counterparty_id, status, paid_at)
       VALUES ('ДП-200/26', $1, $2, 'paid', current_date)`, [id, counterpartyId]);
    await db.query('UPDATE requests SET estimate_approved = true WHERE id = $1', [id]);
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'offer' } });
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'awaiting_payment' } });
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'smr_prep' } });

    const withoutAct = await call('POST', `/api/v1/requests/${id}/transition`,
      { as: users.orpsd, body: { to: 'smr' } });
    assert.equal(withoutAct.status, 422);
    assert.ok(withoutAct.body.failures.some((f: any) => f.code === 'no_transfer_act'));

    // Акт по этой заявке: загружает филиал, визирует ОР ПСД.
    const act = await upload('/api/v1/documents', users.branchUser, {
      kind: 'Акт приема-передачи', number: 'АПП-031', facilityId, ownerId: counterpartyId,
      contractor: 'АО «Казтелерадио»', docDate: new Date().toISOString().slice(0, 10),
      requestId: id,
    }, { name: 'akt-smr.pdf', data: pdf('приём оборудования') });
    assert.equal(act.status, 200, JSON.stringify(act.body));
    await call('POST', `/api/v1/documents/${act.body.document.id}/approve`, { as: users.orpsd });
    await db.query(`UPDATE requests SET order_number = 'Р-77' WHERE id = $1`, [id]);

    const withAct = await call('POST', `/api/v1/requests/${id}/transition`,
      { as: users.orpsd, body: { to: 'smr' } });
    assert.equal(withAct.status, 200, JSON.stringify(withAct.body));
    assert.equal(withAct.body.request.stageCode, 'smr');
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

  test('эскалация 1-го и 2-го уровня формируется автоматически (п. 100)', async () => {
    const cal = { holidays: [], workingDays: [] };
    const target = await db.one<{ id: string; number: string }>(
      `SELECT id, number FROM requests WHERE stage_code NOT LIKE 'closed%' ORDER BY created_at LIMIT 1`);
    assert.ok(target);

    // Срок нарушен один рабочий день назад.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 1, escalation_level = 0
        WHERE request_id = $1 AND left_at IS NULL`, [target!.id]);

    const first = await runEscalations(db, cal);
    assert.ok(first.affected >= 1, 'первый уровень сработал');
    const lvl1 = await db.one<{ level: number }>(
      `SELECT level FROM escalations WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`, [target!.id]);
    assert.equal(lvl1!.level, 1);

    // Повторный проход не создаёт дубликат.
    const again = await runEscalations(db, cal);
    const repeated = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM escalations WHERE request_id = $1 AND level = 1`, [target!.id]);
    assert.equal(Number(repeated!.n), 1, 'эскалация не дублируется');

    // Через два рабочих дня — второй уровень.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 5
        WHERE request_id = $1 AND left_at IS NULL`, [target!.id]);
    await runEscalations(db, cal);
    const lvl2 = await db.one<{ level: number }>(
      `SELECT level FROM escalations WHERE request_id = $1 ORDER BY level DESC LIMIT 1`, [target!.id]);
    assert.equal(lvl2!.level, 2);

    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events
        WHERE entity = 'request' AND entity_id = $1 AND regulation_ref = 'п. 100'`, [target!.id]);
    assert.ok(Number(logged!.n) >= 2, 'эскалации записаны в журнал со ссылкой на пункт');
  });

  test('заявка закрывается по истечении срока оферты (табл. 1)', async () => {
    const created = await call('POST', '/api/v1/requests', { as: users.customer, body: application() });
    const id = created.body.request.uuid;
    await call('POST', `/api/v1/requests/${id}/registration`, {
      as: users.records,
      body: { incomingNumber: 'вх-1400', incomingDate: new Date().toISOString().slice(0, 10) },
    });
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.records, body: { to: 'tv_review' } });
    await call('POST', `/api/v1/requests/${id}/tv`, {
      as: users.orpsd,
      body: { status: 'confirmed', masterFileVersion: '2026-09-01', verificationCalc: 'not_required' },
    });
    await db.query(
      `INSERT INTO contracts (number, request_id, counterparty_id, status)
       VALUES ('ДП-300/26', $1, $2, 'signed')`, [id, counterpartyId]);
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'offer' } });
    await call('POST', `/api/v1/requests/${id}/transition`, { as: users.orpsd, body: { to: 'awaiting_payment' } });

    // Срок оферты истёк.
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 1 WHERE request_id = $1 AND left_at IS NULL`, [id]);

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
    const paid = await db.one<{ id: string }>(
      `SELECT r.id FROM requests r JOIN contracts c ON c.request_id = r.id
        WHERE c.paid_at IS NOT NULL AND r.stage_code NOT LIKE 'closed%' LIMIT 1`);
    if (!paid) return;
    await db.query(`UPDATE requests SET stage_code = 'awaiting_payment' WHERE id = $1`, [paid.id]);
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 3 WHERE request_id = $1 AND left_at IS NULL`, [paid.id]);

    await runOfferExpiry(db, { holidays: [], workingDays: [] });
    const row = await db.one<{ stage_code: string }>(`SELECT stage_code FROM requests WHERE id = $1`, [paid.id]);
    assert.equal(row!.stage_code, 'awaiting_payment', 'оплата поступила — закрывать нельзя');
  });

  test('АВР принимается по молчанию через 10 рабочих дней (п. 94)', async () => {
    const target = await db.one<{ id: string; number: string }>(
      `SELECT id, number FROM requests WHERE stage_code NOT LIKE 'closed%' ORDER BY created_at DESC LIMIT 1`);
    await db.query(`UPDATE requests SET stage_code = 'closing' WHERE id = $1`, [target!.id]);
    await db.query(
      `UPDATE request_stages SET due_at = current_date - 1 WHERE request_id = $1 AND left_at IS NULL`, [target!.id]);
    await db.query(`UPDATE request_remarks SET resolved_at = now() WHERE request_id = $1`, [target!.id]);

    const result = await runAvrSilence(db);
    assert.ok(result.affected >= 1);

    const row = await db.one<{ stage_code: string; closing_confirmed: boolean }>(
      `SELECT stage_code, closing_confirmed FROM requests WHERE id = $1`, [target!.id]);
    assert.equal(row!.stage_code, 'closed_done');
    assert.equal(row!.closing_confirmed, true);
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
    assert.equal(results.length, 6);
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
