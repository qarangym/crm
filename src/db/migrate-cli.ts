/**
 * Применение миграций из командной строки.
 * Запуск: npm run migrate
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, databaseUrl } from './client.ts';
import { migrate } from './migrate.ts';

const db = createDb(databaseUrl());
try {
  const results = await migrate(db, dirname(fileURLToPath(import.meta.url)));
  for (const r of results) {
    console.log(`${r.status === 'applied' ? 'применено' : 'пропущено'}: ${r.name}`);
  }
  const applied = results.filter((r) => r.status === 'applied').length;
  console.log(applied ? `Миграции завершены, применено файлов: ${applied}.` : 'Схема актуальна.');
} catch (error) {
  console.error('Ошибка миграции:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
