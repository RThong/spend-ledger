// 全部是编造的假数据，格式照调研里的社区样本
import { expect, test } from "bun:test";
import iconv from "iconv-lite";
import { cards } from "./cards";
import { monthOf } from "./cards/util";
import { hasStatement, openDb, saveStatement } from "./db";
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
