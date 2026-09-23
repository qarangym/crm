-- CRM ОР ПСД АО «Казтелерадио». Начальная схема PostgreSQL.
--
-- Источники: Регламент ОРПСД-Р-01 ред. 2 (обязательная рамка), Упрощённое ТЗ ОР ПСД.
-- Ссылки на пункты Регламента приведены в комментариях к таблицам и полям:
-- при проверке нужно сопоставлять структуру данных с нормой.
--
-- Отличия от схемы прототипа (SQLite):
--   * контрагент и объект — справочники, а не строки в форме заявки;
--   * несколько услуг в одной заявке (п. 7.5) вместо одной;
--   * история этапов (request_stages) — основа аналитики узких мест;
--   * договоры, служебные записки, эскалации, замечания — отдельные сущности;
--   * конфигурация процесса (этапы, переходы, правила, календарь) — в таблицах.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================ СПРАВОЧНИКИ ЯДРА ============================

-- Филиалы и кураторы. Регламент п. 6.2, Приложение 7.
CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(32)  NOT NULL UNIQUE,
  name          varchar(255) NOT NULL,
  region        varchar(255) NOT NULL DEFAULT '',
  director_id   uuid,
  -- Курирующий заместитель директора: адресат эскалации 1-го уровня (п. 100).
  curator_id    uuid,
  chief_engineer_id uuid,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Контрагенты. Единый справочник для Заказчиков и подрядчиков:
-- на него будет ссылаться будущий модуль СУА при проверке оснований допуска.
CREATE TABLE counterparties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bin            varchar(12) NOT NULL UNIQUE,
  name_full      varchar(500) NOT NULL,
  name_short     varchar(255) NOT NULL DEFAULT '',
  legal_address  varchar(500) NOT NULL DEFAULT '',
  actual_address varchar(500) NOT NULL DEFAULT '',
  bank_details   jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_person varchar(255) NOT NULL DEFAULT '',
  phone          varchar(32)  NOT NULL DEFAULT '',
  email          varchar(254) NOT NULL DEFAULT '',
  status         varchar(24)  NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'active', 'blocked')),
  verified_by    uuid,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_counterparties_name_trgm ON counterparties USING gin (name_full gin_trgm_ops);

-- Объекты Общества. Филиал заявки определяется объектом, а не вводится Заказчиком.
CREATE TABLE facilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inv_no       varchar(64) NOT NULL UNIQUE,
  name         varchar(255) NOT NULL,
  kind         varchar(24) NOT NULL
               CHECK (kind IN ('ams', 'rts', 'mast', 'tower', 'room', 'other')),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  address      varchar(500) NOT NULL DEFAULT '',
  latitude     numeric(9,6),
  longitude    numeric(9,6),
  height_m     numeric(8,2),
  structure    varchar(128) NOT NULL DEFAULT '',
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_facilities_branch ON facilities(branch_id);
CREATE INDEX idx_facilities_name_trgm ON facilities USING gin (name gin_trgm_ops);

-- Мастер-файл «Реестр АМС и загрузки». Регламент раздел 4, Приложение 8.
-- Поля несущей способности и электроснабжения в Приложении 8 частично помечены
-- [ЗАПОЛНИТЬ] — поэтому допускают NULL: система не подставляет своих значений.
CREATE TABLE facility_capacity (
  facility_id        uuid PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
  wind_zone          varchar(64),
  passport_load_kg   numeric(12,2),
  power_input_kw     numeric(10,2),
  free_area_m2       numeric(10,2),
  surveyed_at        date,
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facility_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id  uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  height_m     numeric(8,2) NOT NULL,
  capacity_kg  numeric(12,2),
  occupied_kg  numeric(12,2) NOT NULL DEFAULT 0,
  UNIQUE (facility_id, height_m)
);

-- Размещённое оборудование арендаторов (лист «Загрузка» Приложения 8).
CREATE TABLE facility_tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id     uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  tier_id         uuid REFERENCES facility_tiers(id) ON DELETE SET NULL,
  counterparty_id uuid REFERENCES counterparties(id),
  equipment       varchar(500) NOT NULL DEFAULT '',
  weight_kg       numeric(12,2),
  windage_m2      numeric(10,2),
  power_kw        numeric(10,2),
  tu_document_id  uuid,
  contract_id     uuid,
  mounted_at      date,
  dismounted_at   date
);
CREATE INDEX idx_tenants_facility ON facility_tenants(facility_id);

-- Версии реестра. Регламент пп. 13, 15, 16.5 — расчёт фиксируется с версией.
CREATE TABLE registry_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version       varchar(64) NOT NULL UNIQUE,
  published_at  timestamptz NOT NULL DEFAULT now(),
  published_by  uuid NOT NULL,
  note          text NOT NULL DEFAULT ''
);

