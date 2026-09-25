// Ядро «Прихода по фото»: разбор справочника, сопоставление строк накладной
// с номенклатурой, пересчёт упаковок в базовые единицы, проверки сумм и
// выгрузка в бланк «Загрузка списка товаров из файла» Штрих-М: ТП 7.
//
// Файл подключается обычным <script> (страница открывается двойным щелчком,
// без сервера) и через require() в тестах, поэтому без ES-модулей.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrihodCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Колонки бланка — ровно в том порядке, в каком их сохраняет Штрих-М.
  // 1С ищет товар по приоритету: штрихкод → наименование номенклатуры →
  // артикул → код у поставщика → наименование у поставщика.
  const EXPORT_HEADER = [
    'Наименование товара у поставщика',
    'Количество',
    'Наименование единицы',
    'Приходная цена',
    'Приходная сумма',
    'Код товара у поставщика',
    'Штрих-код',
    'Артикул',
    'Наименование номенклатуры',
    'Номер заказа поставщику',
  ];

  // ---------- числа ----------

  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    const s = String(v).replace(/[\s ]/g, '').replace(',', '.');
    if (s === '' || s === '-') return NaN;
    return Number(s);
  }

  const round2 = (x) => Math.round(x * 100) / 100;
  const round3 = (x) => Math.round(x * 1000) / 1000;

  // ---------- нормализация названий ----------

  // Фонетический ключ: «Вискас» и «Whiskas», «Сникерс» и «Snickers» дают
  // похожие строки, поэтому кириллицу и латиницу можно сравнивать между собой.
  const CYR = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
    с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sh', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia',
  };

  function phonetic(word) {
    let s = '';
    for (const ch of word) s += CYR[ch] !== undefined ? CYR[ch] : ch;
    return s
      .replace(/wh|w/g, 'v')
      .replace(/ph/g, 'f')
      .replace(/ck|q/g, 'k')
      .replace(/c(?!h)/g, 'k')
      .replace(/x/g, 'ks')
      .replace(/y/g, 'i')
      .replace(/ee/g, 'i')
      .replace(/oo/g, 'u')
      .replace(/h/g, '')
      .replace(/(.)\1+/g, '$1');
  }

  // Слова, которые ничего не говорят о самом товаре: тара, единицы, служебные.
  const STOP = new Set([
    'шт', 'шту', 'уп', 'упак', 'упаковка', 'ящ', 'кор', 'бл', 'в', 'во', 'с',
    'со', 'и', 'на', 'для', 'по', 'из', 'от', 'пэт', 'pet', 'бут', 'бутылка',
    'ж', 'б', 'жб', 'п', 'пак', 'х', 'x', 'гр', 'г', 'кг', 'мл', 'л', 'тм',
    'new', 'акция', 'пл', 'ст', 'ф', 'т', 'мдж', 'м', 'д', 'euro', 'шт.',
  ]);

  // Количественные признаки: вес/объём (г ≈ мл, чтобы «930г» совпадало с
  // «0,93л») и жирность. Множители вида «28*75г» дают только 75 г.
  const MEASURE_RE = /(\d+(?:\.\d+)?)\s*(кг|гр|г|мл|л|%)(?![a-zа-я])/g;

  // Поставщики склеивают сокращения: «ВиногКлюкЕжевКлуб», «250грHORTEX»,
  // «Пауч10Х». Границы видно только по регистру, поэтому режем до toLowerCase.
  function splitGlued(s) {
    return String(s || '')
      .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
      .replace(/([a-zа-яё]{3,}|[A-ZА-ЯЁ]{4,})(\d)/g, '$1 $2')
      .replace(/%(?=\d)/g, '% ');
  }

  function normalizeText(s) {
    return splitGlued(s)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/[«»"'“”„`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Поставщики ставят в начало свои метки и коды: «СЗ. Кефир», «FB. Вишня»,
  // «ПС302 Сухарики», «791803 Сыр», «Ъ Maltesers». Код забираем отдельно.
  // Метка — только заглавными, иначе срезали бы «Кар.» (карамель) и «Нап.».
  function stripSupplierPrefix(raw) {
    let code = '';
    let t = String(raw || '').trim().replace(/^[ЪъЬ_\s]+/, '');
    let m = t.match(/^([A-Za-zА-Яа-яЁё]{1,4}\d{2,})\s+/);
    if (m) {
      code = m[1].toUpperCase();
      t = t.slice(m[0].length);
    } else if ((m = t.match(/^(\d{4,})\s+/))) {
      code = m[1];
      t = t.slice(m[0].length);
    }
    m = t.match(/^[A-ZА-ЯЁ]{1,3}\.\s*/);
    if (m && !/^\d/.test(t.slice(m[0].length))) t = t.slice(m[0].length);
    return { text: t, code };
  }

  function analyzeName(raw) {
    const stripped = stripSupplierPrefix(raw);
    const code = stripped.code;
    const text = normalizeText(stripped.text);
    const qty = [];
    const pct = [];
    let m;
    MEASURE_RE.lastIndex = 0;
    while ((m = MEASURE_RE.exec(text))) {
      const n = Number(m[1]);
      if (m[2] === '%') pct.push(n);
      else if (m[2] === 'кг' || m[2] === 'л') qty.push(n * 1000);
      else qty.push(n);
    }
    const words = text
      .replace(MEASURE_RE, ' ')
      .split(/[^a-zа-я0-9]+/)
      // «10шт», «240п», «12х» — это количество в упаковке, а не слово.
      .filter((w) => w && !STOP.has(w) && !/^\d+[a-zа-я]{0,3}$/.test(w) && w.length > 1);
    const tokens = words.map((w) => ({ w, p: phonetic(w) }));
    return { key: text, code, tokens, qty, pct };
  }

  // ---------- сходство ----------

  function trigrams(s) {
    const p = ` ${s} `;
    const out = new Set();
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
    return out;
  }

  function tokenSim(a, b) {
    if (a.w === b.w || a.p === b.p) return 1;
    const x = a.p;
    const y = b.p;
    const min = Math.min(x.length, y.length);
    let lcp = 0;
    while (lcp < min && x[lcp] === y[lcp]) lcp++;
    // Сокращение: «ябл» ↔ «яблоко», «говяд» ↔ «говядина».
    if (lcp >= 3 && lcp === min) return 0.9;
    // Разные окончания: «курицы» ↔ «курицей».
    if (lcp >= 4 && lcp >= 0.7 * min) return 0.85;
    if (min < 4) return 0;
    const ta = trigrams(x);
    const tb = trigrams(y);
    let common = 0;
    for (const t of ta) if (tb.has(t)) common++;
    const j = common / (ta.size + tb.size - common);
    return j >= 0.4 ? j : 0;
  }

  function coverage(from, to) {
    if (!from.length) return 0;
    let sum = 0;
    for (const a of from) {
      let best = 0;
      for (const b of to) {
        const s = tokenSim(a, b);
        if (s > best) best = s;
        if (best === 1) break;
      }
      sum += best;
    }
    return sum / from.length;
  }

  const near = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(a, b);

  function similarity(line, item, brands) {
    let s = 0.6 * coverage(line.tokens, item.tokens) + 0.4 * coverage(item.tokens, line.tokens);
    // Бренд в справочнике стоит первым словом. Если в строке накладной есть
    // известный бренд, а у кандидата другой — это другой товар, даже когда
    // совпали «Вишня без косточки 300г».
    const lineBrands = brands ? line.tokens.filter((t) => brands.has(t.p)) : [];
    if (lineBrands.length && item.tokens.length) {
      const first = item.tokens[0];
      const same = lineBrands.some((t) => tokenSim(t, first) >= 0.85);
      s = same ? s + 0.05 : s * 0.7;
    }
    if (line.qty.length && item.qty.length) {
      const hit = line.qty.some((a) => item.qty.some((b) => near(a, b, 0.03)));
      // Другой вес или объём — почти наверняка другой товар.
      s = hit ? s + 0.15 : s * 0.35;
    } else if (line.qty.length || item.qty.length) {
      s *= 0.9;
    }
    if (line.pct.length && item.pct.length) {
      const hit = line.pct.some((a) => item.pct.some((b) => Math.abs(a - b) < 0.05));
      s = hit ? s + 0.05 : s * 0.6;
    }
    // Без потолка в 1: иначе «Яблоко» и «Яблоко Персик» получат равный балл.
    return Math.max(0, s);
  }

  // ---------- справочник ----------

  // Принимает таблицу как массив строк (выгрузка «Вывести список» из 1С:
  // сверху шапка отчёта, потом строка заголовков). Колонки ищем по названию.
  function parseCatalogRows(aoa) {
    let hi = -1;
    let col = null;
    for (let i = 0; i < Math.min(aoa.length, 50); i++) {
      const row = (aoa[i] || []).map((c) => normalizeText(c));
      const name = row.findIndex((c) => c === 'номенклатура' || c === 'наименование');
      if (name >= 0) {
        hi = i;
        col = {
          name,
          barcode: row.findIndex((c) => c.startsWith('штрих')),
          unit: row.findIndex((c) => c.startsWith('единиц') || c.startsWith('ед.')),
          article: row.findIndex((c) => c.startsWith('артикул')),
        };
        break;
      }
    }
    if (hi < 0) throw new Error('Не нашёл строку заголовков с колонкой «Номенклатура»');
    const byName = new Map();
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i] || [];
      const name = String(r[col.name] ?? '').trim();
      if (!name) continue;
      let item = byName.get(name);
      if (!item) {
        item = { name, barcodes: [], article: '' };
        byName.set(name, item);
      }
      const bc = col.barcode >= 0 ? String(r[col.barcode] ?? '').trim() : '';
      const unit = col.unit >= 0 ? String(r[col.unit] ?? '').trim() : '';
      if (bc || unit) item.barcodes.push({ code: bc, unit });
      if (col.article >= 0 && r[col.article]) item.article = String(r[col.article]).trim();
    }
    return [...byName.values()];
  }

  // Базовая единица — та, у которой нет коэффициента в скобках («шт», «кг»),
  // а не «упак (12)». Штрихкод берём цифровой, по нему 1С ищет в первую очередь.
  function baseOf(item) {
    const plain = item.barcodes.filter((b) => !/\(/.test(b.unit));
    const pool = plain.length ? plain : item.barcodes;
    const good = pool.find((b) => /^\d{8,14}$/.test(b.code)) || pool[0] || { code: '', unit: '' };
    return { unit: good.unit.replace(/\s*\(.*$/, ''), barcode: /^\d{8,14}$/.test(good.code) ? good.code : '' };
  }

  function buildCatalog(items) {
    const list = items.map((it, id) => {
      const a = analyzeName(it.name);
      const base = baseOf(it);
      return { id, name: it.name, article: it.article || '', barcodes: it.barcodes, unit: base.unit, barcode: base.barcode, tokens: a.tokens, qty: a.qty, pct: a.pct, key: a.key };
    });
    const byBarcode = new Map();
    const byKey = new Map();
    const byName = new Map(list.map((it) => [it.name, it]));
    const index = new Map();
    // Брендом считаем слово, которое чаще открывает название, чем встречается
    // в середине: «hortex» — бренд, «молоко» — нет.
    const first = new Map();
    const other = new Map();
    for (const it of list) {
      it.tokens.forEach((t, i) => {
        const m = i === 0 ? first : other;
        m.set(t.p, (m.get(t.p) || 0) + 1);
      });
    }
    const brands = new Set();
    for (const [p, n] of first) if (n >= 2 && n > (other.get(p) || 0) && p.length >= 3) brands.add(p);
    for (const it of list) {
      for (const b of it.barcodes) if (b.code) byBarcode.set(b.code, it);
      byKey.set(it.key, it);
      for (const t of it.tokens) {
        const k = t.p.slice(0, 3);
        if (k.length < 3) continue;
        let bucket = index.get(k);
        if (!bucket) index.set(k, (bucket = []));
        bucket.push(it.id);
      }
    }
    return { list, byBarcode, byKey, byName, index, brands };
  }

  // ---------- память сопоставлений ----------
  // Ключ — поставщик плюс его код товара либо нормализованное название.
  // Значение — наименование номенклатуры и, если оператор задал, коэффициент.

  function memoryKeys(supplier, line, a) {
    const s = normalizeText(supplier);
    const keys = [];
    const code = String(line.code || a.code || '').trim().toUpperCase();
    if (code) keys.push(`${s}|c:${code}`);
    keys.push(`${s}|n:${a.key}`);
    return keys;
  }

  function remember(memory, supplier, line, itemName, extra) {
    const a = analyzeName(line.name);
    for (const k of memoryKeys(supplier, line, a)) memory[k] = Object.assign({ name: itemName }, extra || {});
  }

  // ---------- сопоставление ----------

  function matchLine(line, catalog, memory, supplier) {
    const a = analyzeName(line.name);
    for (const k of memoryKeys(supplier, line, a)) {
      const hit = memory && memory[k];
      if (!hit) continue;
      const item = catalog.byName.get(hit.name);
      if (item) return { status: 'memory', item, remembered: hit, candidates: [{ item, score: 1 }] };
    }
    // Наименование, которое предложил ИИ (колонка «Наименование номенклатуры»
    // во вставленной таблице), принимаем, только если оно есть в справочнике
    // дословно. Иначе 1С его не найдёт — значит, ИИ его придумал.
    let aiNameMissing = false;
    if (line.itemName) {
      const item = catalog.byName.get(String(line.itemName).trim());
      if (item) return { status: 'verified', item, candidates: [{ item, score: 1 }] };
      aiNameMissing = true;
    }
    if (line.barcode && catalog.byBarcode.has(String(line.barcode))) {
      const item = catalog.byBarcode.get(String(line.barcode));
      return { status: 'barcode', item, candidates: [{ item, score: 1 }] };
    }
    const exact = catalog.byKey.get(a.key);
    if (exact) return { status: 'exact', item: exact, candidates: [{ item: exact, score: 1 }], aiNameMissing };

    const ids = new Set();
    for (const t of a.tokens) {
      const bucket = catalog.index.get(t.p.slice(0, 3));
      if (bucket) for (const id of bucket) ids.add(id);
    }
    const scored = [];
    for (const id of ids) {
      const item = catalog.list[id];
      const score = similarity(a, item, catalog.brands);
      if (score >= 0.3) scored.push({ item, score });
    }
    scored.sort((x, y) => y.score - x.score);
    const candidates = scored.slice(0, 5);
    const top = candidates[0];
    if (!top) return { status: 'none', item: null, candidates, aiNameMissing };
    const gap = top.score - (candidates[1] ? candidates[1].score : 0);
    const status = top.score >= 0.85 && gap >= 0.08 ? 'likely' : top.score >= 0.45 ? 'suggest' : 'none';
    return { status, item: status === 'none' ? null : top.item, candidates, aiNameMissing };
  }

  // Ручной поиск по справочнику, когда оператор выбирает товар сам.
  function search(catalog, query, limit) {
    const m = matchLine({ name: query }, catalog, null, '');
    if (m.status === 'exact') return [m.item];
    const a = analyzeName(query);
    const ids = new Set();
    for (const t of a.tokens) {
      const bucket = catalog.index.get(t.p.slice(0, 3));
      if (bucket) for (const id of bucket) ids.add(id);
    }
    return [...ids]
      .map((id) => ({ item: catalog.list[id], score: similarity(a, catalog.list[id], null) }))
      .filter((x) => x.score > 0.2)
      .sort((x, y) => y.score - x.score)
      .slice(0, limit || 20)
      .map((x) => x.item);
  }

  // ---------- вставка таблицы ----------
  // Принимает то, что оператор копирует: JSON распознавания, таблицу из Excel
  // (табуляция) или Markdown-таблицу, которую выдаёт ИИ по промту в формате
  // бланка. Колонки узнаём по заголовку; без заголовка порядок такой:
  // наименование, количество, единица, цена, сумма, код поставщика.
  const PASTE_COLUMNS = [
    ['name', /^наименование товара у поставщика$|^товар$|^наименование$/],
    ['qty', /^количество$|^кол-?во$/],
    ['unit', /^наименование единицы$|^ед\.? ?изм\.?$|^единица$/],
    ['price', /^приходная цена$|^цена$/],
    ['sum', /^приходная сумма$|^сумма$/],
    ['code', /^код товара у поставщика$|^код$|^артикул поставщика$/],
    ['barcode', /^штрих-?код$/],
    ['article', /^артикул$/],
    ['itemName', /^наименование номенклатуры$/],
  ];

  function parsePasted(text) {
    const src = String(text || '').trim();
    if (!src) return { lines: [] };
    if (src[0] === '{' || src[0] === '[') {
      const data = JSON.parse(src);
      return Array.isArray(data) ? { lines: data } : data;
    }
    const rows = src
      .split(/\r?\n/)
      .map((r) => (r.includes('|') ? r.replace(/^\s*\||\|\s*$/g, '').split('|') : r.split('\t')).map((c) => c.trim()))
      .filter((r) => r.some((c) => c) && !r.every((c) => /^:?-{2,}:?$/.test(c) || c === ''));
    let map = null;
    const head = rows[0].map((c) => normalizeText(c));
    if (head.some((c) => PASTE_COLUMNS.some(([, re]) => re.test(c)))) {
      map = head.map((c) => (PASTE_COLUMNS.find(([, re]) => re.test(c)) || [null])[0]);
      rows.shift();
    } else {
      map = ['name', 'qty', 'unit', 'price', 'sum', 'code'];
    }
    const lines = rows.map((r, i) => {
      const line = { n: i + 1 };
      map.forEach((key, j) => {
        if (!key || r[j] == null || r[j] === '') return;
        line[key] = ['qty', 'price', 'sum'].includes(key) ? parseNumber(r[j]) : r[j];
      });
      return line;
    });
    return { lines: lines.filter((l) => l.name) };
  }

  // ---------- упаковки ----------

  const PACK_UNIT_RE = /^(уп|упак|ящ|кор|бл|блок|спайк)/i;

  // Сколько штук в упаковке, если это напечатано в накладной: колонка «Коэф»,
  // «упак (12 бут)» или пара цен «за Уп.» / «за Шт.».
  function packFactor(line) {
    const explicit = parseNumber(line.perPack);
    if (explicit > 0) return { factor: explicit, from: 'коэффициент в накладной' };
    const m = String(line.unit || '').match(/\((\d+)\s*[a-zа-я.]*\)/i);
    if (m) return { factor: Number(m[1]), from: 'единица «' + line.unit + '»' };
    const pp = parseNumber(line.pricePerPack);
    const pc = parseNumber(line.pricePerPiece);
    if (pp > 0 && pc > 0) {
      const r = pp / pc;
      if (Math.abs(r - Math.round(r)) < 0.02 * r) return { factor: Math.round(r), from: 'цена за уп. / цена за шт.' };
    }
    return { factor: 0, from: '' };
  }

  // Приводит строку к единице номенклатуры: количество в базовых единицах,
  // цена = сумма / количество (сумма из накладной не трогается).
  function toBase(line, item, remembered) {
    const warn = [];
    const sum = parseNumber(line.sum);
    const hasPlaces = line.packs != null || line.pieces != null;
    const pf = packFactor(line);
    let factor = pf.factor || (remembered && remembered.factor) || 0;
    const from = pf.factor ? pf.from : factor ? 'запомнено ранее' : '';
    let qty;
    if (hasPlaces) {
      const packs = parseNumber(line.packs) || 0;
      const pieces = parseNumber(line.pieces) || 0;
      if (packs > 0 && !factor) warn.push('Не знаю, сколько штук в упаковке — укажите коэффициент');
      qty = packs * (factor || 1) + pieces;
    } else {
      qty = parseNumber(line.qty);
      if (PACK_UNIT_RE.test(String(line.unit || '').trim())) {
        if (factor) qty *= factor;
        else warn.push('Количество в упаковках, а коэффициент не указан — проверьте');
      }
    }
    const unit = item ? item.unit : '';
    const lineUnit = String(line.unit || '').toLowerCase();
    if (item && unit === 'шт' && /^кг/.test(lineUnit)) warn.push('В накладной кг, в 1С товар штучный');
    if (item && unit === 'кг' && /^(шт|уп)/.test(lineUnit)) warn.push('В накладной штуки, в 1С товар весовой');
    const price = qty > 0 && sum >= 0 ? round2(sum / qty) : NaN;
    return { qty: round3(qty), price, sum: round2(sum), unit, factor, factorFrom: from, warn };
  }

  // ---------- проверки ----------

  function lineExpectedSum(line) {
    if (line.packs != null || line.pieces != null) {
      const packs = parseNumber(line.packs) || 0;
      const pieces = parseNumber(line.pieces) || 0;
      const pp = parseNumber(line.pricePerPack);
      const pc = parseNumber(line.pricePerPiece);
      return packs * (pp || 0) + pieces * (pc || 0);
    }
    return parseNumber(line.qty) * parseNumber(line.price);
  }

  // Ошибка распознавания почти всегда ломает арифметику: либо в строке
  // (кол-во × цена ≠ сумма), либо в документе (сумма строк ≠ «Итого»).
  function checkDocument(doc) {
    const lines = doc.lines.map((l) => {
      const sum = parseNumber(l.sum);
      const exp = lineExpectedSum(l);
      const errors = [];
      if (!Number.isFinite(sum)) errors.push('Нет суммы');
      else if (Number.isFinite(exp) && Math.abs(exp - sum) > Math.max(0.05, 0.002 * sum))
        errors.push(`Кол-во × цена = ${round2(exp)}, а сумма ${round2(sum)}`);
      if (l.note) errors.push('Пометка от руки: ' + l.note);
      if (l.uncertain) errors.push('Распознано неуверенно');
      return errors;
    });
    const total = parseNumber(doc.total);
    const linesSum = round2(doc.lines.reduce((s, l) => s + (parseNumber(l.sum) || 0), 0));
    const docErrors = [];
    if (Number.isFinite(total) && Math.abs(total - linesSum) > 0.05)
      docErrors.push(`Сумма строк ${linesSum} не равна «Итого» ${round2(total)} (разница ${round2(total - linesSum)})`);
    if (doc.notes) docErrors.push('Пометки на документе: ' + doc.notes);
    return { lines, linesSum, total, docErrors };
  }

  // ---------- выгрузка ----------

  // rows: [{ line, item, base }]. Строки без номенклатуры в файл не идут —
  // их сначала заводят в 1С (см. newItems).
  function exportRows(rows) {
    const out = [EXPORT_HEADER.slice()];
    const newItems = [];
    for (const r of rows) {
      if (!r.item) {
        newItems.push(r.line);
        continue;
      }
      out.push([
        String(r.line.name || ''),
        r.base.qty,
        r.base.unit,
        r.base.price,
        r.base.sum,
        String(r.line.code || analyzeName(r.line.name).code || ''),
        r.item.barcode,
        r.item.article,
        r.item.name,
        '',
      ]);
    }
    return { rows: out, newItems };
  }

  return {
    EXPORT_HEADER,
    parseNumber,
    phonetic,
    analyzeName,
    similarity,
    parseCatalogRows,
    buildCatalog,
    matchLine,
    search,
    parsePasted,
    remember,
    packFactor,
    toBase,
    checkDocument,
    exportRows,
  };
});
