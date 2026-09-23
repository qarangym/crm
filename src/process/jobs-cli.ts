/**
 * Разовый прогон фоновых заданий из командной строки.
 *
 * Нужен для запуска по расписанию системными средствами (cron, systemd timer),
 * если внутренний планировщик приложения выключен (JOBS_ENABLED=false) —
 * например, когда приложение работает в нескольких экземплярах и задания
 * должны выполняться только на одном узле.
 *
 * Запуск: npm run jobs
 */

import { createDb, databaseUrl } from '../db/client.ts';
import { runAllJobs } from './scheduler.ts';
import { createMailer, mailConfigFromEnv, processQueue } from '../server/notifications.ts';

const db = createDb(databaseUrl());
try {
  for (const result of await runAllJobs(db)) {
    console.log(`${result.job} (${result.regulationRef}): затронуто ${result.affected}`);
    for (const line of result.details ?? []) console.log(`   ${line}`);
  }
  const mail = await processQueue(db, createMailer(mailConfigFromEnv()));
  console.log(`Очередь уведомлений: отправлено ${mail.sent}, ошибок ${mail.failed}, отложено ${mail.skipped}`);
} catch (error) {
  console.error('Ошибка выполнения заданий:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
