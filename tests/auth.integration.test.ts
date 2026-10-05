/**
 * Вход по паролю и коду на почту, регистрация Заказчика, восстановление пароля
 * (src/server/login.ts) — против PostgreSQL.
 *
 * Корпоративный вход здесь выключен: единственный способ — сессия. Письма не
 * отправляются, а складываются в массив — из него тест берёт коды и ссылки.
 *
 * Запуск: TEST_DATABASE_URL=postgres://… npm run test:integration
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { createApp } from '../src/server/app.ts';
import { hashPassword } from '../src/server/passwords.ts';
import { validBin } from '../src/domain/validation.ts';

const URL_ENV = process.env.TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const DOMAIN = 'auth-test.kz';
const PASSWORD = 'Надёжный-пароль-2026';

/** БИН с верным контрольным разрядом из 11 первых цифр. */
function makeBin(seed: number): string {
  for (let n = seed; ; n++) {
    const head = String(n).padStart(11, '0').slice(-11);
    for (let c = 0; c <= 9; c++) if (validBin(head + c)) return head + c;
  }
}

/** БИН организаций теста: удаляются до и после прогона, чтобы повторный прогон начинался с чистого листа. */
const BINS = [makeBin(88800000001), makeBin(88800000101), makeBin(88800000201), makeBin(88800000301)];

