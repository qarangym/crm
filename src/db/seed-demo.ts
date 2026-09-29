/**
 * Наполнение базы демонстрационными данными.
 *
 * Нужно, чтобы после первого развёртывания было что открыть: филиалы, объекты,
 * позиции прейскуранта и контрагенты. Организации и объекты вымышлены,
 * персональные данные не используются.
 *
 * Запуск: npm run seed:demo
 * На рабочем контуре не запускать — справочники заполняются реальными данными.
 */

import { createDb, databaseUrl } from './client.ts';

const db = createDb(databaseUrl());

const BRANCHES = [
  ['ALA', 'Алматинский филиал', 'Алматинская область'],
  ['AKM', 'Акмолинский филиал', 'Акмолинская область'],
  ['KAR', 'Карагандинский филиал', 'Карагандинская область'],
  ['PAV', 'Павлодарский филиал', 'Павлодарская область'],
  ['VKO', 'Восточно-Казахстанский филиал', 'область Абай'],
  ['MAN', 'Мангистауский филиал', 'Мангистауская область'],
];

const FACILITIES: [string, string, string, string, number, number | null, number][] = [
  // инв. №, наименование, тип, код филиала, высота, паспортная нагрузка, ввод мощности
  ['1187', 'АМС Караганда РТС-12', 'ams', 'KAR', 72, 9500, 15],
  ['1233', 'АМС Темиртау РТС-7', 'mast', 'KAR', 60, 6200, 10],
  ['1710', 'АМС Экибастуз РТС-2', 'ams', 'PAV', 80, 11000, 20],
  ['2050', 'АМС Семей РТС-1', 'ams', 'VKO', 96, 14000, 25],
  ['1560', 'АМС Кокшетау РТС-3', 'ams', 'AKM', 72, 9500, 15],
  // Паспортная нагрузка не заполнена — в Приложении 8 такие позиции помечены [ЗАПОЛНИТЬ].
  ['402', 'РТС Кок-Тобе', 'rts', 'ALA', 372, null, 120],
  ['3011', 'АМС Актау РТС-4', 'ams', 'MAN', 64, 8000, 12],
];

const TIERS: Record<string, [number, number | null, number][]> = {
  '1187': [[66, 2800, 1800], [58, 3200, 2340], [48, 3500, 1600]],
  '1233': [[54, 2600, 2600], [44, 3600, 3210]],
  '1710': [[74, 3000, 1200], [64, 4000, 1900], [52, 4000, 1200]],
  '2050': [[90, 3500, 2400], [80, 4500, 3200], [66, 6000, 3300]],
  '1560': [[66, 2800, 2700], [56, 3200, 2900], [46, 3500, 1500]],
  '402':  [[300, 15000, 12000], [250, 20000, 16800], [200, null, 19000]],
  '3011': [[58, 2500, 1200], [48, 3000, 2000]],
};

// Услуга, наименование, единица, стоимость, пункт, сценарий размещения, подставлять по умолчанию (С3).
const TARIFFS: [string, string, string, number, string, string | null, boolean][] = [
  ['ТУ', 'ТУ на размещение оборудования на АМС', 'услуга', 420000, 'Прейскурант, п. 3.1', 'ams', true],
  ['ТУ', 'ТУ на размещение в помещении', 'услуга', 310000, 'Прейскурант, п. 3.2', 'room', true],
  ['ТУ', 'ТУ на прокладку кабеля', 'трасса', 265000, 'Прейскурант, п. 3.4', 'cable', true],
  ['ТУ', 'ТУ на подключение электроснабжения', 'точка', 380000, 'Прейскурант, п. 3.5', 'power', true],
  ['ПСД', 'Разработка рабочего проекта (одностадийный РП)', 'проект', 980000, 'Прейскурант, п. 4.2', null, true],
  ['ПСД', 'Сметная документация к РП', 'комплект', 210000, 'Прейскурант, п. 4.3', null, false],
];

