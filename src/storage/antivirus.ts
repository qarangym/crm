/**
 * Антивирусная проверка вложений (План завершения, C2).
 *
 * Файлы проверяются до записи в хранилище. Используется ClamAV (демон clamd)
 * по его сетевому протоколу INSTREAM — без сторонних библиотек. Вместо ClamAV
 * можно подключить корпоративный антивирус ДИТ, если он принимает тот же протокол
 * (многие шлюзы его поддерживают); иначе достаточно реализовать интерфейс `Scanner`.
 *
 * Включение — переменными окружения:
 *   ANTIVIRUS=clamd          проверка включена (по умолчанию выключена)
 *   CLAMD_HOST=127.0.0.1     адрес демона
 *   CLAMD_PORT=3310          порт демона
 *   CLAMD_TIMEOUT_MS=30000   предельное время проверки одного файла
 *
 * Если проверка включена, а антивирус недоступен, загрузка отклоняется:
 * непроверенный файл в архив не попадает.
 */

import { connect } from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface Scanner {
  readonly name: string;
  scan(data: Buffer, fileName: string): Promise<ScanResult>;
}

/** Антивирус недоступен или ответил ошибкой — отличаем от найденной угрозы. */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailableError';
  }
}

/** Разбор ответа clamd: `stream: OK` либо `stream: <сигнатура> FOUND`. */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  if (/:\s*OK$/.test(text)) return { clean: true };
  const found = /:\s*(.+)\s+FOUND$/.exec(text);
  if (found) return { clean: false, signature: found[1].trim() };
  throw new ScannerUnavailableError(`Антивирус ответил ошибкой: ${text || 'пустой ответ'}`);
}

export class ClamdScanner implements Scanner {
  readonly name = 'ClamAV';
  private host: string;
  private port: number;
  private timeoutMs: number;
  /** Размер порции потока; меньше StreamMaxLength демона. */
  private chunkSize: number;

  constructor(host: string, port: number, timeoutMs = 30_000, chunkSize = 64 * 1024) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.chunkSize = chunkSize;
  }

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (fn: () => void) => { if (!settled) { settled = true; socket.destroy(); fn(); } };

      socket.setTimeout(this.timeoutMs, () =>
        done(() => reject(new ScannerUnavailableError('Антивирус не ответил за отведённое время'))));
      socket.on('error', (error) =>
        done(() => reject(new ScannerUnavailableError(`Антивирус недоступен: ${error.message}`))));
      socket.on('data', (part) => {
        chunks.push(part);
        // Ответ clamd в режиме «z» завершается нулевым байтом.
        if (part.includes(0)) {
          done(() => {
            try { resolve(parseClamdReply(Buffer.concat(chunks).toString('utf8'))); }
            catch (error) { reject(error); }
          });
        }
      });
      socket.on('end', () => done(() => {
        try { resolve(parseClamdReply(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      }));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += this.chunkSize) {
          const chunk = data.subarray(offset, offset + this.chunkSize);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // нулевая длина — конец потока
      });
    });
  }
}

export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): Scanner | null {
  const mode = String(env.ANTIVIRUS ?? '').trim().toLowerCase();
  if (!mode || mode === 'off' || mode === 'false') return null;
  if (mode !== 'clamd') throw new Error(`Неизвестный режим ANTIVIRUS=${mode}: допустимо clamd либо off`);
  return new ClamdScanner(
    env.CLAMD_HOST?.trim() || '127.0.0.1',
    Number(env.CLAMD_PORT ?? 3310),
    Number(env.CLAMD_TIMEOUT_MS ?? 30_000),
  );
}
