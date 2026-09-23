/**
 * Минимальный HTTP-слой: маршрутизация, чтение тела, ответы и статика.
 * Внешних веб-фреймворков нет — набор маршрутов небольшой, а меньше
 * зависимостей проще сопровождать и обновлять на закрытом контуре.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ApiError } from './errors.ts';

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  ip: string | null;
  body: <T>() => Promise<T>;
};

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
type Route = { method: string; parts: string[]; handler: Handler };

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(path: string, h: Handler) { return this.add('GET', path, h); }
  post(path: string, h: Handler) { return this.add('POST', path, h); }
  patch(path: string, h: Handler) { return this.add('PATCH', path, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
        else if (p !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

const MAX_BODY = 1024 * 1024; // 1 МБ: заявка — это текст и числа, файлы идут отдельным маршрутом

export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new ApiError('Тело запроса слишком велико', 413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ApiError('Некорректный JSON в теле запроса');
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, {
      error: error.message,
      code: error.code,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.failures ? { failures: error.failures } : {}),
    });
    return;
  }
  console.error('Внутренняя ошибка:', error);
  sendJson(res, 500, {
    error: 'Не удалось выполнить операцию. Данные формы сохранены на экране, повторите попытку.',
    code: 'internal_error',
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Отдача статики с защитой от выхода за пределы каталога. */
export async function sendStatic(res: ServerResponse, root: string, pathname: string): Promise<boolean> {
  const rootPath = resolve(root);
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  const file = resolve(join(rootPath, rel === '' ? 'index.html' : rel));
  if (file !== rootPath && !file.startsWith(rootPath + sep)) return false;

  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string | null {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? null;
}
