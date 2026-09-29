-- Исполнитель у каждой карточки (прозрачность процесса, п. 102 Регламента).
--
-- У заявки два исполнителя:
--   requests.assignee_id       — ответственный сотрудник ОР ПСД: ведёт заявку от
--                                 регистрации до закрытия (колонка была с 001, но не
--                                 заполнялась);
--   request_stages.assignee_id — исполнитель текущего этапа: сотрудник канцелярии,
--                                 ОР ПСД, филиала или бухгалтерии. На этапах Заказчика
--                                 (оплата, оборудование, приёмка) — ответственный ОР ПСД,
--                                 который контролирует срок (пп. 56, 88, 93).
-- Назначение — src/db/executors.ts; незаполненных исполнителей подбирает
-- ежедневное задание (src/process/scheduler.ts, runExecutorCheck).

BEGIN;

ALTER TABLE request_stages ADD COLUMN assignee_id uuid REFERENCES users(id);

CREATE INDEX idx_request_stages_assignee ON request_stages(assignee_id) WHERE left_at IS NULL;
CREATE INDEX idx_requests_assignee ON requests(assignee_id) WHERE closed_at IS NULL;

COMMIT;
