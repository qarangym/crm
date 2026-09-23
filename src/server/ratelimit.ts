/**
 * Ограничение частоты запросов.
 *
 * Простое окно в памяти процесса: контур внутренний, за обратным прокси, и
 * задача здесь — не отражать распределённую атаку, а не дать одному клиенту
 * (или зациклившемуся скрипту) исчерпать соединения к базе.
 *
 * При нескольких экземплярах приложения счётчики не общие — это осознанно:
 * общий счётчик потребовал бы внешнего хранилища ради несоразмерной выгоды.
 * Защита периметра остаётся за прокси.
 */

export type RateLimitOptions = {
  /** Длина окна в миллисекундах. */
  windowMs: number;
  /** Сколько запросов допускается в окне. */
  max: number;
};

type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private options: RateLimitOptions;
  private lastSweep = 0;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  /** true — запрос разрешён; false — лимит исчерпан. */
  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number; remaining: number } {
    this.sweep(now);
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return { allowed: true, retryAfterSec: 0, remaining: this.options.max - 1 };
    }
    if (bucket.count >= this.options.max) {
      return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000), remaining: 0 };
    }
    bucket.count++;
    return { allowed: true, retryAfterSec: 0, remaining: this.options.max - bucket.count };
  }

  /** Периодическая очистка, чтобы карта не росла бесконечно. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