-- ====================== ПОЛЬЗОВАТЕЛИ И ПРАВА ======================

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           varchar(254) NOT NULL UNIQUE,
  oidc_subject    varchar(255) UNIQUE,
  full_name       varchar(255) NOT NULL,
  position        varchar(255) NOT NULL DEFAULT '',
  department      varchar(128) NOT NULL DEFAULT '',
  branch_id       uuid REFERENCES branches(id),
  -- Заполнен для внешних пользователей: представитель Заказчика.
  counterparty_id uuid REFERENCES counterparties(id),
  phone           varchar(32) NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Роли соответствуют разграничению полномочий Регламента (пп. 12, 23, 41) и ТЗ раздел 4.
CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    varchar(24) NOT NULL
          CHECK (role IN ('admin','records','orpsd','branch','oko','assets','accounting','management','customer')),
  PRIMARY KEY (user_id, role)
);

ALTER TABLE branches
  ADD CONSTRAINT fk_branches_curator FOREIGN KEY (curator_id) REFERENCES users(id),
  ADD CONSTRAINT fk_branches_director FOREIGN KEY (director_id) REFERENCES users(id),
  ADD CONSTRAINT fk_branches_engineer FOREIGN KEY (chief_engineer_id) REFERENCES users(id);

-- ====================== КОНФИГУРАЦИЯ ПРОЦЕССА ======================
-- Регламент изменению не подлежит, но его следующая редакция не должна
-- требовать пересборки приложения: нормативы и правила хранятся как данные
-- со ссылкой на пункт и датой вступления в силу.

CREATE TABLE stage_definitions (
  code            varchar(32) PRIMARY KEY,
  sort_order      integer NOT NULL,
  name            varchar(255) NOT NULL,
  short_name      varchar(64) NOT NULL,
  sla_value       integer NOT NULL DEFAULT 0,
  sla_unit        varchar(16) NOT NULL
                  CHECK (sla_unit IN ('working','calendar','operational','same_day','none')),
  sla_text        varchar(128) NOT NULL,
  owner_party     varchar(24) NOT NULL
                  CHECK (owner_party IN ('records','orpsd','branch','customer','accounting','assets')),
  service_scope   varchar(8) CHECK (service_scope IN ('ТУ','ПСД','СМР')),
  customer_status varchar(24) NOT NULL,
  is_terminal     boolean NOT NULL DEFAULT false,
  regulation_ref  varchar(128) NOT NULL,
  hint            text NOT NULL DEFAULT '',
  effective_from  date NOT NULL DEFAULT current_date
);

CREATE TABLE stage_transitions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_code      varchar(32) NOT NULL REFERENCES stage_definitions(code),
  to_code        varchar(32) NOT NULL REFERENCES stage_definitions(code),
  title          varchar(255) NOT NULL,
  guard_key      varchar(64) NOT NULL,
  roles          varchar(24)[] NOT NULL,
  regulation_ref varchar(128) NOT NULL,
  UNIQUE (from_code, to_code)
);

