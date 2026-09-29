/**
 * Общие зависимости маршрутов.
 *
 * Маршруты по разделам (договоры, поручения, служебные записки) живут в
 * отдельных модулях и получают от `createApp` одни и те же помощники: личность,
 * проверку источника запроса, реквизиты журнала и загрузку видимой заявки.
 */

import type { Db } from '../db/client.ts';
import type { RequestRow } from '../db/repo.ts';
import type { FileStore } from '../storage/files.ts';
import type { Ctx } from './http.ts';
import type { Actor } from './rbac.ts';

export type Audit = { actorId: string | null; actorName: string; ip: string | null; userAgent: string };

export type RouteDeps = {
  db: Db;
  /** Учётная запись по доверенным заголовкам; отказ — 401/403. */
  actor(ctx: Ctx): Promise<Actor>;
  /** Изменяющая операция принимается только со своего сайта. */
  guardOrigin(ctx: Ctx): void;
  audit(ctx: Ctx, actor: Actor | null): Audit;
  /** Заявка в пределах области видимости пользователя. */
  loadVisible(actor: Actor, id: string): Promise<RequestRow>;
  /** Хранилище файлов; без него загрузка отвечает 503. */
  store?: FileStore;
  /** Антивирусная проверка файла до записи в хранилище (C2). */
  scan(ctx: Ctx, actor: Actor, file: { filename: string; data: Buffer }, entityId: string): Promise<void>;
};

/** Дата в формате ГГГГ-ММ-ДД либо null, если поле пустое. */
export function isoDateOrNull(value: unknown): string | null | 'invalid' {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) return 'invalid';
  return text;
}
