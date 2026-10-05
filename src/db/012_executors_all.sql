-- Исполнитель у каждого рабочего объекта (п. 102): не только у заявки, но и у
-- документа на визу, запроса изменения реестра и заявки на допуск.
-- Служебная записка уже имеет адресата (memos.addressee_id) — теперь он заполняется
-- конкретным сотрудником филиала.

BEGIN;

ALTER TABLE documents ADD COLUMN approver_id uuid REFERENCES users(id);
ALTER TABLE registry_change_requests ADD COLUMN assignee_id uuid REFERENCES users(id);
ALTER TABLE access_requests ADD COLUMN assignee_id uuid REFERENCES users(id);

CREATE INDEX idx_documents_approver ON documents(approver_id) WHERE NOT approved;
CREATE INDEX idx_registry_changes_assignee ON registry_change_requests(assignee_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_access_requests_assignee ON access_requests(assignee_id) WHERE status = 'pending_review';
CREATE INDEX idx_memos_addressee ON memos(addressee_id) WHERE answered_at IS NULL;

COMMIT;
