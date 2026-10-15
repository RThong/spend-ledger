// 全部是编造的假数据，格式照调研里的社区样本
import { expect, test } from "bun:test";
import iconv from "iconv-lite";
import { cards } from "./cards";
import { monthOf } from "./cards/util";
import { hasStatement, openDb, saveStatement } from "./db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, DEFAULT_RULES, loadRules } from "./categories";
import { buildReport, renderHtml, summarize } from "./report";
import { toSpend, type Spend } from "./spend";
import { decode, parseCsv, shape } from "./text";

const sjis = (s: string) => new Uint8Array(iconv.encode(s, "cp932"));
const utf8 = (s: string) => new TextEncoder().encode(s);

test("parseCsv 处理引号内逗号、换行、转义引号和 CRLF", () => {
  expect(parseCsv('a,"b,1","c\nd","e""f"\r\n\r\n1,2,3,4')).toEqual([
    ["a", "b,1", "c\nd", 'e"f'],
    ["1", "2", "3", "4"],
  ]);
});

test("decode 自动识别 UTF-8(BOM) 和 Shift_JIS", () => {
  expect(decode(utf8("﻿利用日"))).toBe("利用日");
  expect(decode(sjis("ご利用日,金額"))).toBe("ご利用日,金額");
});

test("shape 脱敏但保留格式", () => {
  expect(shape("2024/12/24 ＡＢＣ商店 -1,234 USD")).toBe("9999/99/99 ＊＊＊＊＊ -9,999 aaa");
});

test("monthOf 跨年", () => {
  expect(monthOf(-1, new Date(2026, 0, 15))).toBe("2025-12");
});

test("saveStatement：同 hash 跳过，hash 变了整月替换，同账单内重复行不合并", () => {
  const db = openDb(":memory:");
  const meta = { card: "rakuten", account: "4071", month: "2024-12", sha256: "a", rawPath: "x" };
  const dup = { 利用日: "2024/12/01", 利用金額: "500" };
  const count = () => db.query("SELECT count(*) AS n FROM transactions").get() as { n: number };

  expect(saveStatement(db, meta, [dup, dup])).toBe("new");
  expect(count().n).toBe(2);
  expect(saveStatement(db, meta, [dup, dup])).toBe("unchanged");
  expect(saveStatement(db, { ...meta, sha256: "b" }, [dup])).toBe("updated");
  expect(count().n).toBe(1);
  expect(saveStatement(db, { ...meta, sha256: "b" }, [dup, dup], true)).toBe("updated");
  expect(count().n).toBe(2);
  expect(hasStatement(db, "rakuten", "4071", "2024-12")).toBe(true);
  expect(hasStatement(db, "rakuten", "9999", "2024-12")).toBe(false);
});

test("楽天：UTF-8 带表头，续行原样保留", () => {
  const csv = '"利用日","利用店名・商品名","利用者","支払方法","利用金額"\n"2024/12/24","テスト商店","本人","1回払い","5643"\n"","現地利用額 9.68 USD","","",""\n';

  expect(cards.rakuten!.parse(utf8(csv))).toEqual([
    { 利用日: "2024/12/24", "利用店名・商品名": "テスト商店", 利用者: "本人", 支払方法: "1回払い", 利用金額: "5643" },
    { 利用日: "", "利用店名・商品名": "現地利用額 9.68 USD", 利用者: "", 支払方法: "", 利用金額: "" },
  ]);
});

test("Amex：Shift_JIS，金额千分位在引号内", () => {
  const csv = 'ご利用日,データ処理日,ご利用内容,カード会員様名,会員番号 #,金額\n2023/07/03,2023/07/04,"TEST, INC.",TARO TEST,-12345,"-1,431"\n';

  expect(cards.amex!.parse(sjis(csv))).toEqual([
    { ご利用日: "2023/07/03", データ処理日: "2023/07/04", ご利用内容: "TEST, INC.", カード会員様名: "TARO TEST", "会員番号 #": "-12345", 金額: "-1,431" },
  ]);
});

test("三井住友：无表头，按卡分段，丢掉合计行", () => {
  const csv = [
    "試験　太郎　様,4980-00**-****-****,三井住友カード（ＮＬ）",
    "2022/08/18,テストマート／ｉＤ,340,１,１,340,ﾃｽﾄ",
    "2022/8/9,店名,含逗号,1000,１,１,1000,",
    ",,,,,1340",
    "試験　太郎　様,4980-00**-****-****,ｉＤ",
    "2022/08/20,別の店,200,１,１,200,",
  ].join("\r\n");
  const rows = cards.smbc!.parse(sjis(csv)) as { section: string[]; cols: string[] }[];

  expect(rows.map((r) => [r.section[2], r.cols[0]])).toEqual([
    ["三井住友カード（ＮＬ）", "2022/08/18"],
    ["三井住友カード（ＮＬ）", "2022/8/9"],
    ["ｉＤ", "2022/08/20"],
  ]);
});

