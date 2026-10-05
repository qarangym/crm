-- Отдельная роль базы для приложения (А8: защита журнала).
--
-- Схему создаёт и меняет владелец (PGUSER из .env) — миграциями. Приложение
-- работает под ролью qtr_app: читает и пишет данные, но не может изменить или
-- удалить записи журнала действий и не может менять схему. Даже при взломе
-- приложения следы в журнале остаются.
--
-- Выполнить один раз под владельцем базы, после первых миграций:
--   docker compose exec -T db psql -U "$PGUSER" -d "$PGDATABASE" -v app_password="'ПАРОЛЬ'" < deploy/db-app-role.sql
-- Пароль сгенерировать: openssl rand -hex 24

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qtr_app') THEN
    CREATE ROLE qtr_app LOGIN;
  END IF;
END $$;
ALTER ROLE qtr_app WITH LOGIN PASSWORD :app_password;

SELECT format('GRANT CONNECT ON DATABASE %I TO qtr_app', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO qtr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO qtr_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO qtr_app;
-- Журнал: только чтение и добавление.
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM qtr_app;
-- Таблица миграций — только владельцу.
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM qtr_app;
-- Таблицы и последовательности из будущих миграций получают те же права автоматически.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO qtr_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO qtr_app;
