-- Расчёт технической возможности на сервере (План завершения, B5).
--
-- Регламент п. 16.5: результат оценки фиксируется с указанием версии
-- мастер-файла, использованной при расчёте. Расчёт хранится целиком — исходные
-- данные и результат, — чтобы его можно было воспроизвести и проверить.

BEGIN;

CREATE TABLE capacity_checks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  facility_id      uuid NOT NULL REFERENCES facilities(id),
  registry_version varchar(64),
  verdict          varchar(16) NOT NULL CHECK (verdict IN ('ok','insufficient','unknown')),
  input            jsonb NOT NULL,
  result           jsonb NOT NULL,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_capacity_checks_request ON capacity_checks(request_id, created_at DESC);

-- Порог «приближения к предельным значениям» (п. 16.4) Регламентом не установлен.
-- Настройка создаётся пустой: система своего числа не подставляет.
INSERT INTO settings (key, value, description, regulation_ref)
VALUES ('tv_near_limit_percent', 'null'::jsonb,
        'Порог загрузки, %, при котором расчёт помечает приближение к предельным значениям. По умолчанию не задан.',
        'п. 16.4')
ON CONFLICT (key) DO NOTHING;

COMMIT;
