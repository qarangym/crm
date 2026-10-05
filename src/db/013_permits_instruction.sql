-- Портал допусков по Инструкции о допуске сторонних организаций на объекты
-- АО «Казтелерадио» (temp/must/Инструкция_о_допуске.md) и общие доработки
-- промышленной эксплуатации: замещение, руководители подразделений,
-- уведомления в системе, роль «Аудитор», неизменяемый журнал.

BEGIN;

-- ============================== РОЛИ ==============================
-- auditor — СБ и комплаенс: чтение журнала и выгрузка, без права действий.
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('admin','records','orpsd','branch','oko','assets','accounting','management','customer',
                  'contractor','permits','auditor'));

-- Руководитель подразделения: распределяет задачи, видит нагрузку, получает
-- письма о просрочках и о том, что исполнителя назначить некого.
ALTER TABLE users ADD COLUMN is_head boolean NOT NULL DEFAULT false;

-- Замещение на время отпуска, командировки, болезни: новые назначения и письма
-- идут замещающему, задачи отсутствующего видны у него («за кого»).
CREATE TABLE user_absences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  substitute_id uuid NOT NULL REFERENCES users(id),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  reason        varchar(64) NOT NULL DEFAULT 'отпуск',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_absence_period CHECK (date_to >= date_from),
  CONSTRAINT chk_absence_self CHECK (substitute_id <> user_id)
);
CREATE INDEX idx_user_absences_user ON user_absences(user_id, date_from, date_to);

