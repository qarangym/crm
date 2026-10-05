import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authConfigFromEnv, checkOrigin, identityFromHeaders, identityId, originOfRequest } from '../src/server/auth.ts';
import { ApiError } from '../src/server/errors.ts';
import { Router } from '../src/server/http.ts';
import * as rbac from '../src/server/rbac.ts';
import type { Actor } from '../src/server/rbac.ts';
import type { Role } from '../src/domain/types.ts';

/* -------------------------------- вход -------------------------------- */

const SECRET = 'x'.repeat(40);
const ssoConfig = { enabled: true, proxySecret: SECRET, issuer: 'https://sso.example/realms/qtr', devIdentity: null };

const headers = (over: Record<string, string> = {}) => ({
  'x-qtr-proxy-key': SECRET,
  'x-qtr-user-id': 'subject-1',
  'x-qtr-user-email': 'Ivanov@qtr.kz',
  'x-qtr-user-name': 'Иванов И.',
  ...over,
});

test('личность принимается только при совпадении секрета обратного прокси', () => {
  const ok = identityFromHeaders(headers(), ssoConfig);
  assert.ok(ok);
  assert.equal(ok!.email, 'ivanov@qtr.kz', 'адрес приводится к нижнему регистру');
  assert.equal(ok!.userId, identityId(ssoConfig.issuer, 'subject-1'));
});

test('подделка заголовков без секрета отклоняется', () => {
  assert.equal(identityFromHeaders(headers({ 'x-qtr-proxy-key': 'подделка' }), ssoConfig), null);
  assert.equal(identityFromHeaders(headers({ 'x-qtr-proxy-key': '' }), ssoConfig), null);
  const noKey = { ...headers() } as Record<string, string>;
  delete noKey['x-qtr-proxy-key'];
  assert.equal(identityFromHeaders(noKey, ssoConfig), null);
});

test('короткий секрет не принимается даже при совпадении', () => {
  const weak = { ...ssoConfig, proxySecret: 'коротко' };
  assert.equal(identityFromHeaders(headers({ 'x-qtr-proxy-key': 'коротко' }), weak), null);
});

test('некорректные данные личности отклоняются', () => {
  assert.equal(identityFromHeaders(headers({ 'x-qtr-user-email': 'не-почта' }), ssoConfig), null);
  assert.equal(identityFromHeaders(headers({ 'x-qtr-user-id': '' }), ssoConfig), null);
});

test('идентификатор устойчив и различает издателей', () => {
  assert.equal(identityId('a', 'b'), identityId('a', 'b'));
  assert.notEqual(identityId('a', 'b'), identityId('c', 'b'));
});

test('режим разработки работает только при выключенном SSO', () => {
  const dev = authConfigFromEnv({ DEV_LOGIN_EMAIL: 'dev@qtr.kz' } as NodeJS.ProcessEnv);
  assert.equal(dev.enabled, false);
  assert.equal(identityFromHeaders({}, dev)!.email, 'dev@qtr.kz');
  const withSso = { ...dev, enabled: true, proxySecret: SECRET, issuer: 'https://sso' };
  assert.equal(identityFromHeaders({}, withSso), null, 'при включённом SSO разработческий вход игнорируется');
});

test('запрос с чужого сайта отклоняется', () => {
  assert.doesNotThrow(() => checkOrigin(undefined, 'https://crm.qtr.kz'));
  assert.doesNotThrow(() => checkOrigin('https://crm.qtr.kz', 'https://crm.qtr.kz'));
  assert.throws(() => checkOrigin('https://evil.example', 'https://crm.qtr.kz'), /другого сайта/);
});

test('без заданного APP_ORIGIN действуют запросы со своего же адреса', () => {
  // Иначе незаполненная переменная превращала систему в доступную только для чтения.
  assert.doesNotThrow(() => checkOrigin('http://127.0.0.1:3010', undefined, 'http://127.0.0.1:3010'));
  assert.throws(() => checkOrigin('https://evil.example', undefined, 'http://127.0.0.1:3010'),
    /другого сайта/);
  assert.throws(() => checkOrigin('https://any.example', undefined, undefined),
    /Задайте APP_ORIGIN/);
});

test('собственный адрес берётся из заголовков, за прокси — из X-Forwarded-*', () => {
  assert.equal(originOfRequest({ host: 'crm.qtr.kz' }, false), 'http://crm.qtr.kz');
  assert.equal(
    originOfRequest({ host: 'app:3000', 'x-forwarded-host': 'crm.qtr.kz', 'x-forwarded-proto': 'https' }, true),
    'https://crm.qtr.kz');
  // Без доверия прокси подставленные им заголовки игнорируются.
  assert.equal(
    originOfRequest({ host: 'app:3000', 'x-forwarded-host': 'evil.example' }, false),
    'http://app:3000');
  assert.equal(originOfRequest({}, true), undefined);
});

/* -------------------------------- права -------------------------------- */

const actor = (roles: Role[], over: Partial<Actor> = {}): Actor => ({
  id: 'u1', userId: 'oidc:1', email: 'u@qtr.kz', fullName: 'Пользователь',
  roles, branchId: null, counterpartyId: null, isActive: true, ...over,
});

