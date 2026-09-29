-- Исправления по итогам проверки функционала перед пилотом (docs/Проверка_функционала.md).
--
-- К5  — приложения к заявке хранятся документами вида «Приложение» (схема уже позволяет);
-- В3  — справочник филиалов: зона обслуживания;
-- В5  — поручение связано с заявкой: исполнение по существу, ручные поручения ОКО;
-- В6  — документ (АВР) может относиться к конкретному договору;
-- В7  — подтверждение ТВ вопреки расчёту фиксируется с основанием;
-- С7  — запрос изменения реестра АМС службе технического учёта.

BEGIN;

-- ============================ ФИЛИАЛЫ (В3) ============================
-- Приложение 7: распределение заявок по филиалам — зона обслуживания филиала.
ALTER TABLE branches ADD COLUMN service_area text NOT NULL DEFAULT '';

-- ============================ ПОРУЧЕНИЯ (В5) ============================
-- Одно автоматическое поручение ОР ПСД на заявку; ручных поручений ОКО может быть несколько.
DROP INDEX idx_assignments_request_kind;
CREATE UNIQUE INDEX idx_assignments_control ON assignments(request_id) WHERE kind = 'control';
ALTER TABLE assignments
  ADD COLUMN body text NOT NULL DEFAULT '',
  ADD COLUMN created_by uuid REFERENCES users(id),
  -- Поручение исполнено по существу: для ОР ПСД — дан ответ о технической возможности (п. 9).
  ADD COLUMN fulfilled_at timestamptz,
  ADD COLUMN fulfilled_on_time boolean;

-- ======================= АВР ПО ДОГОВОРУ (В6) =======================
-- По завершении каждой услуги — АВР и ЭСФ (п. 91), направление Заказчику (п. 92),
-- 10 рабочих дней на замечания (п. 94). Договор исполнен после подписания всех
-- документов (п. 127); заявка закрывается, когда исполнены все её договоры.
ALTER TABLE documents ADD COLUMN contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL;
CREATE INDEX idx_documents_contract ON documents(contract_id) WHERE contract_id IS NOT NULL;

ALTER TABLE contracts
  -- АВР и ЭСФ оформлены расчётами с контрагентами (п. 91).
  ADD COLUMN avr_formed_at date,
  -- АВР и ЭСФ направлены Заказчику: от этой даты — 10 рабочих дней (пп. 92, 94).
  ADD COLUMN avr_sent_at date,
  -- Мотивированные замечания Заказчика к АВР (п. 94).
  ADD COLUMN avr_objection text,
  -- Работы приняты: подписанием АВР либо по истечении срока без замечаний (пп. 94–95).
  ADD COLUMN accepted_at date,
  ADD COLUMN accepted_by_silence boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT chk_contract_avr_order CHECK (avr_sent_at IS NULL OR avr_formed_at IS NULL OR avr_sent_at >= avr_formed_at);

-- ======================= АДРЕС ОБЪЕКТА (С5) =======================
-- П. 16.1: объект определяется по адресу из заявки. Заказчик, не нашедший объект
-- в справочнике, указывает адрес; объект и филиал определяет Общество до оценки ТВ.
ALTER TABLE requests
  ALTER COLUMN facility_id DROP NOT NULL,
  ALTER COLUMN branch_id DROP NOT NULL,
  ADD COLUMN facility_address varchar(500),
  ADD CONSTRAINT chk_request_facility
    CHECK (facility_id IS NOT NULL OR length(btrim(coalesce(facility_address, ''))) > 0),
  ADD CONSTRAINT chk_request_branch CHECK (facility_id IS NULL OR branch_id IS NOT NULL);

-- ============================ ОЦЕНКА ТВ (В7) ============================
-- Решение принимает инженер (п. 16.4): подтверждение вопреки расчёту допускается,
-- но с записанным основанием.
ALTER TABLE requests ADD COLUMN tv_override_reason text;

