export const BUY_CATEGORIES = ["Amazon", "楽天系", "Yahoo", "其他商城"] as const;
export const DAILY_CATEGORIES = ["餐饮", "超市日用", "交通", "通信", "水电燃气", "旅行", "服饰美容", "其他"] as const;

export type BuyCategory = (typeof BUY_CATEGORIES)[number];
export type DailyCategory = (typeof DAILY_CATEGORIES)[number];
export type Kind = "buy" | "daily";
export type Category = BuyCategory | DailyCategory;
export type Rule = { match: RegExp; kind: Kind; category: Category };

const CATEGORIES: Record<Kind, readonly string[]> = { buy: BUY_CATEGORIES, daily: DAILY_CATEGORIES };

const rule = (source: string, kind: Kind, category: Category): Rule => ({ match: new RegExp(source, "i"), kind, category });

// 按序匹配，第一条命中即止。这里只放通用关键词；带具体店名的规则放 data/categories.json（店名可能暴露住址，仓库是公开的）
export const DEFAULT_RULES: Rule[] = [
  // 交通卡充值也带「チャージ」，要先于下面的电子钱包充值
  rule("SUICA|PASMO", "daily", "交通"),
  // 电子钱包充值：之后用余额消费不走信用卡，不会重复计算。要先于「通信」，免得带运营商名的充值被当成话费
  rule("チャージ", "daily", "其他"),
  // 要先于「楽天系」
  rule("楽天モバイル|ドコモ|DOCOMO|AHAMO|POVO|ソフトバンク|SOFTBANK|ワイモバイル|\\bUQ\\b", "daily", "通信"),
  rule("アマゾン|AMAZON", "buy", "Amazon"),
  rule("楽天|ラクテン", "buy", "楽天系"),
  rule("YAHOO|ヤフー", "buy", "Yahoo"),
  rule("ガス|電力|電気|でんき|水道", "daily", "水电燃气"),
  rule("鉄道|\\bJR\\b|メトロ|タクシー|バス", "daily", "交通"),
  // 「利用国」是海外刷卡的标记
  rule("\\bANA\\b|\\bJAL\\b|KLOOK|TRIP\\.COM|BOOKING|EXPEDIA|ホテル|利用国", "daily", "旅行"),
  rule("バーガー|サブウェイ|なか卯|マクドナルド|すき家|吉野家|松屋|スターバックス|ドトール|酒場|食堂|ラーメン|モバイルオーダー", "daily", "餐饮"),
  rule("イオン|AEON|ピーコック|マツモトキヨシ|ウエルシア|セブン|ローソン|ファミリーマート|スーパー|ドラッグ", "daily", "超市日用"),
  rule("ユニクロ|\\bGU\\b|ZARA|HAIR|美容", "daily", "服饰美容"),
];

// 店名先 NFKC，统一全角/半角（ＡＭＡＺＯＮ→AMAZON、ﾗｸﾃﾝ→ラクテン）
export function classify(shop: string, rules: Rule[]): { kind: Kind; category: Category } {
  const name = shop.normalize("NFKC");
  const hit = rules.find((r) => r.match.test(name));

  return hit ? { kind: hit.kind, category: hit.category } : { kind: "daily", category: "其他" };
}

// 用户规则写错时报出第几条，免得报告悄悄分错类
export async function loadRules(path: string): Promise<Rule[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];

  const raw: unknown = await file.json().catch(() => {
    throw new Error(`${path}：不是合法的 JSON`);
  });
  if (!Array.isArray(raw)) throw new Error(`${path}：应为数组`);

  return raw.map((r: { match?: unknown; kind?: unknown; category?: unknown }, i) => {
    const where = `${path} 第 ${i + 1} 条`;

    if (typeof r?.match !== "string" || r.match === "") throw new Error(`${where}：缺少 match`);
    if (r.kind !== "buy" && r.kind !== "daily") throw new Error(`${where}：kind 只能是 buy 或 daily`);
    if (typeof r.category !== "string" || !CATEGORIES[r.kind].includes(r.category)) {
      throw new Error(`${where}：category 只能是 ${CATEGORIES[r.kind].join(" / ")}`);
    }

    try {
      return rule(r.match, r.kind, r.category as Category);
    } catch {
      throw new Error(`${where}：match 不是合法的正则`);
    }
  });
}
