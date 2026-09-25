// node --test tools/prihod/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./core.js');

const fixture = (name) => JSON.parse(JSON.stringify(require(`./fixtures/${name}.json`)));

// Выгрузка «Вывести список» из Штрих-М: шапка отчёта, потом заголовки.
// Названия взяты из настоящего справочника магазина.
const CATALOG_AOA = [
  [null, null, null, null, null, null],
  ['Параметры:', null, null, 'Тип объекта: Справочник', null, null],
  [null, null, null, 'Имя объекта: Штрих коды', null, null],
  ['Штрих код', null, 'Единица', null, 'Номенклатура', null],
  ['4600000000011', null, 'шт', null, 'Агуша Морс Виноград Клюква Ежевика Клубника 200мл', null],
  ['4600000000028', null, 'шт', null, 'Агуша Морс Виноград Ежевика Черная Смородина 200мл', null],
  ['4600000000035', null, 'шт', null, 'Агуша я Сам Пюре Яблоко Банан Печенье 90г', null],
  ['4600000000042', null, 'шт', null, 'Агуша я Сам Пюре Яблоко 90г', null],
  ['14600000000049', null, 'упак (10)', null, 'Агуша я Сам Пюре Яблоко 90г', null],
  ['4600000000059', null, 'шт', null, 'Hortex Малина Замороженная 200г', null],
  ['4600000000066', null, 'шт', null, 'Hortex Черника 250г', null],
  ['4600000000073', null, 'шт', null, 'Hortex Ягодное Ассорти 400г', null],
  ['4600000000080', null, 'шт', null, 'Мираторг Вишня без Косточки Витамин 300г', null],
  ['4600000000097', null, 'шт', null, 'Whiskas Влажный Корм для Кошек Желе с Курицей 75г', null],
  ['4600000000103', null, 'шт', null, 'Snickers Супер 80г', null],
  ['4600000000110', null, 'шт', null, 'Milka Leo Go Шоколад 48г', null],
  ['4600000000127', null, 'шт', null, 'Простоквашино Творог 2% 200г', null],
  ['4600000000134', null, 'шт', null, 'Простоквашино Творог 5% 200г', null],
  ['4600000000141', null, 'кг', null, 'Колбаса Полукопченая Мусульманская в/с', null],
];

const catalog = () => C.buildCatalog(C.parseCatalogRows(CATALOG_AOA));

test('числа из накладной: пробелы тысяч и запятая', () => {
  assert.equal(C.parseNumber('1 234,56'), 1234.56);
  assert.equal(C.parseNumber('2 190,32'), 2190.32);
  assert.equal(C.parseNumber(12), 12);
  assert.ok(Number.isNaN(C.parseNumber('-')));
});

test('название: склейки, метки поставщика, вес и жирность', () => {
  const a = C.analyzeName('Морс Агуша ВиногКлюкЕжевКлуб 200мл10шт');
  assert.deepEqual(a.tokens.map((t) => t.w), ['морс', 'агуша', 'виног', 'клюк', 'ежев', 'клуб']);
  assert.deepEqual(a.qty, [200]);

  const b = C.analyzeName('СЗ. Молоко пастеризованное Сел Зел 3,2% ПЭТ бут. 0,93л 6шт (ШТ);');
  assert.equal(b.tokens[0].w, 'молоко');
  assert.deepEqual(b.qty, [930]);
  assert.deepEqual(b.pct, [3.2]);

  const c = C.analyzeName('РВК756 Кар.леденц.с фрук.начинкой 1кг/6шт');
  assert.equal(c.code, 'РВК756');

  // «28*75г» — это 28 пакетиков по 75 г, а не 2875 г.
  assert.deepEqual(C.analyzeName('Вискас желе говяд/ягн 28*75г (240п)').qty, [75]);
});

test('кириллица и латиница сравниваются по звучанию', () => {
  assert.equal(C.phonetic('сникерс'), C.phonetic('snickers'));
  assert.equal(C.phonetic('милка'), C.phonetic('milka'));
  assert.equal(C.phonetic('хортекс'), C.phonetic('hortex'));
});

test('справочник из выгрузки 1С: заголовки ищутся, единицы группируются', () => {
  const items = C.parseCatalogRows(CATALOG_AOA);
  const pure = items.find((i) => i.name === 'Агуша я Сам Пюре Яблоко 90г');
  assert.equal(pure.barcodes.length, 2);
  const cat = catalog();
  const it = cat.list.find((i) => i.name === 'Агуша я Сам Пюре Яблоко 90г');
  // Базовая единица — «шт», а не «упак (10)»; штрихкод — от штуки.
  assert.equal(it.unit, 'шт');
  assert.equal(it.barcode, '4600000000042');
  assert.throws(() => C.parseCatalogRows([['a', 'b']]), /Номенклатура/);
});

