/**
 * Встраивание фирменных изображений в дизайн-прототип.
 * Логотипы берутся из действующего прототипа QTR CRM (public/qtr-*.png),
 * чтобы дизайн не расходился с тем, что уже используется.
 *
 * Запуск: node design/emit-assets.mjs > design/assets.js
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uri = (name) =>
  'data:image/png;base64,' + readFileSync(join(here, 'assets', name)).toString('base64');

const assets = {
  mark: uri('qtr-mark.png'),   // фирменный знак QTR
  logo: uri('qtr-logo.png'),   // знак с надписью QAZTELERADIO
};

console.log('/* Сгенерировано: node design/emit-assets.mjs — фирменные изображения АО «Казтелерадио» */');
console.log(`window.QTR_ASSETS = ${JSON.stringify(assets)};`);
