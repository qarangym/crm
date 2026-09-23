/**
 * Точка входа сервера.
 *
 * Слушает только локальный интерфейс: наружу приложение публикуется через
 * обратный прокси, который отвечает за TLS и корпоративный вход. Порт
 * приложения в compose наружу не пробрасывается.
 *
 * Запуск: npm start
 */

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { authConfigFromEnv } from './auth.ts';
import { createDb, databaseUrl } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';

const here = dirname(fileURLToPath(import.meta.url));

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const auth = authConfigFromEnv();

if (auth.enabled && auth.proxySecret.length < 32) {
  console.error('AUTH_PROXY_SHARED_SECRET короче 32 символов — запуск с включённым SSO отменён.');
  process.exit(1);
}
if (!auth.enabled && !auth.devIdentity) {
  console.warn('Внимание: SSO выключен и DEV_LOGIN_EMAIL не задан — API будет отвечать 401.');
}

const db = createDb(databaseUrl());

if (process.env.MIGRATE_ON_START === 'true') {
  for (const r of await migrate(db, join(here, '..', 'db'))) {
    if (r.status === 'applied') console.log(`миграция применена: ${r.name}`);
  }
}

const handle = createApp({
  db,
  auth,
  appOrigin: process.env.APP_ORIGIN,
  staticRoot: process.env.STATIC_ROOT ?? resolve(here, '..', '..', 'design'),
  trustProxy: process.env.TRUST_PROXY !== 'false',
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
});

const server = createServer((req, res) => { void handle(req, res); });
server.listen(port, host, () => {
  console.log(`CRM ОР ПСД слушает http://${host}:${port}`);
  console.log(`Вход: ${auth.enabled ? 'корпоративный OIDC через обратный прокси' : 'режим разработки (DEV_LOGIN_EMAIL)'}`);
});

/** Корректное завершение: сначала перестаём принимать запросы, затем закрываем пул. */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`Получен ${signal}, завершение…`);
    server.close(() => { void db.close().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