test('сопоставление: сокращения поставщика находят товар', () => {
  const cat = catalog();
  const m = C.matchLine({ name: 'Морс Агуша ВиногЕжевикаЧернСм 200мл10шт' }, cat, {}, 'Агуша');
  assert.equal(m.status, 'likely');
  assert.equal(m.item.name, 'Агуша Морс Виноград Ежевика Черная Смородина 200мл');

  const w = C.matchLine({ name: 'Вискас желе с курицей 28*75г (240п)' }, cat, {}, 'Марс');
  assert.equal(w.candidates[0].item.name, 'Whiskas Влажный Корм для Кошек Желе с Курицей 75г');
});

test('сопоставление: другой бренд не выдаётся за уверенное совпадение', () => {
  const m = C.matchLine({ name: 'Вишня без косточки 300 гр HORTEX 1/10' }, catalog(), {}, 'Поставщик заморозки');
  assert.notEqual(m.status, 'likely');
});

test('сопоставление: другой вес — другой товар', () => {
  const m = C.matchLine({ name: 'Простоквашино Творог 2% 200гр. (1*6)' }, catalog(), {}, 'Данон');
  assert.equal(m.item.name, 'Простоквашино Творог 2% 200г');
  assert.ok(m.candidates[1].score < 0.8, 'творог 5% не должен быть рядом по баллам');
});

test('сопоставление: штрихкод и память важнее названия', () => {
  const cat = catalog();
  const byBc = C.matchLine({ name: 'что-то невнятное', barcode: '4600000000110' }, cat, {}, 'X');
  assert.equal(byBc.status, 'barcode');
  assert.equal(byBc.item.name, 'Milka Leo Go Шоколад 48г');

  const memory = {};
  const line = { code: '340063507', name: 'Пюре Фр Агуша Ябл 160г Пауч10Х' };
  C.remember(memory, 'Агуша', line, 'Агуша я Сам Пюре Яблоко 90г', { factor: 10 });
  const again = C.matchLine({ code: '340063507', name: 'другое написание' }, cat, memory, 'Агуша');
  assert.equal(again.status, 'memory');
  assert.equal(again.remembered.factor, 10);
  // У другого поставщика тот же код ничего не значит.
  assert.notEqual(C.matchLine({ code: '340063507', name: 'другое написание' }, cat, memory, 'Марс').status, 'memory');
});

test('упаковки: вложение из единицы, пары цен и колонки «Коэф»', () => {
  assert.equal(C.packFactor({ unit: 'упак (12 бут)' }).factor, 12);
  assert.equal(C.packFactor({ unit: 'упак (10 шт)' }).factor, 10);
  assert.equal(C.packFactor({ pricePerPack: 1524.84, pricePerPiece: 63.53 }).factor, 24);
  assert.equal(C.packFactor({ perPack: 6, unit: 'упак' }).factor, 6);
  assert.equal(C.packFactor({ unit: 'шт' }).factor, 0);
});

test('пересчёт в штуки: сумма из накладной неизменна, цена = сумма / кол-во', () => {
  const cat = catalog();
  const item = cat.list.find((i) => i.name === 'Агуша я Сам Пюре Яблоко 90г');
  const [, , , , l5] = fixture('agusha').lines;
  const b = C.toBase(l5, item);
  assert.deepEqual([b.qty, b.unit, b.price, b.sum], [10, 'шт', 42.87, 428.69]);

  // Марс: 0 уп. и 8 шт. по 184,17.
  const mars = fixture('milka').lines;
  assert.equal(C.toBase(mars[3], item).qty, 8);
  // 1 уп. по 1 821,60 при цене штуки 50,60 → 36 шт.
  const m1 = C.toBase(mars[0], item);
  assert.deepEqual([m1.qty, m1.price], [36, 50.6]);

  // «упак» без вложения — предупреждение, а не молчаливая ошибка в 6 раз.
  const unknown = C.toBase({ qty: 1, unit: 'упак', sum: 500 }, item);
  assert.equal(unknown.qty, 1);
  assert.match(unknown.warn.join(), /коэффициент/);
  // Вложение, запомненное раньше, подставляется.
  assert.equal(C.toBase({ qty: 1, unit: 'упак', sum: 500 }, item, { factor: 5 }).qty, 5);
});

