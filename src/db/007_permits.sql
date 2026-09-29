-- Портал допусков СУА, первый этап (docs/План_модуля_допусков.md).
--
-- Объём — наброски temp/editable: заявка подрядчика на допуск персонала и
-- техники, проверка основания по данным модуля ОР ПСД и архива актов,
-- рассмотрение одним специалистом СУА с прикреплением готового файла допуска.
-- Электронный допуск, проверка на объекте, маршрут и аварийный порядок — отдельный этап.

BEGIN;

-- ============================== РОЛИ ==============================
-- contractor — представитель сторонней организации (внешний);
-- permits    — специалист СУА, рассматривающий заявки на допуск.
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('admin','records','orpsd','branch','oko','assets','accounting','management','customer',
                  'contractor','permits'));

-- ============================== ФАЙЛЫ ==============================
-- Сканы удостоверений, основания и файлы допуска. Отдельно от архива актов:
-- это персональные данные, в общем поиске по архиву им не место.
CREATE TABLE permit_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Организация, которой принадлежат сведения: определяет, кто может открыть файл.
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  kind            varchar(16) NOT NULL CHECK (kind IN ('qualification','basis','pass')),
  storage_key     varchar(512) NOT NULL,
  file_name       varchar(255) NOT NULL,
  mime            varchar(128) NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
  sha256          char(64) NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ====================== РАБОТНИКИ И ТРАНСПОРТ ======================
-- Хранятся у организации: при повторной заявке сведения не вводятся заново.
CREATE TABLE contractor_workers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  full_name       varchar(255) NOT NULL,
  iin             char(12) NOT NULL,
  position        varchar(255) NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (counterparty_id, iin)
);

-- Квалификационные документы: срок действия обязателен (наброски, ТЗ портала §4.1).
CREATE TABLE worker_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES contractor_workers(id) ON DELETE CASCADE,
  title        varchar(255) NOT NULL,
  number       varchar(128) NOT NULL DEFAULT '',
  valid_until  date NOT NULL,
  file_id      uuid NOT NULL REFERENCES permit_files(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_worker_documents_worker ON worker_documents(worker_id);

CREATE TABLE contractor_vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  plate           varchar(16) NOT NULL,
  model           varchar(128) NOT NULL DEFAULT '',
  driver_name     varchar(255) NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (counterparty_id, plate)
);

