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
import { createMailer, mailConfigFromEnv, processQueue } from './notifications.ts';
import { createDb, databaseUrl } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';
import { FileStore } from '../storage/files.ts';
import { scannerFromEnv } from '../storage/antivirus.ts';
import { runAllJobs } from '../process/scheduler.ts';

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

const storageRoot = process.env.STORAGE_ROOT ?? resolve(here, '..', '..', 'storage');
const scanner = scannerFromEnv();
const handle = createApp({
  db,
  auth,
  store: new FileStore(storageRoot),
  scanner,
  appOrigin: process.env.APP_ORIGIN,
  staticRoot: process.env.STATIC_ROOT ?? resolve(here, '..', '..', 'design'),
  trustProxy: process.env.TRUST_PROXY !== 'false',
  bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
});

const server = createServer((req, res) => { void handle(req, res); });
server.listen(port, host, () => {
  console.log(`CRM ОР ПСД слушает http://${host}:${port}`);
  console.log(`Вход: ${auth.enabled ? 'корпоративный OIDC через обратный прокси' : 'режим разработки (DEV_LOGIN_EMAIL)'}`);
  console.log(`Файлы актов: ${storageRoot}`);
  console.log(`Антивирусная проверка вложений: ${scanner ? `${scanner.name} (${process.env.CLAMD_HOST ?? '127.0.0.1'}:${process.env.CLAMD_PORT ?? 3310})` : 'выключена (ANTIVIRUS)'}`);
});

/**
 * Фоновые задания Регламента: эскалация, закрытие по оферте, приёмка по
 * молчанию, напоминания. При нескольких экземплярах приложения планировщик
 * оставляют включённым только на одном узле — на остальных ставят
 * JOBS_ENABLED=false и запускают `npm run jobs` системным расписанием.
 */
const jobsEnabled = process.env.JOBS_ENABLED !== 'false';
const jobIntervalMs = Math.max(Number(process.env.JOBS_INTERVAL_MINUTES ?? 15), 1) * 60_000;
const mailer = createMailer(mailConfigFromEnv());
let jobsRunning = false;

async function tick(): Promise<void> {
  if (jobsRunning) return; // предыдущий проход ещё идёт — пропускаем такт
  jobsRunning = true;
  try {
    for (const result of await runAllJobs(db)) {
      if (result.affected > 0) {
        console.log(`[задания] ${result.job} (${result.regulationRef}): ${result.affected}`);
      }
    }
    const mail = await processQueue(db, mailer);
    if (mail.sent || mail.failed) {
      console.log(`[уведомления] отправлено ${mail.sent}, ошибок ${mail.failed}`);
    }
  } catch (error) {
    console.error('[задания] сбой прохода:', (error as Error).message);
  } finally {
    jobsRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;
if (jobsEnabled) {
  console.log(`Фоновые задания: каждые ${jobIntervalMs / 60_000} мин` +
    (mailer ? ', почта подключена' : ', отправка почты выключена (SMTP_ENABLED)'));
  timer = setInterval(() => { void tick(); }, jobIntervalMs);
  timer.unref();
  void tick();
}

/** Корректное завершение: сначала перестаём принимать запросы, затем закрываем пул. */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`Получен ${signal}, завершение…`);
    if (timer) clearInterval(timer);
    server.close(() => { void db.close().then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
