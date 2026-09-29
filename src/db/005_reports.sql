-- Отчётность (План завершения, B7; Регламент пп. 105, 107, 109; ТЗ №15).
--
-- п. 105: филиалы ежемесячно, не позднее 5-го числа, направляют отчёт об
-- исполненных и неисполненных договорах за прошедший месяц. Система формирует
-- отчёт по своим данным; филиал проверяет и подтверждает его представление.
-- Снимок строк сохраняется: представленный отчёт не меняется задним числом.

BEGIN;

CREATE TABLE branch_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  period        char(7) NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  submitted_by  uuid NOT NULL REFERENCES users(id),
  note          text NOT NULL DEFAULT '',
  snapshot      jsonb NOT NULL,
  UNIQUE (branch_id, period)
);

COMMIT;
