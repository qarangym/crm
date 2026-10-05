-- Вход в систему без корпоративного провайдера (решение 29.09.2026).
--
-- Одна схема для сотрудников, Заказчиков и подрядчиков: почта и пароль, затем
-- одноразовый код на почту. Учётные записи и роли — только в этой базе, как
-- было решено заказчиком в наброске ТЗ v1.2. Корпоративный вход через обратный
-- прокси остаётся возможным (SSO_ENABLED), но не обязателен.
--
-- Пароль, код и ключ сессии в базе не хранятся — только их свёртки.

BEGIN;

ALTER TABLE users
  ADD COLUMN password_hash       text,
  ADD COLUMN password_changed_at timestamptz,
  ADD COLUMN email_verified_at   timestamptz,
  ADD COLUMN failed_logins       integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until        timestamptz,
  ADD COLUMN last_login_at       timestamptz,
  -- Самостоятельная регистрация представителя уже известной организации ждёт
  -- подтверждения ДИТ: иначе любой, кто знает БИН, увидел бы чужие заявки.
  ADD COLUMN registration_pending boolean NOT NULL DEFAULT false,
  -- Согласие на обработку персональных данных при самостоятельной регистрации (закон № 94-V).
  ADD COLUMN personal_data_consent_at timestamptz;

-- Сессия: в браузере — случайный ключ, здесь — его SHA-256.
CREATE TABLE auth_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   char(64) NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip_address   inet,
  user_agent   varchar(500) NOT NULL DEFAULT ''
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id) WHERE revoked_at IS NULL;

-- Одноразовые коды и ссылки: вход, подтверждение почты, сброс и первый пароль.
CREATE TABLE auth_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     varchar(16) NOT NULL CHECK (purpose IN ('login', 'verify', 'reset', 'invite')),
  secret_hash char(64) NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip_address  inet
);
CREATE INDEX idx_auth_challenges_user ON auth_challenges(user_id, purpose) WHERE used_at IS NULL;

COMMIT;