CREATE TABLE automation_rules (
  id             integer PRIMARY KEY,
  trigger_key    varchar(64) NOT NULL,
  event_title    varchar(255) NOT NULL,
  action_key     varchar(64) NOT NULL,
  description    text NOT NULL,
  regulation_ref varchar(128) NOT NULL,
  timer_days     integer,
  enabled        boolean NOT NULL DEFAULT true,
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Производственный календарь РК: рабочие дни — основа всех сроков Регламента.
CREATE TABLE calendar_days (
  day     date PRIMARY KEY,
  kind    varchar(16) NOT NULL CHECK (kind IN ('holiday','working')),
  source  varchar(255) NOT NULL DEFAULT ''
);

CREATE TABLE settings (
  key            varchar(64) PRIMARY KEY,
  value          jsonb NOT NULL,
  description    text NOT NULL DEFAULT '',
  regulation_ref varchar(128),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Прейскурант. Регламент п. 18 — действующий Прейскурант Общества.
CREATE TABLE tariffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service        varchar(8) NOT NULL CHECK (service IN ('ТУ','ПСД')),
  name           varchar(255) NOT NULL,
  unit           varchar(64) NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  source         varchar(255) NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX idx_tariffs_service ON tariffs(service, effective_from);

-- ============================== ЗАЯВКИ ==============================

-- Счётчик номеров заявок по годам: ЗК-2026-0001.
-- Отдельная таблица, а не последовательность: нумерация начинается заново каждый год.
CREATE TABLE request_counters (
  year integer PRIMARY KEY,
  last integer NOT NULL DEFAULT 0
);

CREATE TABLE requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Внутренний номер CRM, присваивается при подаче (ТЗ №7, №9).
  number            varchar(32) NOT NULL UNIQUE,
  -- Реквизиты официальной регистрации делопроизводством (Регламент п. 6).
  incoming_number   varchar(64),
  incoming_date     date,
  counterparty_id   uuid NOT NULL REFERENCES counterparties(id),
  facility_id       uuid NOT NULL REFERENCES facilities(id),
  branch_id         uuid NOT NULL REFERENCES branches(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  assignee_id       uuid REFERENCES users(id),
  stage_code        varchar(32) NOT NULL REFERENCES stage_definitions(code),
  customer_status   varchar(24) NOT NULL DEFAULT 'draft',
  -- Оценка технической возможности (раздел 4).
  tv_status         varchar(16) NOT NULL DEFAULT 'pending'
                    CHECK (tv_status IN ('pending','confirmed','unavailable')),
  master_file_version varchar(64),
  -- Решение инженера о поверочном расчёте: числовой порог Регламентом не задан (п. 16.4).
  verification_calc varchar(16)
                    CHECK (verification_calc IN ('not_required','required','done')),
  -- Все позиции безвозмездны: ТУ на присоединение к сети ТРВ (п. 20).
  free_of_charge    boolean NOT NULL DEFAULT false,
  estimate_approved boolean NOT NULL DEFAULT false,
  order_number      varchar(64),
  result_delivered  boolean NOT NULL DEFAULT false,
  closing_confirmed boolean NOT NULL DEFAULT false,
  total_amount      numeric(14,2),
  registered_at     timestamptz,
  closed_at         timestamptz,
  closed_reason     text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Версия реестра обязательна, если ТВ подтверждена (п. 16.5).
  CONSTRAINT chk_tv_master_version
    CHECK (tv_status <> 'confirmed' OR master_file_version IS NOT NULL)
);
CREATE INDEX idx_requests_stage ON requests(stage_code) WHERE closed_at IS NULL;
CREATE INDEX idx_requests_branch ON requests(branch_id);
CREATE INDEX idx_requests_counterparty ON requests(counterparty_id);
CREATE INDEX idx_requests_created ON requests(created_at DESC);

-- Позиции заявки. Регламент п. 7.5 — перечень услуг; п. 21 — стоимость суммой позиций.
CREATE TABLE request_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  service         varchar(8) NOT NULL CHECK (service IN ('ТУ','ПСД','СМР')),
  placement       varchar(16) NOT NULL
                  CHECK (placement IN ('ams','room','network','cable','power')),
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  tariff_id       uuid REFERENCES tariffs(id),
  tariff_quantity integer CHECK (tariff_quantity IS NULL OR tariff_quantity > 0),
  amount          numeric(14,2),
  -- Основание для СМР: утверждённая ПСД либо договор (п. 53).
  basis_reference varchar(128),
  UNIQUE (request_id, service)
);

-- История этапов — основа аналитики узких мест.
-- Без неё «сколько заявка простояла на оценке ТВ» посчитать нельзя.
CREATE TABLE request_stages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  stage_code       varchar(32) NOT NULL REFERENCES stage_definitions(code),
  entered_at       timestamptz NOT NULL,
  left_at          timestamptz,
  due_at           date,
  sla_value        integer NOT NULL DEFAULT 0,
  sla_unit         varchar(16) NOT NULL,
  owner_party      varchar(24) NOT NULL,
  owner_user_id    uuid REFERENCES users(id),
  -- Продление: только с основанием (пп. 33, 45); для ПСД — не более 15 р.д.
  extended_by      integer NOT NULL DEFAULT 0,
  extension_reason text,
  escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 2),
  breached         boolean NOT NULL DEFAULT false,
  CONSTRAINT chk_extension_reason
    CHECK (extended_by = 0 OR extension_reason IS NOT NULL)
);
CREATE INDEX idx_request_stages_request ON request_stages(request_id, entered_at);
CREATE INDEX idx_request_stages_open ON request_stages(stage_code) WHERE left_at IS NULL;
CREATE INDEX idx_request_stages_due ON request_stages(due_at) WHERE left_at IS NULL;

-- Замечания к полям формы. ТЗ №11 — «конкретный перечень замечаний».
CREATE TABLE request_remarks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  field_key   varchar(128) NOT NULL,
  text        text NOT NULL CHECK (length(btrim(text)) > 0),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX idx_remarks_open ON request_remarks(request_id) WHERE resolved_at IS NULL;