test("AEON：递归找出含 useDate 的明细数组", () => {
  const json = { billingYearMonth: "202409", data: { useDetailList: [{ useDate: "20240801", useAmount: 100 }], total: 100 } };

  expect(cards.aeon!.parse(utf8(JSON.stringify(json)))).toEqual([{ useDate: "20240801", useAmount: 100 }]);
  expect(cards.aeon!.parse(sjis("ご利用明細,試験 太郎\n\nご利用日,ご利用金額\n240801,100\n合計,100\n"))).toEqual([{ ご利用日: "240801", ご利用金額: "100" }]);
});

test("toSpend：各卡取消费日、金额、店名并分类", () => {
  expect(toSpend("rakuten", { 利用日: "2026/09/03", 利用金額: "5643", "利用店名・商品名": "テスト電機　楽天市場店" }, DEFAULT_RULES)).toEqual({
    card: "rakuten",
    date: "2026-09-03",
    month: "2026-09",
    shop: "テスト電機　楽天市場店",
    amount: 5643,
    kind: "buy",
    category: "楽天系",
  });
  // 店名含未加引号的逗号，列数变多，金额要从右往左数
  expect(toSpend("smbc", { section: [], cols: ["2026/8/9", "店名", "含逗号", "1000", "１", "１", "1000", ""] }, DEFAULT_RULES)).toMatchObject({ date: "2026-08-09", amount: 1000, shop: "店名" });
  expect(toSpend("amex", { ご利用日: "2026/04/08", 金額: "-1,431", ご利用内容: "アマゾン　シーオージェーピー　　" }, DEFAULT_RULES)).toMatchObject({ amount: -1431, kind: "buy", category: "Amazon", shop: "アマゾン　シーオージェーピー" });
  expect(toSpend("aeon", { useDate: "20260102", useAmount: 980, useStoreName: "テストストア" }, DEFAULT_RULES)).toMatchObject({ date: "2026-01-02", month: "2026-01", amount: 980, kind: "daily", category: "其他" });
  expect(toSpend("paypay", { "利用日/キャンセル日": "2026/4/1", 利用金額: "320", "利用店名・商品名": "テスト商店" }, DEFAULT_RULES)).toMatchObject({ date: "2026-04-01", amount: 320 });
});

test("toSpend：跳过不是消费的行", () => {
  expect(toSpend("rakuten", { 利用日: "", 利用金額: "", "利用店名・商品名": "現地利用額 9.68 USD" }, DEFAULT_RULES)).toBe("skip");
  expect(toSpend("amex", { ご利用日: "2026/05/10", 金額: "-50,000", ご利用内容: "前回分口座振替金額　　" }, DEFAULT_RULES)).toBe("skip");
});

test("toSpend：解析不出的行记为 invalid，不抛错", () => {
  expect(toSpend("smbc", { section: [], cols: [",,,", "1340"] }, DEFAULT_RULES)).toBe("invalid");
  expect(toSpend("paypay", { "利用日/キャンセル日": "4月1日", 利用金額: "320", "利用店名・商品名": "テスト" }, DEFAULT_RULES)).toBe("invalid");
  expect(toSpend("amex", { ご利用日: "2026/04/08", 金額: "", ご利用内容: "テスト" }, DEFAULT_RULES)).toBe("invalid");
  expect(toSpend("unknown-card", { 利用日: "2026/04/08" }, DEFAULT_RULES)).toBe("invalid");
});

test("classify：默认规则按序匹配，全角半角统一", () => {
  const c = (shop: string) => classify(shop, DEFAULT_RULES);

  expect(c("ＡＭＡＺＯＮ．ＣＯ．ＪＰ")).toEqual({ kind: "buy", category: "Amazon" });
  expect(c("ﾃｽﾄﾃﾞﾝｷﾗｸﾃﾝｲﾁ")).toEqual({ kind: "buy", category: "楽天系" });
  expect(c("Ｙａｈｏｏ！ショッピング")).toEqual({ kind: "buy", category: "Yahoo" });
  // 话费要先于楽天系，充值要先于话费，交通卡充值要先于电子钱包充值
  expect(c("楽天モバイル通信料")).toEqual({ kind: "daily", category: "通信" });
  expect(c("テストＰＡＹ残高チャージ")).toEqual({ kind: "daily", category: "其他" });
  expect(c("モバイルＳｕｉｃａチャージ")).toEqual({ kind: "daily", category: "交通" });
  expect(c("テストガス　料金")).toEqual({ kind: "daily", category: "水电燃气" });
  expect(c("ＡＮＡ　テスト便")).toEqual({ kind: "daily", category: "旅行" });
  // 短英文词要整词匹配，不能命中单词中间
  expect(c("BANANA STAND")).toEqual({ kind: "daily", category: "其他" });
  expect(c("テストバーガー")).toEqual({ kind: "daily", category: "餐饮" });
  expect(c("テストスーパー")).toEqual({ kind: "daily", category: "超市日用" });
  expect(c("TEST HAIR SALON")).toEqual({ kind: "daily", category: "服饰美容" });
  expect(c("どこにも当てはまらない店")).toEqual({ kind: "daily", category: "其他" });
});

