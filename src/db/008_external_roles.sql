-- Кабинеты не пересекаются (решение 28.09.2026).
--
-- Система одна, но Заказчик ОР ПСД и подрядчик портала допусков — разные
-- учётные записи: Заказчик не подаёт заявку на допуск, подрядчик — заявку на
-- услуги ОР ПСД. Внешняя роль («Заказчик» или «Подрядчик») не совмещается ни с
-- какой другой ролью, в том числе с ролями сотрудников Общества. Одна
-- организация может иметь представителей в обоих кабинетах — отдельными
-- учётными записями.
--
-- Проверка дублирует серверную (users.ts): ограничение в базе держит правило и
-- при записи в обход API.

BEGIN;

CREATE FUNCTION check_external_role() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_roles r
     WHERE r.user_id = NEW.user_id AND r.role <> NEW.role
       AND (NEW.role IN ('customer','contractor') OR r.role IN ('customer','contractor'))
  ) THEN
    RAISE EXCEPTION 'Роль «Заказчик» или «Подрядчик» не совмещается с другими ролями в одной учётной записи'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_roles_external
  BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION check_external_role();

COMMIT;
