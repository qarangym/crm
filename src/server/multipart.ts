/**
 * Разбор multipart/form-data.
 *
 * Свой разбор, а не библиотека: формат нужен ровно в одном месте — загрузка
 * файла с реквизитами документа, — и меньше зависимостей проще сопровождать
 * в закрытом контуре. Тело целиком читается в память с жёстким лимитом,
 * поэтому потоковая обработка не требуется.
 */

import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.ts';

export type UploadedFile = {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
};

export type MultipartResult = {
  fields: Record<string, string>;
  files: UploadedFile[];
};

/** Предел размера тела. 25 МБ согласовано с client_max_body_size в nginx. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function boundaryOf(contentType: string | undefined): string {
  if (!contentType || !contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new ApiError('Ожидается multipart/form-data');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!value) throw new ApiError('В заголовке Content-Type отсутствует boundary');
  return value;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new ApiError(`Размер загрузки превышает ${Math.round(limit / 1024 / 1024)} МБ`, 413, 'payload_too_large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Индексы всех вхождений разделителя. */
function findAll(haystack: Buffer, needle: Buffer): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    from = at + needle.length;
  }
  return out;
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const at = line.indexOf(':');
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

/** Значение параметра из Content-Disposition, с поддержкой filename*=UTF-8''… */
function dispositionParam(disposition: string, name: string): string {
  const extended = new RegExp(`${name}\\*=UTF-8''([^;]+)`, 'i').exec(disposition);
  if (extended) {
    try { return decodeURIComponent(extended[1]); } catch { /* останется обычный разбор */ }
  }
  const plain = new RegExp(`${name}="([^"]*)"`, 'i').exec(disposition);
  return plain ? plain[1] : '';
}

export async function parseMultipart(
  req: IncomingMessage,
  limit: number = MAX_UPLOAD_BYTES,
): Promise<MultipartResult> {
  const boundary = boundaryOf(req.headers['content-type']);
  const body = await readBody(req, limit);

  const delimiter = Buffer.from(`--${boundary}`);
  const positions = findAll(body, delimiter);
  if (positions.length < 2) throw new ApiError('Повреждённое тело multipart-запроса');

  const result: MultipartResult = { fields: {}, files: [] };

  for (let i = 0; i < positions.length - 1; i++) {
    // Часть начинается после разделителя и CRLF, заканчивается перед следующим разделителем.
    const start = positions[i] + delimiter.length;
    const end = positions[i + 1];
    if (body.slice(start, start + 2).toString() === '--') break; // завершающий разделитель

    const chunk = body.slice(start + 2, end - 2); // снимаем CRLF с обеих сторон
    const split = chunk.indexOf('\r\n\r\n');
    if (split === -1) continue;

    const headers = parseHeaders(chunk.slice(0, split).toString('utf8'));
    const disposition = headers['content-disposition'] ?? '';
    const field = dispositionParam(disposition, 'name');
    if (!field) continue;

    const data = chunk.slice(split + 4);
    const filename = dispositionParam(disposition, 'filename');

    if (filename) {
      result.files.push({
        field,
        filename: filename.slice(0, 255),
        contentType: headers['content-type'] ?? 'application/octet-stream',
        data,
      });
    } else {
      result.fields[field] = data.toString('utf8');
    }
  }

  return result;
}
