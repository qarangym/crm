/**
 * Печатные формы: HTML-страница с оформлением для печати и кнопкой «Печать /
 * сохранить в PDF». Браузер сохраняет PDF без дополнительных программ на
 * сервере. Поля, которые инженер дописывает от руки, помечены классом `edit`:
 * их можно заполнить прямо на странице перед печатью.
 */

import type { Ctx } from './http.ts';
import { RAW_RESPONSE } from './http.ts';

export const html = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** ДД.ММ.ГГГГ; пусто — линия для заполнения от руки. */
export const dmy = (v: string | null | undefined) => (v ? String(v).slice(0, 10).split('-').reverse().join('.') : '___________');

/** Метка времени в местном времени объектов (UTC+5). */
export const localStamp = (v: string | Date | null | undefined) => {
  if (!v) return '___________';
  const d = new Date(new Date(v).getTime() + 5 * 3_600_000).toISOString();
  return `${dmy(d)} ${d.slice(11, 16)}`;
};

export function printPage(title: string, body: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
body{font:13px/1.45 "Times New Roman",serif;color:#000;background:#fff;max-width:1050px;margin:24px auto;padding:0 24px}
h1{font-size:17px;text-align:center;margin:18px 0 6px}h2{font-size:14px;margin:18px 0 6px}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border:1px solid #000;padding:4px 6px;vertical-align:top;font-size:12px}
th{background:#f2f2f2}.r{text-align:right}.c{text-align:center}.muted{color:#444;font-size:11.5px}
.code{font:700 22px/1 monospace;letter-spacing:3px;border:2px solid #000;padding:8px 14px;display:inline-block}
.sign{display:flex;justify-content:space-between;gap:24px;margin-top:34px}.sign div{flex:1}.line{border-bottom:1px solid #000;height:22px}
.edit{background:#fffbe6;min-height:18px}.edit:focus{outline:2px solid #e0b000}
.bar{position:sticky;top:0;background:#fff;padding:8px 0;border-bottom:1px solid #ccc;margin-bottom:12px;display:flex;gap:12px;align-items:center;font:13px system-ui,sans-serif}
@media print{.bar{display:none}body{margin:0;max-width:none}.edit{background:none}}
</style></head><body><div class="bar"><button onclick="print()">Печать / сохранить в PDF</button>
<span class="muted">Жёлтые поля можно заполнить на странице перед печатью.</span></div>${body}
<script>document.querySelectorAll('.edit').forEach(function(el){el.setAttribute('contenteditable','true')})</script></body></html>`;
}

export function sendHtml(ctx: Ctx, page: string) {
  ctx.res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  });
  ctx.res.end(page);
  return RAW_RESPONSE;
}
