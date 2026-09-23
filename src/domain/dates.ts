/**
 * Приведение значений даты из PostgreSQL к виду YYYY-MM-DD.
 *
 * Драйвер `pg` возвращает колонки типа `date` объектом Date, установленным на
 * локальную полночь. Приведение через `toISOString()` переводит его в UTC и в
 * поясе Алматы (UTC+5/+6) сдвигает дату на сутки назад — сроки Регламента при
 * этом считаются от неверного дня. Поэтому дату собираем из локальных
 * составляющих.
 */

export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/** То же, но с гарантией непустого результата — для обязательных полей. */
export function requireIsoDate(value: unknown): string {
  const iso = toIsoDate(value);
  if (!iso) throw new Error('Ожидалась дата, получено пустое значение');
  return iso;
}

/**
 * Метка времени в ISO. Для `timestamptz` сдвига не возникает: момент времени
 * однозначен, и UTC-представление корректно.
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
