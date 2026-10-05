/**
 * Применение миграций.
 *
 * Файлы `src/db/*.sql` применяются по возрастанию имени, каждый — в своей
 * транзакции, с отметкой в таблице `schema_migrations`. Повторный запуск
 * безопасен: уже применённые файлы пропускаются.
 *
 * Запуск: npm run migrate
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Db } from './client.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type MigrationResult = { name: string; status: 'applied' | 'skipped' };

/**
 * Контрольная сумма миграции. Концы строк приводятся к LF: git на Windows выдаёт файлы с CRLF,
 * на сервере — с LF, и одна и та же миграция не должна считаться изменённой.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function migrate(db: Db, dir: string = here): Promise<MigrationResult[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        varchar(255) PRIMARY KEY,
      checksum    char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = await db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const applied = new Map(done.map((r) => [r.name, r.checksum]));
  const results: MigrationResult[] = [];

  for (const name of files) {
    const sql = readFileSync(join(dir, name), 'utf8');
    const checksum = migrationChecksum(sql);
    const previous = applied.get(name);

    if (previous) {
      // Конфигурация процесса (002) переприменяется при изменении: она идемпотентна
      // (ON CONFLICT DO UPDATE) и должна догонять изменения в src/process.
      const reapplyable = /_config\.sql$/.test(name);
      if (previous === checksum) { results.push({ name, status: 'skipped' }); continue; }
      if (!reapplyable) {
        throw new Error(
          `Миграция ${name} изменилась после применения. Не правьте применённые миграции — добавьте новую.`,
        );
      }
    }

    await db.tx(async (t) => {
      await t.query(sql);
      await t.query(
        `INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET checksum = excluded.checksum, applied_at = now()`,
        [name, checksum],
      );
    });
    results.push({ name, status: 'applied' });
  }
  return results;
}

// Запуск из командной строки — в migrate-cli.ts, чтобы этот модуль можно было
// импортировать из приложения без побочных эффектов.
