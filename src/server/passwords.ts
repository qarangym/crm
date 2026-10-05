/**
 * Пароли: свёртка scrypt со случайной солью и требования к паролю.
 *
 * Пароль нигде не хранится и не пишется в журнал. Формат свёртки хранит
 * параметры, чтобы их можно было усилить без сброса паролей:
 * `scrypt$N$r$p$соль$свёртка` (соль и свёртка — base64url).
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
/** 128 · N · r = 32 МБ — больше значения по умолчанию, поэтому предел задаётся явно. */
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Свёртка для несуществующей учётной записи: время ответа не выдаёт, есть ли адрес. */
const DUMMY = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + Buffer.alloc(KEY_LENGTH).toString('base64url');

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored || DUMMY).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return !!stored && expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Самые частые пароли — короткий список; длина от 10 символов отсекает остальное. */
const COMMON = new Set([
  '1234567890', '12345678910', 'qwertyuiop', 'password123', 'password12', 'qwerty1234',
  '1q2w3e4r5t', '1qaz2wsx3edc', 'йцукенгшщз', 'qwerty12345', 'administrator', 'kaztelerad',
  'kazteleradio', 'qazaqstan1', 'kazakhstan', 'astana2026', 'almaty2026', 'parol12345',
]);

/** Требования к паролю; пустая строка — пароль подходит. */
export function passwordProblem(password: unknown, email = ''): string {
  const value = String(password ?? '');
  if (value.length < 10) return 'Пароль — не короче 10 символов';
  if (value.length > 200) return 'Пароль — не длиннее 200 символов';
  const lower = value.toLowerCase();
  if (COMMON.has(lower)) return 'Этот пароль слишком распространён — придумайте другой';
  if (/^(.)\1+$/.test(value)) return 'Пароль не может состоять из одного повторяющегося символа';
  const local = email.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Пароль не должен содержать адрес почты';
  return '';
}
