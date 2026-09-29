-- Автоматическая регистрация заявки; канцелярия подтверждает.
--
-- При подаче система сама присваивает регистрационный номер (номер заявки) и
-- дату. Канцелярия (СП ЦА, ответственное за документооборот, п. 6) проверяет
-- заявку и подтверждает регистрацию — этим действием заявка уходит в ОР ПСД и
-- в филиал. Номер и дату канцелярия может исправить, если по её правилам нужен
-- номер из своего журнала.

BEGIN;

ALTER TABLE requests
  ADD COLUMN registration_confirmed_at timestamptz,
  ADD COLUMN registration_confirmed_by uuid REFERENCES users(id);

-- Поданные заявки без реквизитов регистрации получают их так же, как новые.
UPDATE requests
   SET incoming_number = number,
       incoming_date = coalesce(registered_at, created_at)::date
 WHERE stage_code <> 'draft' AND incoming_number IS NULL AND number IS NOT NULL;

-- Заявки, уже ушедшие дальше регистрации, считаются подтверждёнными датой регистрации.
UPDATE requests
   SET registration_confirmed_at = coalesce(registered_at, created_at)
 WHERE stage_code NOT IN ('draft', 'registered') AND registration_confirmed_at IS NULL;

COMMIT;
