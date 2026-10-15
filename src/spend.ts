import { classify, type Category, type Kind, type Rule } from "./categories";

export type Spend = { card: string; date: string; month: string; shop: string; amount: number; kind: Kind; category: Category };

type Raw = { date: unknown; amount: unknown; shop: unknown };
type Row = Record<string, any>;

const text = (v: unknown) => String(v ?? "").trim();

// 各家原始字段名不同，金额一律取「利用金額」（购买金额，不含分期手续费）
const CARDS: Record<string, { fields: (d: Row) => Raw; skip?: (r: Raw) => boolean }> = {
  rakuten: {
    fields: (d) => ({ date: d["利用日"], amount: d["利用金額"], shop: d["利用店名・商品名"] }),
    // 画面上两行的明细在 CSV 里也是两行，第二行没有利用日（海外消费等的补充信息）
    skip: (r) => text(r.date) === "",
  },
  // 店名里可能有未加引号的逗号，列数不固定，金额从右往左数
  smbc: { fields: (d) => ({ date: d.cols?.[0], amount: d.cols?.[d.cols.length - 5], shop: d.cols?.[1] }) },
  amex: {
    fields: (d) => ({ date: d["ご利用日"], amount: d["金額"], shop: d["ご利用内容"] }),
    // 上期账单的还款，不是消费
    skip: (r) => text(r.shop) === "前回分口座振替金額",
  },
  aeon: { fields: (d) => ({ date: d.useDate, amount: d.useAmount, shop: d.useStoreName }) },
  paypay: { fields: (d) => ({ date: d["利用日/キャンセル日"], amount: d["利用金額"], shop: d["利用店名・商品名"] }) },
};

const DATE_FORMATS = [/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, /^(\d{4})(\d{2})(\d{2})$/];

function parseDate(raw: unknown): string | null {
  const m = DATE_FORMATS.map((re) => re.exec(text(raw))).find(Boolean);
  return m ? `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}` : null;
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const s = text(raw).normalize("NFKC").replace(/,/g, "");
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
}

export function toSpend(card: string, data: Row, rules: Rule[]): Spend | "skip" | "invalid" {
  const rule = CARDS[card];
  if (!rule) return "invalid";

  const raw = rule.fields(data);
  if (rule.skip?.(raw)) return "skip";

  const date = parseDate(raw.date);
  const amount = parseAmount(raw.amount);
  if (!date || amount === null) return "invalid";

  const shop = text(raw.shop);
  return { card, date, month: date.slice(0, 7), shop, amount, ...classify(shop, rules, card) };
}