test("loadRules：用户规则优先，文件不存在为空，写错时指出第几条", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rules-"));
  const path = join(dir, "categories.json");

  expect(await loadRules(path)).toEqual([]);

  await Bun.write(path, JSON.stringify([{ match: "テスト網店", kind: "buy", category: "其他商城" }]));
  const rules = [...(await loadRules(path)), ...DEFAULT_RULES];
  expect(classify("テスト網店", rules)).toEqual({ kind: "buy", category: "其他商城" });

  await Bun.write(path, JSON.stringify([{ match: "A", kind: "daily", category: "餐饮" }, { match: "B", kind: "daily", category: "Amazon" }]));
  await expect(loadRules(path)).rejects.toThrow("第 2 条");

  await Bun.write(path, JSON.stringify([{ match: "(", kind: "buy", category: "Yahoo" }]));
  await expect(loadRules(path)).rejects.toThrow("不是合法的正则");

  await Bun.write(path, "{ broken");
  await expect(loadRules(path)).rejects.toThrow("不是合法的 JSON");
});

const spend = (over: Partial<Spend>): Spend => ({ card: "amex", date: "2026-09-01", month: "2026-09", shop: "テスト", amount: 100, kind: "daily", category: "其他", ...over });

test("summarize：按月按类别求和，退款抵扣，月份升序，每月含全部类别", () => {
  const months = summarize([
    spend({ month: "2026-09", amount: 3000, kind: "buy", category: "Amazon" }),
    spend({ month: "2026-09", amount: -500, kind: "buy", category: "Amazon" }),
    spend({ month: "2026-09", amount: 800, kind: "daily", category: "餐饮" }),
    spend({ month: "2026-08", amount: 200, kind: "daily", category: "交通" }),
  ]);

  expect(months.map((m) => m.month)).toEqual(["2026-08", "2026-09"]);
  expect(months[1]!.buy).toEqual({ Amazon: 2500, 楽天系: 0, Yahoo: 0, 其他商城: 0 });
  expect(months[1]!.daily.餐饮).toBe(800);
  expect(Object.keys(months[0]!.daily)).toHaveLength(8);
});

test("buildReport：读库、按规则分类、跳过还款行、统计未能解析的行和覆盖范围", () => {
  const db = openDb(":memory:");
  const meta = { card: "amex", account: "", month: "2026-09", sha256: "a", rawPath: "x" };

  saveStatement(db, meta, [
    { ご利用日: "2026/08/10", 金額: "1,000", ご利用内容: "アマゾン　シーオージェーピー" },
    { ご利用日: "2026/08/12", 金額: "500", ご利用内容: "テストバーガー" },
    { ご利用日: "2026/09/02", 金額: "-9,999", ご利用内容: "前回分口座振替金額" },
    { ご利用日: "壊れた日付", 金額: "100", ご利用内容: "テスト" },
  ]);

  const data = buildReport(db, DEFAULT_RULES);
  expect(data.months.map((m) => [m.month, m.buy.Amazon, m.daily.餐饮])).toEqual([["2026-08", 1000, 500]]);
  expect(data.invalid).toBe(1);
  expect(data.coverage).toEqual([{ card: "amex", from: "2026-08-10", to: "2026-08-12" }]);
});

test("renderHtml：不含店名，数据与文字都转义，内联脚本可解析，空数据也能生成", () => {
  const months = summarize([spend({ shop: "ひみつの店", amount: 1200, kind: "buy", category: "Yahoo" })]);
  const html = renderHtml({ generatedAt: '</script><b>"x"', months, coverage: [], invalid: 0 });

  expect(html).not.toContain("ひみつの店");
  expect(html).not.toContain("</script><b>");
  expect(html).toContain("&lt;/script&gt;&lt;b&gt;&quot;x&quot;");

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(scripts).toHaveLength(1);
  expect(() => new Function(scripts[0]!)).not.toThrow();

  expect(renderHtml({ generatedAt: "x", months: [], coverage: [], invalid: 0 })).toContain("暂无数据");
});
