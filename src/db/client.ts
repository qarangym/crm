/**
 * Подключение к PostgreSQL.
 *
 * Тонкая обёртка над пулом `pg`: параметризованные запросы, транзакции и
 * единая точка настройки. Слоя совместимости с чужим API, как в прототипе
 * (эмуляция Cloudflare D1), здесь нет — работаем с базой напрямую.
 */

import pg from 'pg';

export type QueryParam = string | number | boolean | Date | null | undefined | object;

export type Db = {
  query<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: QueryParam[]): Promise<T | null>;
  /** Выполняет функцию в транзакции: при исключении всё откатывается. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function wrap(runner: pg.Pool | pg.PoolClient, pool?: pg.Pool): Db {
  return {
    async query<T>(text: string, params: QueryParam[] = []): Promise<T[]> {
      const res = await runner.query(text, params as unknown[]);
      return res.rows as T[];
    },
    async one<T>(text: string, params: QueryParam[] = []): Promise<T | null> {
      const rows = await this.query<T>(text, params);
      return rows[0] ?? null;
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      // Вложенная транзакция не открывается повторно: клиент уже внутри неё.
      if (!pool) return fn(this);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (pool) await pool.end();
    },
  };
}

export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Держим соединения живыми, но не бесконечно: при перезапуске базы пул сам восстановится.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Без обработчика единичная сетевая ошибка простаивающего соединения роняет процесс.
  pool.on('error', (err) => console.error('Ошибка пула PostgreSQL:', err.message));
  return wrap(pool, pool);
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) return url;
  const host = env.PGHOST ?? 'localhost';
  const port = env.PGPORT ?? '5432';
  const user = env.PGUSER ?? 'qtr';
  const password = env.PGPASSWORD ?? '';
  const name = env.PGDATABASE ?? 'qtr_crm';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}
