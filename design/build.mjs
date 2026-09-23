/**
 * Сборка самодостаточного файла дизайн-прототипа.
 * Встраивает config.js (сгенерирован из src/process) и demo-data.js в index.html,
 * чтобы прототип открывался одним файлом — как старый прототип доски.
 *
 * Запуск: node design/build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');

let html = read('index.html');
for (const name of ['assets.js', 'config.js', 'demo-data.js']) {
  const tag = `<script src="${name}"></script>`;
  if (!html.includes(tag)) throw new Error(`В index.html нет подключения ${name}`);
  html = html.replace(tag, `<script>\n/* inline: ${name} */\n${read(name)}\n</script>`);
}

const out = join(here, 'prototype.html');
writeFileSync(out, html, 'utf8');
console.log(`Собрано: ${out} (${Math.round(html.length / 1024)} КБ)`);
