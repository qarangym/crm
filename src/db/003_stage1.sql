-- Этап 1 плана завершения: договоры по услугам, поручения, служебные записки,
-- эскалация по п. 100, виды АВР.
--
-- Источники: Регламент ОРПСД-Р-01 ред. 2; Упрощённое ТЗ ОР ПСД; План_завершения.md, A1–A6.

BEGIN;

-- ============================ ДОГОВОРЫ (A1) ============================
-- На каждую услугу заключается свой договор (пп. 21, 32, 48). Договор на СМР —
-- только после утверждения сметы (п. 53) и со своей 100 % оплатой (п. 59).
ALTER TABLE contracts
  ADD COLUMN service varchar(8) CHECK (service IN ('ТУ','ПСД','СМР')),
  ADD COLUMN created_by uuid REFERENCES users(id),
  -- Возврат денежных средств при расторжении (п. 97).
  ADD COLUMN refund_amount numeric(14,2) CHECK (refund_amount IS NULL OR refund_amount >= 0),
  ADD COLUMN terminated_at date;

-- Договоры, заведённые до этой миграции, относим к первой услуге заявки.
UPDATE contracts c
   SET service = (SELECT min(s.service) FROM request_services s WHERE s.request_id = c.request_id)
 WHERE c.service IS NULL AND c.request_id IS NOT NULL;

-- Один действующий договор на услугу заявки.
CREATE UNIQUE INDEX idx_contracts_request_service
  ON contracts(request_id, service) WHERE request_id IS NOT NULL AND status <> 'terminated';
CREATE INDEX idx_contracts_request ON contracts(request_id);

-- Оплата не может быть раньше подписания договора.
ALTER TABLE contracts
  ADD CONSTRAINT chk_contract_paid_after_signed
  CHECK (paid_at IS NULL OR signed_at IS NULL OR paid_at >= signed_at);

-- ============================ АВР (A6) ============================
-- Технический АВР филиала (п. 66) и АВР расчётов с контрагентами (п. 91) —
-- разные документы. Форма АВР зависит от услуги: Р-1 для ТУ и ПСД, № 2В для СМР (п. 70).
ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('Акт приема-передачи','Технический АВР','АВР','ТУ','ПСД (РП)','Договор',
                  'Распоряжение','КП','Приложение'));
ALTER TABLE documents ALTER COLUMN form_code SET DEFAULT '';

-- Дата направления АВР и ЭСФ Заказчику: от неё считаются 10 рабочих дней (пп. 92, 94).
ALTER TABLE requests ADD COLUMN avr_sent_at date;

-- Мотивированные замечания Заказчика к АВР (п. 94) — отдельно от замечаний к форме заявки.
ALTER TABLE requests ADD COLUMN avr_objection text;

-- ============================ ПОРУЧЕНИЯ (A2) ============================
-- ТЗ №7, №8: поручение создаётся при регистрации и несёт все сведения заявки.
ALTER TABLE assignments
  ADD COLUMN payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN accepted_at timestamptz,
  ADD COLUMN accepted_by uuid REFERENCES users(id),
  ADD COLUMN closed_by uuid REFERENCES users(id),
  ADD COLUMN close_note text;
CREATE UNIQUE INDEX idx_assignments_request_kind ON assignments(request_id, kind);
CREATE INDEX idx_assignments_open ON assignments(status, created_at) WHERE status IN ('open','in_progress');

-- ======================== СЛУЖЕБНЫЕ ЗАПИСКИ (A3) ========================
-- П. 10: запрос в филиал, ответ не позднее 3 рабочих дней.
ALTER TABLE memos
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN answered_by uuid REFERENCES users(id),
  ADD COLUMN subject varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN escalation_level smallint NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 2);
ALTER TABLE memos ADD CONSTRAINT chk_memo_answer
  CHECK (answered_at IS NULL OR length(btrim(coalesce(answer, ''))) > 0);

-- ============================ ЭСКАЛАЦИЯ (A4) ============================
-- П. 100.2: второй уровень — курирующему члену Правления (адресат задаётся по филиалу, E8).
ALTER TABLE branches ADD COLUMN board_curator_id uuid REFERENCES users(id);

-- Эскалация может относиться к этапу или к служебной записке.
ALTER TABLE escalations
  ADD COLUMN memo_id uuid REFERENCES memos(id) ON DELETE CASCADE,
  ADD COLUMN copy_user_id uuid REFERENCES users(id);

COMMIT;