-- Поручения. ТЗ №№ 7, 8 — карточка поручения со всеми сведениями заявки.
CREATE TABLE assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  kind         varchar(32) NOT NULL DEFAULT 'control',
  department   varchar(128) NOT NULL,
  assignee_id  uuid REFERENCES users(id),
  due_at       date,
  status       varchar(16) NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','done','cancelled')),
  reference    varchar(128),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

-- Служебные записки в филиал. Регламент п. 10 — ответ не позднее 3 рабочих дней.
CREATE TABLE memos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL REFERENCES branches(id),
  addressee_id uuid REFERENCES users(id),
  body         text NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  due_at       date NOT NULL,
  answered_at  timestamptz,
  answer       text
);
CREATE INDEX idx_memos_open ON memos(due_at) WHERE answered_at IS NULL;

-- Эскалации. Регламент п. 100.
CREATE TABLE escalations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  request_stage_id  uuid REFERENCES request_stages(id) ON DELETE SET NULL,
  level             smallint NOT NULL CHECK (level IN (1,2)),
  notified_user_id  uuid REFERENCES users(id),
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Договоры и оплата. Регламент пп. 83–89.
CREATE TABLE contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          varchar(64) NOT NULL UNIQUE,
  request_id      uuid REFERENCES requests(id) ON DELETE SET NULL,
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  subject         varchar(500) NOT NULL DEFAULT '',
  amount          numeric(14,2),
  signed_at       date,
  invoice_at      date,
  paid_at         date,
  valid_until     date,
  status          varchar(24) NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','signed','paid','executed','terminated')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_contracts_counterparty ON contracts(counterparty_id);

-- ====================== ДОКУМЕНТЫ И АРХИВ ======================

CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       uuid REFERENCES requests(id) ON DELETE SET NULL,
  kind             varchar(32) NOT NULL
                   CHECK (kind IN ('Акт приема-передачи','АВР','ТУ','ПСД (РП)','Договор','Распоряжение','КП','Приложение')),
  -- Форма акта: по умолчанию № 2В (Регламент п. 70).
  form_code        varchar(16) NOT NULL DEFAULT '2В',
  number           varchar(128) NOT NULL,
  facility_id      uuid REFERENCES facilities(id),
  owner_id         uuid REFERENCES counterparties(id),
  contractor_name  varchar(255) NOT NULL DEFAULT '',
  branch_id        uuid REFERENCES branches(id),
  doc_date         date NOT NULL,
  -- Срок действия: ТУ — 6 месяцев (п. 31), РП — 36 месяцев (п. 47).
  valid_until      date,
  -- Отпечаток ключевых реквизитов для защиты от дублей (требование архива №11).
  -- Для вложений не заполняется: их номер — имя файла, и дубли ловить бессмысленно.
  fingerprint      varchar(512),
  approved         boolean NOT NULL DEFAULT false,
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  current_version  integer NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_documents_fingerprint ON documents(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX idx_documents_request ON documents(request_id);
CREATE INDEX idx_documents_search ON documents USING gin (
  (coalesce(number,'') || ' ' || coalesce(contractor_name,'')) gin_trgm_ops
);
CREATE INDEX idx_documents_date ON documents(doc_date DESC);

CREATE TABLE file_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  storage_key  varchar(512) NOT NULL,
  file_name    varchar(255) NOT NULL,
  mime         varchar(128) NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  sha256       char(64) NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

-- ====================== ЖУРНАЛ И УВЕДОМЛЕНИЯ ======================

-- Универсален по сущности: модуль СУА подключится без изменения структуры.
CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users(id),
  actor_name  varchar(255) NOT NULL DEFAULT '',
  ip_address  inet,
  user_agent  varchar(512),
  action      varchar(255) NOT NULL,
  entity      varchar(64) NOT NULL,
  entity_id   varchar(64) NOT NULL,
  detail      text NOT NULL DEFAULT '',
  -- ТЗ раздел 4: попытка недоступного действия фиксируется как отказ.
  result      varchar(16) NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','error')),
  regulation_ref varchar(128)
);
CREATE INDEX idx_events_entity ON events(entity, entity_id, occurred_at DESC);
CREATE INDEX idx_events_actor ON events(actor_id, occurred_at DESC);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key    varchar(64) NOT NULL,
  channel      varchar(16) NOT NULL DEFAULT 'email' CHECK (channel IN ('email','in_app')),
  recipient    varchar(254) NOT NULL,
  subject      varchar(255) NOT NULL DEFAULT '',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       varchar(16) NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','failed')),
  attempts     integer NOT NULL DEFAULT 0,
  sent_at      timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_queue ON notifications(status, created_at) WHERE status <> 'sent';

COMMIT;
