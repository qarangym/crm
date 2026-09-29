import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import { ClamdScanner, ScannerUnavailableError, parseClamdReply, scannerFromEnv } from '../src/storage/antivirus.ts';

/**
 * Поддельный clamd: принимает zINSTREAM, собирает порции потока до нулевой
 * длины и отвечает, как настоящий демон. Проверяет разбор протокола целиком.
 */
async function fakeClamd(): Promise<{ port: number; received: Buffer[]; close: () => void }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let body = Buffer.alloc(0);
    let headerSeen = false;
    socket.on('data', (part) => {
      buf = Buffer.concat([buf, part]);
      if (!headerSeen) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        assert.equal(buf.subarray(0, end).toString(), 'zINSTREAM');
        buf = buf.subarray(end + 1);
        headerSeen = true;
      }
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (size === 0) {
          received.push(body);
          const infected = body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
          socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + size) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + size)]);
        buf = buf.subarray(4 + size);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, received, close: () => server.close() };
}

test('ответ clamd разбирается: чисто, угроза, ошибка', () => {
  assert.deepEqual(parseClamdReply('stream: OK\0'), { clean: true });
  assert.deepEqual(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0'), { clean: false, signature: 'Win.Test.EICAR_HDB-1' });
  assert.throws(() => parseClamdReply('INSTREAM size limit exceeded. ERROR\0'), ScannerUnavailableError);
});

test('файл передаётся порциями и проверяется целиком', async () => {
  const clamd = await fakeClamd();
  try {
    const scanner = new ClamdScanner('127.0.0.1', clamd.port, 5000, 1000);
    const clean = Buffer.alloc(3500, 0x41);
    assert.deepEqual(await scanner.scan(clean), { clean: true });
    assert.equal(clamd.received[0].length, 3500, 'все порции дошли');

    const infected = Buffer.from('%PDF X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    assert.deepEqual(await scanner.scan(infected), { clean: false, signature: 'Eicar-Test-Signature' });
  } finally {
    clamd.close();
  }
});

test('недоступный антивирус — отдельная ошибка, а не «чисто»', async () => {
  const scanner = new ClamdScanner('127.0.0.1', 1, 2000);
  await assert.rejects(() => scanner.scan(Buffer.from('x')), ScannerUnavailableError);
});

test('проверка включается только явно', () => {
  assert.equal(scannerFromEnv({}), null);
  assert.equal(scannerFromEnv({ ANTIVIRUS: 'off' }), null);
  assert.equal(scannerFromEnv({ ANTIVIRUS: 'clamd' })?.name, 'ClamAV');
  assert.throws(() => scannerFromEnv({ ANTIVIRUS: 'kaspersky' }), /clamd либо off/);
});
