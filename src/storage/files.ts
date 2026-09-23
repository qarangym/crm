/**
 * Хранение файлов актов.
 *
 * Файлы лежат в файловой системе, в базе — только карточка, ключ объекта и
 * SHA-256 (см. `file_versions`). Такое разделение перенесено из действующего
 * прототипа: база остаётся компактной, а резервное копирование файлов и данных
 * выполняется независимо.
 *
 * Требование ТЗ: фиксировать дату, время и наименование затронутого файла при
 * просмотре, загрузке, скачивании и изменении — журналирование выполняется
 * на уровне API, здесь только хранение.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { ApiError } from '../server/errors.ts';

/** Допустимые типы вложений. Исполняемые файлы не принимаются. */
const ALLOWED: Record<string, { mime: string; signature?: string[] }> = {
  pdf:  { mime: 'application/pdf', signature: ['25504446'] },
  png:  { mime: 'image/png', signature: ['89504e470d0a1a0a'] },
  jpg:  { mime: 'image/jpeg', signature: ['ffd8ff'] },
  jpeg: { mime: 'image/jpeg', signature: ['ffd8ff'] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: ['504b0304'] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: ['504b0304'] },
  zip:  { mime: 'application/zip', signature: ['504b0304'] },
};

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type StoredFile = {
  key: string;
  fileName: string;
  mime: string;
  size: number;
  sha256: string;
};

export function extensionOf(fileName: string): string {
  return (fileName.toLowerCase().split('.').pop() ?? '').trim();
}

/**
 * Проверка соответствия содержимого расширению.
 * Расширение подделать легко, сигнатуру — сложнее; проверяются оба.
 */
export function checkFile(fileName: string, data: Buffer): { ext: string; mime: string } {
  if (!data.length) throw new ApiError('Файл пуст');
  if (data.length > MAX_FILE_BYTES) {
    throw new ApiError(`Максимальный размер файла — ${MAX_FILE_BYTES / 1024 / 1024} МБ`, 413, 'payload_too_large');
  }
  const ext = extensionOf(fileName);
  const allowed = ALLOWED[ext];
  if (!allowed) {
    throw new ApiError('Допустимы файлы PDF, PNG, JPG, DOCX, XLSX, ZIP');
  }
  const head = data.subarray(0, 8).toString('hex');
  if (allowed.signature && !allowed.signature.some((s) => head.startsWith(s))) {
    throw new ApiError('Содержимое файла не соответствует расширению');
  }
  return { ext, mime: allowed.mime };
}

export class FileStore {
  private root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Полный путь по ключу с защитой от выхода за пределы каталога. */
  private pathOf(key: string): string {
    if (!key || !/^[A-Za-z0-9._/-]+$/.test(key) || key.split('/').some((p) => !p || p === '.' || p === '..')) {
      throw new ApiError('Некорректный ключ объекта', 400, 'invalid_key');
    }
    const path = resolve(join(this.root, key));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new ApiError('Путь выходит за пределы хранилища', 400, 'invalid_key');
    }
    return path;
  }

  /**
   * Запись файла. Сначала во временный файл, затем переименование —
   * при сбое в хранилище не остаётся частично записанного объекта.
   */
  async put(documentId: string, fileName: string, data: Buffer): Promise<StoredFile> {
    const { ext, mime } = checkFile(fileName, data);
    const key = `documents/${documentId}/${randomUUID()}.${ext}`;
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const temporary = `${path}.part`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);

    return {
      key,
      fileName: fileName.slice(0, 255),
      mime,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }

  /** Поток для отдачи файла клиенту. */
  async read(key: string): Promise<{ stream: Readable; size: number }> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      return { stream: createReadStream(path), size: info.size };
    } catch {
      throw ApiError.notFound('Файл недоступен в хранилище');
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  /** Проверка целостности: пересчёт SHA-256 по сохранённому объекту. */
  async verify(key: string, expected: string): Promise<boolean> {
    const { stream } = await this.read(key);
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex') === expected;
  }
}

/**
 * Отпечаток ключевых реквизитов акта для защиты от дублей.
 * Требование архива №11: акт с совпадающими реквизитами повторно не принимается.
 * Для вложений заявки отпечаток не считается — их «номером» служит имя файла,
 * и одинаковые имена у разных приложений законны.
 */
export function actFingerprint(parts: {
  kind: string; number: string; facilityId: string; ownerId: string;
  contractor: string; docDate: string;
}): string {
  return [parts.kind, parts.number, parts.facilityId, parts.ownerId, parts.contractor, parts.docDate]
    .map((v) => String(v ?? '').trim().toLocaleLowerCase('ru'))
    .join('|');
}