test('роли соответствуют разграничению полномочий Регламента', () => {
  assert.equal(rbac.can(actor(['assets']), 'registry.edit'), true, 'техучёт правит реестр (п. 12)');
  assert.equal(rbac.can(actor(['orpsd']), 'registry.edit'), false, 'ОР ПСД реестр не правит');
  assert.equal(rbac.can(actor(['branch']), 'registry.edit'), false);
  assert.equal(rbac.can(actor(['customer']), 'documents.view'), false, 'Заказчику архив недоступен');
  assert.equal(rbac.can(actor(['oko']), 'documents.view'), false, 'ОКО в архив не входит');
  assert.equal(rbac.can(actor(['assets']), 'documents.view'), true, 'СУА просматривает архив');
  assert.equal(rbac.can(actor(['records']), 'request.register'), true, 'регистрирует делопроизводство (п. 6)');
  assert.equal(rbac.can(actor(['orpsd']), 'request.register'), false);
});

test('отключённая учётная запись теряет все права', () => {
  assert.equal(rbac.can(actor(['admin'], { isActive: false }), 'request.view'), false);
});

test('по умолчанию запрещено всё, что не разрешено', () => {
  assert.equal(rbac.can(actor([]), 'request.view'), false);
  assert.throws(() => rbac.require(actor([]), 'admin'), ApiError);
});

test('область видимости: Заказчик видит только свои заявки', () => {
  const scope = rbac.requestScope(actor(['customer'], { counterpartyId: 'cp-1' }));
  assert.deepEqual(scope, { kind: 'counterparty', id: 'cp-1' });
});

test('Заказчик без привязки к организации не видит ничего', () => {
  assert.deepEqual(rbac.requestScope(actor(['customer'])), { kind: 'none' });
});

test('филиал видит заявки своего филиала (п. 6.2)', () => {
  assert.deepEqual(rbac.requestScope(actor(['branch'], { branchId: 'b-1' })), { kind: 'branch', id: 'b-1' });
});

test('сотрудник ОР ПСД видит все заявки', () => {
  assert.deepEqual(rbac.requestScope(actor(['orpsd'])), { kind: 'all' });
});

test('совмещение роли филиала с ОР ПСД расширяет область до всех заявок', () => {
  assert.deepEqual(rbac.requestScope(actor(['branch', 'orpsd'], { branchId: 'b-1' })), { kind: 'all' });
});

/* ----------------------------- маршрутизация ---------------------------- */

test('маршрутизатор различает методы и разбирает параметры', () => {
  const r = new Router();
  r.get('/api/v1/requests', () => 'список');
  r.get('/api/v1/requests/:id', () => 'карточка');
  r.post('/api/v1/requests/:id/transition', () => 'переход');

  assert.equal(r.match('GET', '/api/v1/requests')?.handler({} as never), 'список');
  assert.deepEqual(r.match('GET', '/api/v1/requests/abc')?.params, { id: 'abc' });
  assert.deepEqual(r.match('POST', '/api/v1/requests/abc/transition')?.params, { id: 'abc' });
  assert.equal(r.match('POST', '/api/v1/requests'), null, 'метод не зарегистрирован');
  assert.equal(r.match('GET', '/api/v1/unknown'), null);
});

test('параметр маршрута декодируется', () => {
  const r = new Router();
  r.get('/api/v1/requests/:number', () => null);
  assert.deepEqual(r.match('GET', '/api/v1/requests/' + encodeURIComponent('ЗК-2026-0001'))?.params,
    { number: 'ЗК-2026-0001' });
});

/* -------------------------------- ошибки -------------------------------- */

test('ошибки несут код состояния и машинный код', () => {
  assert.equal(ApiError.unauthorized().status, 401);
  assert.equal(ApiError.forbidden().status, 403);
  assert.equal(ApiError.notFound().status, 404);
  assert.equal(ApiError.conflict('изменено').status, 409);
  assert.equal(ApiError.badRequest('проверьте', { bin: 'ошибка' }).fields?.bin, 'ошибка');
});

test('нарушение Регламента собирается в одно сообщение со ссылками на пункты', () => {
  const e = ApiError.regulation([
    { code: 'not_paid', message: 'Подтвердите поступление 100 % оплаты', regulationRef: 'пп. 86, 89' },
    { code: 'no_contract', message: 'Укажите номер договора', regulationRef: 'п. 83' },
  ]);
  assert.equal(e.status, 422);
  assert.equal(e.code, 'regulation_violation');
  assert.match(e.message, /пп\. 86, 89/);
  assert.equal(e.failures?.length, 2);
});

test('контрольная сумма миграции не зависит от концов строк (CRLF на Windows, LF на сервере)', async () => {
  const { migrationChecksum } = await import('../src/db/migrate.ts');
  const lf = 'CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n';
  assert.equal(migrationChecksum(lf.replace(/\n/g, '\r\n')), migrationChecksum(lf));
  assert.notEqual(migrationChecksum(lf), migrationChecksum(lf + '-- правка\n'));
});
