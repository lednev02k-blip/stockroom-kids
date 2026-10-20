export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function bad(message, details) { return new AppError(400, message, details); }
export function forbidden(message = 'Недостаточно прав для этой операции') { return new AppError(403, message); }
export function notFound(message = 'Объект не найден') { return new AppError(404, message); }
export function conflict(message, details) { return new AppError(409, message, details); }

/** Переводит сумму в основных единицах ("1 234,56", 1234.56) в копейки. */
export function toKop(value, field = 'сумма') {
  if (value === null || value === undefined || value === '') throw bad(`Не указана ${field}`);
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(n)) throw bad(`Некорректная ${field}`);
  if (n < 0) throw bad(`${field} не может быть отрицательной`);
  return Math.round(n * 100);
}

export function toFen(value, field = 'цена') {
  return toKop(value, field);
}

/** Курс хранится с точностью 4 знака: 12.3456 -> 123456. */
export function toRate(value, field = 'курс') {
  if (value === null || value === undefined || value === '') throw bad(`Не указан ${field}`);
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw bad(`Некорректный ${field}`);
  return Math.round(n * 10000);
}

export function toInt(value, field = 'количество') {
  const n = typeof value === 'string' ? Number(value.replace(/\s/g, '').replace(',', '.')) : Number(value);
  if (!Number.isFinite(n)) throw bad(`Некорректное ${field}`);
  if (!Number.isInteger(n)) throw bad(`${field} должно быть целым числом`);
  return n;
}

export function toQty(value, field = 'количество') {
  const n = toInt(value, field);
  if (n <= 0) throw bad(`${field} должно быть больше нуля`);
  return n;
}

export function parseDate(value, fallback = new Date()) {
  if (!value) return fallback.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw bad('Некорректная дата');
  return d.toISOString();
}

export function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function roundDiv(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round(numerator / denominator);
}

/**
 * Распределяет целую сумму (копейки) по весам методом наибольших остатков,
 * гарантируя, что сумма частей ровно равна исходной сумме.
 */
export function allocate(total, weights) {
  const sumW = weights.reduce((acc, w) => acc + w, 0);
  if (sumW <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sumW);
  const base = raw.map((v) => Math.floor(v));
  let rest = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && rest > 0; k += 1) {
    base[order[k].i] += 1;
    rest -= 1;
  }
  return base;
}

/** Распределение по методу value/qty с ручным режимом. */
export function allocateExpense(total, rows, method) {
  if (method === 'manual') {
    const manual = rows.map((r) => Number(r.manual_kop ?? 0));
    const sum = manual.reduce((a, b) => a + b, 0);
    if (sum !== total) {
      throw bad(`Сумма ручного распределения (${(sum / 100).toFixed(2)} ₽) не равна сумме расхода (${(total / 100).toFixed(2)} ₽)`);
    }
    return manual;
  }
  const weights = rows.map((r) => (method === 'qty' ? Number(r.qty || 0) : Number(r.value_kop ?? r.valueKop ?? 0)));
  return allocate(total, weights);
}

export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[";\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(columns, rows) {
  const header = columns.map((c) => csvEscape(c.title)).join(';');
  const body = rows.map((row) => columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(';'));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
}

export function rub(kop) {
  return (Number(kop || 0) / 100).toFixed(2);
}