-- Уведомления в системе («колокольчик»): копия каждого письма сотруднику или
-- представителю организации, у которого есть учётная запись.
CREATE TABLE inbox (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key  varchar(64) NOT NULL,
  subject    varchar(255) NOT NULL,
  body       text NOT NULL DEFAULT '',
  link       varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX idx_inbox_user ON inbox(user_id, created_at DESC);
CREATE INDEX idx_inbox_unread ON inbox(user_id) WHERE read_at IS NULL;

-- Журнал действий неизменяем: исправить или удалить запись нельзя и в обход
-- приложения. Очистка тестовой базы — только с явным флагом сеанса.
CREATE FUNCTION events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('qtr.audit_purge', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Журнал действий изменять и удалять нельзя' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER trg_events_immutable BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_immutable();

-- ===================== ОТВЕТСТВЕННЫЕ ЛИЦА ФИЛИАЛА =====================
-- Инженер по эксплуатации сети ТРВ либо работник, определённый приказом
-- руководителя филиала (п. 20 Инструкции): инструктаж, проверка СИЗ, контроль
-- работ на объекте. Задаётся по филиалу и, где нужно, по отдельному объекту.
ALTER TABLE branches ADD COLUMN site_officer_id uuid REFERENCES users(id);
ALTER TABLE facilities ADD COLUMN site_officer_id uuid REFERENCES users(id);

-- ====================== РЕЕСТР ДОГОВОРОВ АРЕНДЫ ======================
-- Основание допуска для ТО и ремонта (п. 7); срок допуска не превышает срок
-- договора аренды (пп. 13, 14). Ведёт СУА: загрузка из таблицы, ручной ввод,
-- пополнение при ручном подтверждении основания.
CREATE TABLE lease_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          varchar(128) NOT NULL,
  contract_date   date,
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  valid_from      date,
  valid_until     date NOT NULL,
  status          varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','terminated')),
  note            text NOT NULL DEFAULT '',
  source          varchar(16) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','confirmation')),
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (counterparty_id, number)
);
CREATE TABLE lease_contract_facilities (
  lease_id    uuid NOT NULL REFERENCES lease_contracts(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL REFERENCES facilities(id),
  PRIMARY KEY (lease_id, facility_id)
);

-- ========================= РАБОТНИКИ: ПРИЛОЖЕНИЕ 1 =========================
-- Сведения о специалистах по форме Приложения 1 Инструкции. ИИН — у граждан
-- Казахстана; у иностранцев — паспорт (п. 16).
ALTER TABLE contractor_workers ALTER COLUMN iin DROP NOT NULL;
ALTER TABLE contractor_workers DROP CONSTRAINT contractor_workers_counterparty_id_iin_key;
CREATE UNIQUE INDEX uq_contractor_workers_iin ON contractor_workers(counterparty_id, iin) WHERE iin IS NOT NULL;
ALTER TABLE contractor_workers
  ADD COLUMN full_name_latin  varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN birth_date       date,
  ADD COLUMN birth_place      varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN citizenship      char(2) NOT NULL DEFAULT 'KZ',
  ADD COLUMN id_doc_number    varchar(64) NOT NULL DEFAULT '',
  ADD COLUMN id_doc_issued_at date,
  ADD COLUMN id_doc_issued_by varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN address          varchar(500) NOT NULL DEFAULT '',
  ADD COLUMN employer         varchar(500) NOT NULL DEFAULT '';
CREATE UNIQUE INDEX uq_contractor_workers_passport ON contractor_workers(counterparty_id, citizenship, id_doc_number)
  WHERE iin IS NULL AND id_doc_number <> '';
ALTER TABLE contractor_workers ADD CONSTRAINT chk_worker_identity
  CHECK (iin IS NOT NULL OR (citizenship <> 'KZ' AND id_doc_number <> ''));

-- Удостоверения, а для иностранцев — копии паспорта и визы (п. 16).
ALTER TABLE worker_documents ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'qualification'
  CHECK (kind IN ('qualification','passport','visa'));

ALTER TABLE access_request_workers ALTER COLUMN iin DROP NOT NULL;
ALTER TABLE access_request_workers ADD COLUMN details jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ========================= ЗАЯВКА ПО ИНСТРУКЦИИ =========================
ALTER TABLE access_requests DROP CONSTRAINT access_requests_status_check;
ALTER TABLE access_requests DROP CONSTRAINT access_requests_basis_type_check;
ALTER TABLE access_requests DROP CONSTRAINT chk_access_approved;
ALTER TABLE access_requests DROP CONSTRAINT chk_access_submitted;
ALTER TABLE access_requests DROP CONSTRAINT chk_access_reviewed;

ALTER TABLE access_requests
  -- Цель и характер работ (пп. 2, 7–12, 13): от неё зависят основание и маршрут.
  ADD COLUMN work_type varchar(16)
    CHECK (work_type IN ('maintenance','replacement','emergency','survey','installation','supervision')),
  -- Работы на АМС: ТО и ремонт — по согласованию с руководителем филиала (п. 8),
  -- монтаж и демонтаж — только работниками Общества (п. 11).
  ADD COLUMN on_ams boolean NOT NULL DEFAULT false,
  -- Время работ в течение дня и работа в выходные: ночью и в выходные — только
  -- аварийно-восстановительные работы по согласованию с филиалом (п. 14).
  ADD COLUMN work_hours_from time NOT NULL DEFAULT '09:00',
  ADD COLUMN work_hours_to   time NOT NULL DEFAULT '18:00',
  ADD COLUMN weekend_work    boolean NOT NULL DEFAULT false,
  -- Владелец оборудования (арендатор), если заявку подаёт его подрядная организация (п. 13).
  ADD COLUMN owner_bin   varchar(12) NOT NULL DEFAULT '',
  ADD COLUMN owner_name  varchar(500) NOT NULL DEFAULT '',
  -- Дата основания (номер и дата ТУ — п. 13) и срок его действия, указанный заявителем.
  ADD COLUMN basis_date        date,
  ADD COLUMN basis_valid_until date,
  ADD COLUMN basis_lease_id    uuid REFERENCES lease_contracts(id) ON DELETE SET NULL,
  -- Официальный письменный запрос, подписанный уполномоченным лицом, со списком
  -- работников по Приложению 1, заверенным печатью (п. 13).
  ADD COLUMN letter_number      varchar(64) NOT NULL DEFAULT '',
  ADD COLUMN letter_date        date,
  ADD COLUMN signatory_name     varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN signatory_position varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN letter_file_id     uuid REFERENCES permit_files(id),
  -- Контрольный срок СУА — 14 рабочих дней (п. 14).
  ADD COLUMN review_due_at date,
  -- Согласование с руководством филиала (пп. 8, 14, 18).
  ADD COLUMN branch_approval varchar(16) NOT NULL DEFAULT 'not_required'
    CHECK (branch_approval IN ('not_required','pending','approved','rejected')),
  ADD COLUMN branch_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN branch_approver_id uuid REFERENCES users(id),
  ADD COLUMN branch_due_at      date,
  ADD COLUMN branch_decided_by  uuid REFERENCES users(id),
  ADD COLUMN branch_decided_at  timestamptz,
  ADD COLUMN branch_channel     varchar(16) CHECK (branch_channel IN ('system','oral','letter')),
  ADD COLUMN branch_note        text,
  -- Аварийный порядок (п. 18): допуск в день запроса по устному согласованию,
  -- оформленный запрос и письменное разрешение — в течение 2 календарных дней.
  ADD COLUMN provisional        boolean NOT NULL DEFAULT false,
  ADD COLUMN followup_due_at    timestamptz,
  ADD COLUMN followup_done_at   timestamptz,
  ADD COLUMN followup_done_by   uuid REFERENCES users(id),
  -- Электронный допуск: код проверки на объекте и ответственное лицо филиала.
  ADD COLUMN permit_code        varchar(12) UNIQUE,
  ADD COLUMN permit_issued_at   timestamptz,
  ADD COLUMN site_officer_id    uuid REFERENCES users(id),
  -- Отзыв допуска, отзыв заявки, завершение работ.
  ADD COLUMN revoke_reason      text,
  ADD COLUMN revoked_at         timestamptz,
  ADD COLUMN revoked_by         uuid REFERENCES users(id),
  ADD COLUMN closed_at          timestamptz,
  ADD COLUMN closed_by          uuid REFERENCES users(id),
  ADD COLUMN close_note         text,
  -- Продление (п. 19): новый запрос по прошлому допуску.
  ADD COLUMN extends_request_id uuid REFERENCES access_requests(id) ON DELETE SET NULL;

-- Заявки, отправленные до этой миграции, — техническое обслуживание и ремонт.
UPDATE access_requests SET work_type = 'maintenance' WHERE work_type IS NULL AND status <> 'draft';
UPDATE access_requests SET permit_issued_at = reviewed_at WHERE status = 'approved';
UPDATE access_requests SET permit_code = upper(substr(md5(id::text), 1, 8)) WHERE status = 'approved' AND permit_code IS NULL;

ALTER TABLE access_requests ADD CONSTRAINT access_requests_status_check
  CHECK (status IN ('draft','pending_review','approved','rejected','withdrawn','revoked','closed'));
ALTER TABLE access_requests ADD CONSTRAINT access_requests_basis_type_check
  CHECK (basis_type IN ('lease','tu','smr_contract','transfer_act','order'));
ALTER TABLE access_requests ADD CONSTRAINT chk_access_submitted CHECK (status = 'draft' OR (
  facility_id IS NOT NULL AND work_type IS NOT NULL AND period_start IS NOT NULL
  AND period_end IS NOT NULL AND submitted_at IS NOT NULL AND pd_consent_at IS NOT NULL));
ALTER TABLE access_requests ADD CONSTRAINT chk_access_approved
  CHECK (status NOT IN ('approved','closed') OR (permit_issued_at IS NOT NULL AND permit_code IS NOT NULL));
ALTER TABLE access_requests ADD CONSTRAINT chk_access_reviewed
  CHECK (status <> 'rejected' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));
ALTER TABLE access_requests ADD CONSTRAINT chk_access_revoked
  CHECK (status <> 'revoked' OR length(btrim(coalesce(revoke_reason, ''))) > 0);
ALTER TABLE access_requests ADD CONSTRAINT chk_access_hours CHECK (work_hours_to <> work_hours_from);

CREATE INDEX idx_access_requests_branch_approval ON access_requests(branch_approver_id) WHERE branch_approval = 'pending';
CREATE INDEX idx_access_requests_active ON access_requests(branch_id, period_start, period_end) WHERE status = 'approved';

ALTER TABLE permit_files DROP CONSTRAINT permit_files_kind_check;
ALTER TABLE permit_files ADD CONSTRAINT permit_files_kind_check
  CHECK (kind IN ('qualification','basis','pass','letter','passport','visa'));

-- ======================= ПРОВЕРКА НА ОБЪЕКТЕ =======================
-- Ответственное лицо филиала в день работ: инструктаж с записью в журнале,
-- спецодежда, спецобувь, СИЗ, удостоверения (пп. 21–23). Без СИЗ работы
-- запрещены — работник не допускается. Транспорт — отметка о въезде.
CREATE TABLE site_admissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES access_requests(id) ON DELETE CASCADE,
  work_date       date NOT NULL,
  worker_id       uuid REFERENCES contractor_workers(id),
  vehicle_id      uuid REFERENCES contractor_vehicles(id),
  briefing_done   boolean NOT NULL DEFAULT false,
  briefing_record varchar(64) NOT NULL DEFAULT '',
  clothing_ok     boolean NOT NULL DEFAULT false,
  footwear_ok     boolean NOT NULL DEFAULT false,
  ppe_ok          boolean NOT NULL DEFAULT false,
  documents_ok    boolean NOT NULL DEFAULT false,
  admitted        boolean NOT NULL,
  refusal_reason  text,
  arrived_at      timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  checked_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_admission_subject CHECK ((worker_id IS NULL) <> (vehicle_id IS NULL)),
  -- Работник допускается только после инструктажа, с полным комплектом СИЗ и проверенными документами.
  CONSTRAINT chk_admission_worker CHECK (worker_id IS NULL OR NOT admitted OR
    (briefing_done AND briefing_record <> '' AND clothing_ok AND footwear_ok AND ppe_ok AND documents_ok)),
  CONSTRAINT chk_admission_refusal CHECK (admitted OR length(btrim(coalesce(refusal_reason, ''))) > 0)
);
CREATE UNIQUE INDEX uq_site_admission_worker ON site_admissions(request_id, work_date, worker_id) WHERE worker_id IS NOT NULL;
CREATE UNIQUE INDEX uq_site_admission_vehicle ON site_admissions(request_id, work_date, vehicle_id) WHERE vehicle_id IS NOT NULL;