describe('вход и регистрация с PostgreSQL', { skip: URL_ENV ? false : 'не задан TEST_DATABASE_URL' }, () => {
  let db: Db;
  let server: Server;
  let base = '';
  const mails: { to: string; subject: string; text: string }[] = [];
  let adminCookie = '';

  const lastMail = (to: string) => [...mails].reverse().find((m) => m.to === to);
  const codeFor = (to: string) => lastMail(to)?.text.match(/\b(\d{6})\b/)?.[1] ?? '';
  const linkFor = (to: string) => lastMail(to)?.text.match(/\?(?:reset|invite)=(\S+)/)?.[1] ?? '';

  async function call(method: string, path: string, options: { body?: unknown; cookie?: string } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(options.cookie ? { cookie: options.cookie } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    return { status: res.status, body: await res.json().catch(() => null), setCookie,
      cookie: setCookie.split(';')[0] };
  }

  /** Полный вход: пароль → код из письма → cookie сессии. */
  async function login(email: string, password = PASSWORD): Promise<string> {
    const step1 = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    assert.equal(step1.status, 200, JSON.stringify(step1.body));
    const step2 = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: step1.body.challengeId, code: codeFor(email) } });
    assert.equal(step2.status, 200, JSON.stringify(step2.body));
    return step2.cookie;
  }

  const registration = (email: string, bin: string, company = 'ТОО «Тест Связь»') => ({
    company, bin, fullName: 'Иванов Иван', position: 'Директор', phone: '+7 701 234 56 78',
    email, password: PASSWORD, consent: true,
  });

  /** Пользователи и организации теста вместе с журналом и письмами о них. */
  async function cleanup() {
    const like = `%@${DOMAIN}`;
    // Журнал неизменяем (миграция 013); тестовая база очищается с явным флагом сеанса.
    await db.tx(async (t) => {
      await t.query(`SELECT set_config('qtr.audit_purge', 'on', true)`);
      await t.query(`DELETE FROM events WHERE actor_id IN (SELECT id FROM users WHERE email LIKE $1
                       OR counterparty_id IN (SELECT id FROM counterparties WHERE bin = ANY($2)))`, [like, BINS]);
    });
    await db.query(`DELETE FROM notifications WHERE recipient LIKE $1`, [like]);
    await db.query(`DELETE FROM users WHERE email LIKE $1 OR counterparty_id IN (SELECT id FROM counterparties WHERE bin = ANY($2))`, [like, BINS]);
    await db.query(`DELETE FROM counterparties WHERE bin = ANY($1)`, [BINS]);
  }

  before(async () => {
    db = createDb(URL_ENV!);
    await migrate(db, join(here, '..', 'src', 'db'));
    await cleanup();

    const admin = await db.one<{ id: string }>(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Администратор теста', $2, now()) RETURNING id`,
      [`admin@${DOMAIN}`, await hashPassword(PASSWORD)]);
    await db.query(`INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')`, [admin!.id]);

    const handle = createApp({
      db, auth: { enabled: false, proxySecret: '', issuer: '', devIdentity: null },
      trustProxy: true, rateLimit: { max: 100_000 },
      localAuth: {
        secret: 'x'.repeat(40), cookieSecure: true, selfRegistration: true,
        sendMail: async (to, subject, text) => { mails.push({ to, subject, text }); },
        limits: { perIp: 10_000, perEmail: 10_000, registrations: 10_000 },
      },
    });
    server = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    adminCookie = await login(`admin@${DOMAIN}`);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
    await db.close();
  });

  test('без сессии API отвечает 401', async () => {
    assert.equal((await call('GET', '/api/v1/me')).status, 401);
    assert.equal((await call('GET', '/api/v1/me', { cookie: 'qtr_session=' + 'A'.repeat(43) })).status, 401);
  });

  test('Заказчик регистрируется по БИН, подтверждает почту кодом и входит', async () => {
    const email = `new@${DOMAIN}`;
    const bin = BINS[0];
    const bad = await call('POST', '/api/v1/auth/register', { body: { ...registration(email, bin), bin: '123456789012', consent: false, password: '123' } });
    assert.equal(bad.status, 422);
    for (const f of ['bin', 'consent', 'password']) assert.ok(bad.body.fields[f], f);

    const res = await call('POST', '/api/v1/auth/register', { body: registration(email, bin) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sentTo, 'ne***@' + DOMAIN, 'почта в ответе замаскирована');

    const stored = await db.one<{ password_hash: string; personal_data_consent_at: string | null; is_active: boolean }>(
      'SELECT password_hash, personal_data_consent_at, is_active FROM users WHERE email = $1', [email]);
    assert.match(stored!.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!stored!.password_hash.includes(PASSWORD), 'пароль не хранится');
    assert.ok(stored!.personal_data_consent_at, 'согласие на обработку ПД записано');
    assert.equal(stored!.is_active, true, 'новая организация — доступ сразу');

    const wrong = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: res.body.challengeId, code: '000000' } });
    assert.equal(wrong.status, 422);
    const ok = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: res.body.challengeId, code: codeFor(email) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.setCookie, /HttpOnly/);
    assert.match(ok.setCookie, /SameSite=Lax/);
    assert.match(ok.setCookie, /Secure/);

    const me = await call('GET', '/api/v1/me', { cookie: ok.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body.roles, ['customer']);
    assert.equal(me.body.counterparty.bin, bin);
    assert.equal(me.body.isCustomer, true);

    const reused = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: res.body.challengeId, code: codeFor(email) } });
    assert.equal(reused.status, 422, 'код одноразовый');
  });

  test('повторная регистрация занятого адреса не выдаёт, что адрес занят', async () => {
    const email = `new@${DOMAIN}`;
    const before = await db.one<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE email = $1', [email]);
    const res = await call('POST', '/api/v1/auth/register', { body: registration(email, BINS[1]) });
    assert.equal(res.status, 200, 'ответ как при новой регистрации');
    assert.ok(res.body.challengeId);
    assert.match(lastMail(email)!.subject, /Попытка повторной регистрации/);
    const after = await db.one<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE email = $1', [email]);
    assert.equal(after!.n, before!.n, 'вторая учётная запись не создана');
  });

  test('представитель известной организации ждёт подтверждения ДИТ', async () => {
    const bin = BINS[2];
    await db.query(`INSERT INTO counterparties (bin, name_full, name_short, status) VALUES ($1, 'ТОО «Тест Известная»', 'Тест', 'active')`, [bin]);
    const email = `second@${DOMAIN}`;
    const res = await call('POST', '/api/v1/auth/register', { body: registration(email, bin, 'ТОО «Тест Известная»') });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const verified = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: res.body.challengeId, code: codeFor(email) } });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.pending, true, 'сессия не открыта');
    assert.equal(verified.setCookie, '');

    const denied = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(denied.status, 403);
    assert.match(denied.body.message ?? denied.body.error ?? JSON.stringify(denied.body), /подтверждения ДИТ/);

    const user = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    // ДИТ узнаёт о регистрации не только из письма: она в «Моих задачах», ссылка ведёт на «Пользователей».
    const tasks = await call('GET', '/api/v1/tasks', { cookie: adminCookie });
    assert.ok(tasks.body.tasks.some((t: any) => t.kind === 'user' && t.id === user!.id && /Проверить и включить/.test(t.title)),
      JSON.stringify(tasks.body.tasks));
    const bell = await call('GET', '/api/v1/inbox', { cookie: adminCookie });
    assert.ok(bell.body.items.some((i: any) => i.event_key === 'registration_pending' && i.link === '/#/users'));
    const enabled = await call('POST', `/api/v1/users/${user!.id}/enable`, { cookie: adminCookie });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    const pending = await db.one<{ registration_pending: boolean }>('SELECT registration_pending FROM users WHERE id = $1', [user!.id]);
    assert.equal(pending!.registration_pending, false);
    const cookie = await login(email);
    assert.equal((await call('GET', '/api/v1/me', { cookie })).status, 200);
    const after = await call('GET', '/api/v1/tasks', { cookie: adminCookie });
    assert.ok(!after.body.tasks.some((t: any) => t.kind === 'user' && t.id === user!.id), 'включённая учётная запись уходит из задач');
  });

  test('подрядчик регистрируется сам, но допуск открывает ДИТ; кабинеты не пересекаются', async () => {
    const email = `contractor@${DOMAIN}`;
    const res = await call('POST', '/api/v1/auth/register', { body: { ...registration(email, BINS[3], 'ТОО «Тест Подряд»'), kind: 'contractor' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const roles = await db.query<{ role: string }>(
      `SELECT r.role FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.email = $1`, [email]);
    assert.deepEqual(roles.map((r) => r.role), ['contractor'], 'только роль подрядчика');
    const verified = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: res.body.challengeId, code: codeFor(email) } });
    assert.equal(verified.body.pending, true, 'даже новая организация ждёт подтверждения');
    assert.equal(verified.setCookie, '');
    const user = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal((await call('POST', `/api/v1/users/${user!.id}/enable`, { cookie: adminCookie })).status, 200);
    const cookie = await login(email);
    const me = await call('GET', '/api/v1/me', { cookie });
    assert.deepEqual(me.body.modules, ['permits'], 'только портал допусков');
    assert.equal((await call('GET', '/api/v1/requests', { cookie })).status, 403, 'заявки ОР ПСД подрядчику недоступны');
  });

  test('неверный пароль — один ответ для любой почты; после 10 ошибок вход блокируется', async () => {
    const email = `lock@${DOMAIN}`;
    await db.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Блокировка Тест', $2, now())`,
      [email, await hashPassword(PASSWORD)]);
    const unknown = await call('POST', '/api/v1/auth/login', { body: { email: `nobody@${DOMAIN}`, password: 'что-то-другое' } });
    const known = await call('POST', '/api/v1/auth/login', { body: { email, password: 'что-то-другое' } });
    assert.equal(unknown.status, 401);
    assert.deepEqual(known.body, unknown.body, 'ответ не выдаёт, существует ли адрес');

    for (let i = 0; i < 9; i++) await call('POST', '/api/v1/auth/login', { body: { email, password: 'неверный-пароль' } });
    const locked = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(locked.status, 429, 'даже верный пароль не пускает до конца блокировки');
    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM events WHERE action = 'Неудачный вход' AND actor_name = $1`, [email]);
    assert.ok(Number(logged!.n) >= 10, 'каждая неудачная попытка — в журнале');
  });

  test('код входа: 5 попыток, затем код гаснет', async () => {
    const email = `code@${DOMAIN}`;
    await db.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES ($1, 'Код Тест', $2, now())`,
      [email, await hashPassword(PASSWORD)]);
    const step1 = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/v1/auth/login/code', { body: { challengeId: step1.body.challengeId, code: '111111' } })).status, 422);
    }
    const late = await call('POST', '/api/v1/auth/login/code', { body: { challengeId: step1.body.challengeId, code: codeFor(email) } });
    assert.equal(late.status, 429, 'верный код после 5 ошибок уже не принимается');
  });

  test('восстановление пароля: одинаковый ответ, ссылка одноразовая, старые сессии закрываются', async () => {
    const email = `new@${DOMAIN}`;
    const oldCookie = await login(email);
    const count = mails.length;
    assert.equal((await call('POST', '/api/v1/auth/password/forgot', { body: { email: `nobody@${DOMAIN}` } })).status, 200);
    assert.equal(mails.length, count, 'на несуществующий адрес письмо не уходит');
    assert.equal((await call('POST', '/api/v1/auth/password/forgot', { body: { email } })).status, 200);
    const token = linkFor(email);
    assert.ok(token, 'ссылка в письме');

    const weak = await call('POST', '/api/v1/auth/password/reset', { body: { token, password: '1234567890' } });
    assert.equal(weak.status, 422);
    const NEW = 'Другой-надёжный-пароль-7';
    const done = await call('POST', '/api/v1/auth/password/reset', { body: { token, password: NEW } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await call('POST', '/api/v1/auth/password/reset', { body: { token, password: NEW + '1' } })).status, 422, 'ссылка одноразовая');
    assert.equal((await call('GET', '/api/v1/me', { cookie: oldCookie })).status, 401, 'старая сессия закрыта');
    assert.equal((await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } })).status, 401, 'старый пароль не действует');
    assert.equal((await call('GET', '/api/v1/me', { cookie: await login(email, NEW) })).status, 200);
  });

  test('сотрудник: ДИТ заводит и приглашает, сотрудник задаёт пароль; отключение закрывает сессии', async () => {
    const email = `staff@${DOMAIN}`;
    const created = await call('POST', '/api/v1/users', { cookie: adminCookie, body: {
      email, fullName: 'Петров Пётр', roles: ['orpsd'], isActive: true } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const invited = await call('POST', `/api/v1/users/${created.body.user.id}/invite`, { cookie: adminCookie });
    assert.equal(invited.status, 200, JSON.stringify(invited.body));
    const set = await call('POST', '/api/v1/auth/password/reset', { body: { token: linkFor(email), password: PASSWORD } });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    const cookie = await login(email);
    const me = await call('GET', '/api/v1/me', { cookie });
    assert.deepEqual(me.body.roles, ['orpsd']);

    const disabled = await call('POST', `/api/v1/users/${created.body.user.id}/disable`, { cookie: adminCookie });
    assert.equal(disabled.status, 200);
    assert.equal((await call('GET', '/api/v1/me', { cookie })).status, 401, 'отключение сразу закрывает сессию');
    assert.equal((await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } })).status, 403);
  });

  test('выход закрывает сессию; приглашать может только ДИТ', async () => {
    const email = `new@${DOMAIN}`;
    const cookie = await login(email, 'Другой-надёжный-пароль-7');
    const user = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal((await call('POST', `/api/v1/users/${user!.id}/invite`, { cookie })).status, 403);
    const out = await call('POST', '/api/v1/auth/logout', { cookie });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal((await call('GET', '/api/v1/me', { cookie })).status, 401);
  });

  test('демо-стенд: код входа на экране и список учётных записей — только с DEMO_MODE', async () => {
    const email = `admin@${DOMAIN}`;
    assert.equal((await call('GET', '/api/v1/auth/demo')).status, 404, 'на рабочем контуре маршрута нет');
    const plain = await call('POST', '/api/v1/auth/login', { body: { email, password: PASSWORD } });
    assert.equal(plain.body.demoCode, undefined, 'без DEMO_MODE код только в письме');

    await db.query(`INSERT INTO settings (key, value) VALUES ('demo.accounts', $1::jsonb)
                    ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [JSON.stringify([{ email, title: 'ДИТ' }, { email: `nobody@${DOMAIN}`, title: 'Нет такой' }])]);
    const handle = createApp({
      db, auth: { enabled: false, proxySecret: '', issuer: '', devIdentity: null }, trustProxy: true, rateLimit: { max: 100_000 },
      localAuth: { secret: 'y'.repeat(40), cookieSecure: false, selfRegistration: true, demoMode: true, demoPassword: 'demo-stand-2026',
        limits: { perIp: 10_000, perEmail: 10_000, registrations: 10_000 } },
    });
    const demo = createServer((req, res) => { void handle(req, res); });
    await new Promise<void>((resolve) => demo.listen(0, '127.0.0.1', resolve));
    const demoBase = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
    try {
      const post = (path: string, body: unknown, cookie = '') => fetch(demoBase + path, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
      const list = await (await fetch(demoBase + '/api/v1/auth/demo')).json();
      assert.equal(list.password, 'demo-stand-2026');
      assert.deepEqual(list.accounts.map((a: any) => a.email), [email], 'показываются только существующие учётные записи');
      const step1 = await (await post('/api/v1/auth/login', { email, password: PASSWORD })).json();
      assert.match(step1.demoCode, /^\d{6}$/);
      const step2 = await post('/api/v1/auth/login/code', { challengeId: step1.challengeId, code: step1.demoCode });
      assert.equal(step2.status, 200);
      const cookie = (step2.headers.get('set-cookie') ?? '').split(';')[0];
      const me = await (await fetch(demoBase + '/api/v1/me', { headers: { cookie } })).json();
      assert.equal(me.demo, true, 'интерфейс показывает полосу «Демонстрационный стенд»');
    } finally {
      await new Promise<void>((resolve) => demo.close(() => resolve()));
      await db.query(`DELETE FROM settings WHERE key = 'demo.accounts'`);
    }
  });
});