const COUNTERPARTIES: [string, string, string][] = [
  ['501400004114', 'ТОО «Спектр Телеком»', 'info@spektr.kz'],
  ['501400005251', 'АО «Транстелеком-Демо»', 'info@transtelecom.demo'],
  ['501400006398', 'ТОО «Алатау Медиа»', 'info@alatau.demo'],
  ['501400007435', 'ТОО «Каспий Сигнал»', 'info@kaspiy.demo'],
];

try {
  await db.tx(async (t) => {
    for (const [code, name, region] of BRANCHES) {
      await t.query(
        `INSERT INTO branches (code, name, region) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, region = excluded.region`,
        [code, name, region]);
    }

    for (const [inv, name, kind, branch, height, load, power] of FACILITIES) {
      const row = await t.one<{ id: string }>(
        `INSERT INTO facilities (inv_no, name, kind, branch_id, height_m)
         VALUES ($1,$2,$3,(SELECT id FROM branches WHERE code = $4),$5)
         ON CONFLICT (inv_no) DO UPDATE SET name = excluded.name, height_m = excluded.height_m
         RETURNING id`,
        [inv, name, kind, branch, height]);
      await t.query(
        `INSERT INTO facility_capacity (facility_id, passport_load_kg, power_input_kw)
         VALUES ($1,$2,$3)
         ON CONFLICT (facility_id) DO UPDATE SET
           passport_load_kg = excluded.passport_load_kg, power_input_kw = excluded.power_input_kw`,
        [row!.id, load, power]);

      for (const [h, cap, occupied] of TIERS[inv] ?? []) {
        await t.query(
          `INSERT INTO facility_tiers (facility_id, height_m, capacity_kg, occupied_kg)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (facility_id, height_m) DO UPDATE SET
             capacity_kg = excluded.capacity_kg, occupied_kg = excluded.occupied_kg`,
          [row!.id, h, cap, occupied]);
      }
    }

    for (const [service, name, unit, amount, source, placement, isDefault] of TARIFFS) {
      const exists = await t.one<{ id: string }>(`SELECT id FROM tariffs WHERE service = $1 AND name = $2`, [service, name]);
      if (!exists) {
        await t.query(
          `INSERT INTO tariffs (service, name, unit, amount, source, effective_from, placement, is_default)
           VALUES ($1,$2,$3,$4,$5, date_trunc('year', now())::date, $6, $7)`,
          [service, name, unit, amount, source, placement, isDefault]);
      } else {
        await t.query(`UPDATE tariffs SET placement = coalesce(placement, $2), is_default = is_default OR $3 WHERE id = $1`,
          [exists.id, placement, isDefault]);
      }
    }

    for (const [bin, name, email] of COUNTERPARTIES) {
      await t.query(
        `INSERT INTO counterparties (bin, name_full, name_short, status, email)
         VALUES ($1,$2,$2,'active',$3)
         ON CONFLICT (bin) DO UPDATE SET name_full = excluded.name_full, email = excluded.email`,
        [bin, name, email]);
    }

    // Версия реестра создаётся только при наличии пользователя: Регламент п. 13
    // требует фиксировать автора изменения, поэтому поле обязательно. На пустой
    // базе версию публикует техучёт после первого входа.
    const author = await t.one<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
    if (author) {
      await t.query(
        `INSERT INTO registry_versions (version, published_by, note)
         SELECT to_char(now(), 'YYYY-MM-DD'), $1, 'Демонстрационное наполнение'
         WHERE NOT EXISTS (SELECT 1 FROM registry_versions)`, [author.id]);
    } else {
      console.log('Версия реестра не создана: в базе нет пользователей. ' +
        'Опубликует СП ЦА, ответственное за технический учёт активов, после первого входа (п. 13).');
    }
  });

  console.log(`Справочники заполнены: филиалов ${BRANCHES.length}, объектов ${FACILITIES.length}, ` +
    `позиций прейскуранта ${TARIFFS.length}, контрагентов ${COUNTERPARTIES.length}.`);
} catch (error) {
  console.error('Ошибка наполнения:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