-- Сохранённые бригады: шаблон, подставляемый в заявку одним действием.
CREATE TABLE contractor_crews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  name            varchar(255) NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (counterparty_id, name)
);
CREATE TABLE crew_members (
  crew_id   uuid NOT NULL REFERENCES contractor_crews(id) ON DELETE CASCADE,
  worker_id uuid NOT NULL REFERENCES contractor_workers(id) ON DELETE CASCADE,
  PRIMARY KEY (crew_id, worker_id)
);
CREATE TABLE crew_vehicles (
  crew_id    uuid NOT NULL REFERENCES contractor_crews(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES contractor_vehicles(id) ON DELETE CASCADE,
  PRIMARY KEY (crew_id, vehicle_id)
);

-- ========================= ЗАЯВКИ НА ДОПУСК =========================
CREATE TABLE access_request_counters (
  year integer PRIMARY KEY,
  last integer NOT NULL DEFAULT 0
);

CREATE TABLE access_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              varchar(32) NOT NULL UNIQUE,
  counterparty_id     uuid NOT NULL REFERENCES counterparties(id),
  facility_id         uuid REFERENCES facilities(id),
  branch_id           uuid REFERENCES branches(id),
  -- Основание: договор аренды, ТУ, договор на СМР, акт приёма-передачи (ТЗ портала §4.1–4.2).
  basis_type          varchar(16) CHECK (basis_type IN ('lease','tu','smr_contract','transfer_act')),
  basis_number        varchar(128) NOT NULL DEFAULT '',
  -- Найденная запись реестра: ТУ или акт — в архиве документов, договор на СМР — в договорах ОР ПСД.
  basis_document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,
  basis_contract_id   uuid REFERENCES contracts(id) ON DELETE SET NULL,
  -- Скан основания: договор аренды либо временное основание вместо акта.
  basis_file_id       uuid REFERENCES permit_files(id),
  -- Результат проверки основания на момент отправки.
  basis_check         jsonb NOT NULL DEFAULT '{}'::jsonb,
  basis_confirmed_by  uuid REFERENCES users(id),
  basis_confirmed_at  timestamptz,
  basis_confirm_note  text,
  description         text NOT NULL DEFAULT '',
  -- Период работ — справочное поле для специалиста СУА; местное время объекта.
  period_start        timestamp,
  period_end          timestamp,
  -- «Срочно» влияет только на порядок в очереди СУА (ТЗ портала §4.3).
  is_urgent           boolean NOT NULL DEFAULT false,
  status              varchar(16) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_review','approved','rejected')),
  crew_id             uuid REFERENCES contractor_crews(id) ON DELETE SET NULL,
  pass_file_id        uuid REFERENCES permit_files(id),
  rejection_reason    text,
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  -- Заявитель подтвердил согласие работников на обработку персональных данных.
  pd_consent_by       uuid REFERENCES users(id),
  pd_consent_at       timestamptz,
  submitted_at        timestamptz,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_access_period CHECK (period_start IS NULL OR period_end IS NULL OR period_end > period_start),
  CONSTRAINT chk_access_submitted CHECK (status = 'draft' OR (
    facility_id IS NOT NULL AND basis_type IS NOT NULL AND period_start IS NOT NULL
    AND period_end IS NOT NULL AND submitted_at IS NOT NULL AND pd_consent_at IS NOT NULL)),
  -- Отказ — только с причиной, одобрение — только с файлом допуска (ТЗ портала §4.3).
  CONSTRAINT chk_access_rejected CHECK (status <> 'rejected' OR length(btrim(coalesce(rejection_reason, ''))) > 0),
  CONSTRAINT chk_access_approved CHECK (status <> 'approved' OR pass_file_id IS NOT NULL),
  CONSTRAINT chk_access_reviewed CHECK (status NOT IN ('approved','rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX idx_access_requests_queue ON access_requests(is_urgent DESC, submitted_at) WHERE status = 'pending_review';
CREATE INDEX idx_access_requests_counterparty ON access_requests(counterparty_id, created_at DESC);
CREATE INDEX idx_access_requests_facility ON access_requests(facility_id);

-- Состав заявки — снимок на момент сохранения: последующая правка работника
-- не меняет отправленную заявку.
CREATE TABLE access_request_workers (
  request_id  uuid NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  worker_id   uuid NOT NULL REFERENCES contractor_workers(id),
  sort_order  smallint NOT NULL DEFAULT 0,
  full_name   varchar(255) NOT NULL,
  iin         char(12) NOT NULL,
  position    varchar(255) NOT NULL DEFAULT '',
  documents   jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (request_id, worker_id)
);

CREATE TABLE access_request_vehicles (
  request_id  uuid NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  vehicle_id  uuid NOT NULL REFERENCES contractor_vehicles(id),
  sort_order  smallint NOT NULL DEFAULT 0,
  plate       varchar(16) NOT NULL,
  model       varchar(128) NOT NULL DEFAULT '',
  driver_name varchar(255) NOT NULL DEFAULT '',
  PRIMARY KEY (request_id, vehicle_id)
);

-- ========================= РЕЖИМ ПРОВЕРКИ =========================
-- Мягкий — не найдено или истекло: предупреждение и ручное подтверждение СУА;
-- строгий — отправить заявку нельзя. По умолчанию мягкий: ТУ и договоры,
-- выданные до запуска системы, в ней не учтены (План модуля допусков, §5.3).
INSERT INTO settings (key, value, description)
VALUES ('permits.basis_mode', '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft"}'::jsonb,
        'Портал допусков: режим проверки основания по типам — soft (предупреждение) или strict (блокировка)')
ON CONFLICT (key) DO NOTHING;

COMMIT;