-- ======================== ЗАПРОСЫ В ТЕХУЧЁТ (С7) ========================
-- Изменения в реестр вносит только СП ЦА, ответственное за технический учёт
-- активов (п. 12); остальные направляют ему запрос.
CREATE TABLE registry_change_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  uuid NOT NULL REFERENCES facilities(id),
  request_id   uuid REFERENCES requests(id) ON DELETE SET NULL,
  body         text NOT NULL CHECK (length(btrim(body)) >= 10),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  due_at       date,
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id),
  resolution   text,
  CONSTRAINT chk_registry_change_resolution
    CHECK (resolved_at IS NULL OR length(btrim(coalesce(resolution, ''))) > 0)
);
CREATE INDEX idx_registry_changes_open ON registry_change_requests(created_at) WHERE resolved_at IS NULL;

-- ======================= ПРЕЙСКУРАНТ (С3) =======================
-- Позиция подбирается по виду услуги и сценарию размещения; соответствие
-- задаёт ОР ПСД в справочнике, а не код.
ALTER TABLE tariffs
  ADD COLUMN placement varchar(16) CHECK (placement IS NULL OR placement IN ('ams','room','network','cable','power')),
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

-- ===================== НОРМАТИВЫ ЭТАПОВ (С9) =====================
-- Норматив, изменённый ДИТ (следующая редакция Регламента), хранится отдельно
-- от конфигурации из кода: 002_config.sql переприменяется и затёр бы правку.
CREATE TABLE stage_sla_overrides (
  stage_code  varchar(32) PRIMARY KEY REFERENCES stage_definitions(code),
  sla_value   integer NOT NULL CHECK (sla_value >= 0),
  sla_unit    varchar(16) NOT NULL CHECK (sla_unit IN ('working','calendar','operational','same_day','none')),
  sla_text    varchar(128) NOT NULL,
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 5),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- =============== КОНТРОЛЬНЫЕ ТОЧКИ (раздел 7 проверки) ===============
-- П. 23 — согласование проекта ТУ с филиалом и утверждение техническим директором;
-- пп. 34, 40–41, 52 — контрольные точки ПСД и двухуровневая проверка сметы;
-- п. 57 — претензия за непредоставление оборудования; пп. 67–69 — отказ от подписания АВР.
CREATE TABLE request_checkpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  code        varchar(48) NOT NULL,
  done_at     date NOT NULL,
  done_by     uuid NOT NULL REFERENCES users(id),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, code)
);

-- ================== ПРИОСТАНОВКА СРОКА (пп. 63, 80) ==================
-- Приостановка СМР при изменениях и неблагоприятные погодные дни исключаются из срока.
ALTER TABLE request_stages
  ADD COLUMN paused_at date,
  ADD COLUMN paused_days integer NOT NULL DEFAULT 0 CHECK (paused_days >= 0),
  ADD COLUMN pause_reason text;

-- ================= ДОПОЛНИТЕЛЬНЫЕ СОГЛАШЕНИЯ (пп. 45, 64–65) =================
CREATE TABLE contract_amendments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  number       varchar(64) NOT NULL,
  signed_at    date NOT NULL,
  amount       numeric(14,2) CHECK (amount IS NULL OR amount >= 0),
  extend_days  integer CHECK (extend_days IS NULL OR extend_days > 0),
  reason       text NOT NULL CHECK (length(btrim(reason)) >= 5),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, number)
);

-- ============ СРОК НАПРАВЛЕНИЯ АКТА (пп. 28, 58) ============
-- Акт направляется в течение 2 рабочих дней: позднее направление отмечается.
ALTER TABLE documents ADD COLUMN late_upload boolean NOT NULL DEFAULT false;

-- ============ АКТУАЛЬНОСТЬ УСЛОВИЙ ПСД (п. 47) ============
-- Условия установки актуальны 3 месяца с получения ПСД: затем — повторная оценка ТВ.
ALTER TABLE requests ADD COLUMN tv_recheck_required_at date;

COMMIT;