-- =========================== НАСТРОЙКИ ===========================
INSERT INTO settings (key, value, description) VALUES
  ('permits.basis_mode', '{"lease":"soft","tu":"soft","smr_contract":"soft","transfer_act":"soft","order":"soft"}'::jsonb,
   'Портал допусков: режим проверки основания по типам — soft (предупреждение) или strict (блокировка)'),
  -- Срок безвизового пребывания граждан СНГ, дней (п. 16). Проверьте по действующим соглашениям.
  ('permits.cis_stay_days', '{"RU":90,"BY":90,"AM":90,"KG":90,"UZ":30,"TJ":30,"AZ":30,"MD":30}'::jsonb,
   'Портал допусков: срок безвизового пребывания граждан СНГ в Казахстане, дней'),
  ('permits.rules', '{"reviewDays":14,"branchDays":3,"maxCrew":5,"nightFrom":"22:00","nightTo":"06:00","followupDays":2}'::jsonb,
   'Портал допусков: срок рассмотрения СУА (рабочих дней), срок согласования филиала, предел численности, ночное время, аварийный порядок')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || settings.value;


-- ====================== ТЕКСТЫ ПИСЕМ (А5) ======================
-- ОР ПСД и СУА правят тексты сами: шаблон темы и текста с подстановками
-- {{тема}}, {{текст}} (стандартный текст системы) и полями письма ({{номер}} и т. п.).
-- Нет шаблона — уходит стандартный текст.
CREATE TABLE mail_templates (
  event_key  varchar(64) PRIMARY KEY,
  subject    varchar(255) NOT NULL DEFAULT '{{тема}}',
  body       text NOT NULL DEFAULT '{{текст}}',
  enabled    boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