test('весовой товар остаётся в кг, несовпадение единиц подсвечивается', () => {
  const cat = catalog();
  const kolbasa = cat.list.find((i) => i.unit === 'кг');
  const b = C.toBase({ qty: '6,88', unit: 'кг', sum: '4 072,96' }, kolbasa);
  assert.deepEqual([b.qty, b.unit, b.price], [6.88, 'кг', 592]);
  const shtuchny = cat.list.find((i) => i.name === 'Hortex Черника 250г');
  assert.match(C.toBase({ qty: 4, unit: 'кг', sum: 100 }, shtuchny).warn.join(), /штучный/);
});

test('проверки: настоящие накладные сходятся, ошибка распознавания ловится', () => {
  for (const f of ['agusha', 'hortex', 'milka', 'prostokvashino']) {
    const doc = fixture(f);
    const r = C.checkDocument(doc);
    assert.equal(r.linesSum, r.total, f);
  }
  assert.match(C.checkDocument(fixture('hortex')).docErrors.join(), /Пометки/);

  const doc = fixture('agusha');
  doc.lines[1].sum = 485.19; // 4 и 8 перепутаны при распознавании
  const r = C.checkDocument(doc);
  assert.match(r.lines[1].join(), /Кол-во × цена/);
  assert.match(r.docErrors.join(), /не равна «Итого»/);
});

test('выгрузка: колонки бланка Штрих-М, новые товары отдельно', () => {
  assert.deepEqual(C.EXPORT_HEADER, [
    'Наименование товара у поставщика', 'Количество', 'Наименование единицы',
    'Приходная цена', 'Приходная сумма', 'Код товара у поставщика', 'Штрих-код',
    'Артикул', 'Наименование номенклатуры', 'Номер заказа поставщику',
  ]);
  const cat = catalog();
  const item = cat.list.find((i) => i.name === 'Агуша я Сам Пюре Яблоко 90г');
  const line = fixture('agusha').lines[4];
  const { rows, newItems } = C.exportRows([
    { line, item, base: C.toBase(line, item) },
    { line: { name: 'Креветки VICI 50/70' }, item: null },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], [line.name, 10, 'шт', 42.87, 428.69, '340033822', '4600000000042', '', 'Агуша я Сам Пюре Яблоко 90г', '']);
  assert.equal(newItems.length, 1);
});

test('вставка: Markdown-таблица от ИИ в формате бланка', () => {
  const md = [
    '| Наименование товара у поставщика | Количество | Наименование единицы | Приходная цена | Приходная сумма | Код товара у поставщика | Штрих-код | Артикул | Наименование номенклатуры |',
    '|---|---|---|---|---|---|---|---|---|',
    '| Эвервесс Кола 1л ПЭТ 12Х | 24 | шт | 95,11 | 2 282,75 | B16 | | | Evervess Напиток Газированный Кола 1л |',
    '| Пюре "Агуша" Я Сам!Яблоко 90гр.дой-пак 10шт. | 10 | шт | 42,87 | 428,69 | 340033822 | | | Агуша я Сам Пюре Яблоко 90г |',
  ].join('\n');
  const { lines } = C.parsePasted(md);
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].qty, lines[0].sum, lines[0].code, lines[0].itemName], [24, 2282.75, 'B16', 'Evervess Напиток Газированный Кола 1л']);

  const cat = catalog();
  // Имя из справочника — принято дословно.
  assert.equal(C.matchLine(lines[1], cat, {}, 'Агуша').status, 'verified');
  // Имя, которого в справочнике нет, — придумано: 1С такой товар не найдёт.
  assert.equal(C.matchLine(lines[0], cat, {}, 'X').aiNameMissing, true);
});

test('вставка: строки из Excel через табуляцию и JSON распознавания', () => {
  const tsv = 'Малина HORTEX 200гр 1/6\t5\tшт\t256,00\t1 280,00\nКлюква 250гр HORTEX 1/6\t5\tшт\t203,00\t1 015,00';
  const { lines } = C.parsePasted(tsv);
  assert.deepEqual(lines.map((l) => l.sum), [1280, 1015]);
  const doc = C.parsePasted(JSON.stringify(fixture('hortex')));
  assert.equal(doc.lines.length, 11);
  assert.equal(doc.total, 13536);
});

test('ручной поиск по справочнику', () => {
  const found = C.search(catalog(), 'творог простоквашино 5%', 5);
  assert.equal(found[0].name, 'Простоквашино Творог 5% 200г');
});
