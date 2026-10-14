# 月度消费报告 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run report` 生成 `data/report.html`：按消费日归月，把 Amazon / 楽天系 / 普通 三组消费分开展示；`sync` / `import` 结束后自动重新生成。

**Architecture:** `src/spend.ts` 把 5 家卡的原始 JSON 行转成统一的 `Spend`（纯函数，不碰库和文件）；`src/report.ts` 读库、按月汇总、在 Bun 侧渲染成**静态 HTML**（SVG 柱状图 + 表格 + 原生 `<details>` 展开明细，页面里没有 JS）；`src/cli.ts` 接上 `report` 命令和自动生成。

**Tech Stack:** Bun 1.4、TypeScript、`bun:sqlite`、`bun test`。不新增任何依赖。

**Spec:** `docs/superpowers/specs/2026-10-14-monthly-report-design.md`

## Global Constraints

- 运行时 Bun ≥ 1.4；测试用 `bun test`；类型检查 `bunx tsc --noEmit -p .`
- 不新增 npm 依赖；HTML 不加载任何外部资源（无 CDN、无外链字体）
- 报告只写到 `data/report.html`（`data/` 已 gitignore，权限 700）
- 按**消费日（利用日）**归月，月份格式 `YYYY-MM`，日期格式 `YYYY-MM-DD`
- 金额一律用「利用金額」：rakuten `利用金額` / smbc 从右往左第 5 列 / amex `金額` / aeon `useAmount` / paypay `利用金額`
- 分组规则（店名先 NFKC，按序第一条命中）：含 `楽天モバイル` → normal；含 `アマゾン` 或 `AMAZON`（不区分大小写）→ amazon；含 `楽天` 或 `ラクテン` → rakuten；其余 → normal
- 跳过（不是消费）：rakuten 利用日为空的续行；amex 店名为 `前回分口座振替金額`
- 解析不出日期或金额的行计入「未能解析」数，不静默丢弃、不抛错
- 代码风格：中文注释只解释「为什么」；优先 map/filter/reduce；值到处理的映射用查表
- 仓库是公开的：测试数据必须是编造的，不得出现真实卡号、真实金额

## Review Focus

1. 店名含 `<`、`&`、`"`（如 `A&B <限定>`）→ 原样显示为文字，不破坏页面结构（Task 2 测试）
2. 某组当月合计为负（退款大于购买）→ 表格显示负数，柱状图不画负高度、不报错（Task 2 测试）
3. 库里一笔都没有（新环境首次运行）→ 生成「暂无数据」的页面而不是崩溃（Task 2 测试）
4. 三井住友列数异常少（合计行残片等）、日期写成别的格式 → 计入「未能解析」，不抛错（Task 1 测试）
5. 未知卡 id（以后新增卡但忘了加取法）→ 计入「未能解析」，不抛错（Task 1 测试）

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/spend.ts` | Create | `Spend` / `Group` 类型；各卡取法表；跳过规则；日期、金额解析；`classify` 分组；`toSpend` |
| `src/report.ts` | Create | `summarize` 按月汇总；`coverage` 各卡覆盖范围；`buildReport` 读库；`renderHtml` 渲染；`writeReport` 写文件 |
| `src/cli.ts` | Modify | 新增 `report` 命令；`sync`、`import` 结束后自动生成；USAGE 增加一行 |
| `package.json` | Modify | 新增 `"report"` 脚本 |
| `README.md` | Modify | 用法里加 `bun run report` 和自动生成说明 |
| `src/core.test.ts` | Modify | 追加 Task 1、Task 2 的测试 |

---

### Task 1: `src/spend.ts` —— 原始行转统一结构 + 分组

**Files:**
- Create: `src/spend.ts`
- Test: `src/core.test.ts`（在文件末尾追加）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `export type Group = "amazon" | "rakuten" | "normal"`
  - `export const GROUPS: readonly Group[]`（顺序固定 `["amazon", "rakuten", "normal"]`）
  - `export type Spend = { card: string; date: string; month: string; shop: string; amount: number; group: Group }`
  - `export function classify(shop: string): Group`
  - `export function toSpend(card: string, data: Record<string, any>): Spend | "skip" | "invalid"`

- [ ] **Step 1: 写失败的测试**

在 `src/core.test.ts` 顶部 import 区追加一行：

```ts
import { classify, toSpend } from "./spend";
```

在文件末尾追加：

```ts
test("toSpend：各卡取消费日、金额、店名", () => {
  expect(toSpend("rakuten", { 利用日: "2026/09/03", 利用金額: "5643", "利用店名・商品名": "テスト電機　楽天市場店" })).toEqual({
    card: "rakuten",
    date: "2026-09-03",
    month: "2026-09",
    shop: "テスト電機　楽天市場店",
    amount: 5643,
    group: "rakuten",
  });
  // 店名含未加引号的逗号，列数变多，金额要从右往左数
  expect(toSpend("smbc", { section: [], cols: ["2026/8/9", "店名", "含逗号", "1000", "１", "１", "1000", ""] })).toMatchObject({ date: "2026-08-09", amount: 1000, shop: "店名" });
  expect(toSpend("amex", { ご利用日: "2026/04/08", 金額: "-1,431", ご利用内容: "アマゾン　シーオージェーピー　　" })).toMatchObject({ amount: -1431, group: "amazon", shop: "アマゾン　シーオージェーピー" });
  expect(toSpend("aeon", { useDate: "20260102", useAmount: 980, useStoreName: "テストストア" })).toMatchObject({ date: "2026-01-02", month: "2026-01", amount: 980, group: "normal" });
  expect(toSpend("paypay", { "利用日/キャンセル日": "2026/4/1", 利用金額: "320", "利用店名・商品名": "テスト商店" })).toMatchObject({ date: "2026-04-01", amount: 320 });
});

test("toSpend：跳过不是消费的行", () => {
  expect(toSpend("rakuten", { 利用日: "", 利用金額: "", "利用店名・商品名": "現地利用額 9.68 USD" })).toBe("skip");
  expect(toSpend("amex", { ご利用日: "2026/05/10", 金額: "-50,000", ご利用内容: "前回分口座振替金額　　" })).toBe("skip");
});

test("toSpend：解析不出的行记为 invalid，不抛错", () => {
  expect(toSpend("smbc", { section: [], cols: [",,,", "1340"] })).toBe("invalid");
  expect(toSpend("paypay", { "利用日/キャンセル日": "4月1日", 利用金額: "320", "利用店名・商品名": "テスト" })).toBe("invalid");
  expect(toSpend("amex", { ご利用日: "2026/04/08", 金額: "", ご利用内容: "テスト" })).toBe("invalid");
  expect(toSpend("unknown-card", { 利用日: "2026/04/08" })).toBe("invalid");
});

test("classify：全角半角统一后分组，楽天モバイル 归普通", () => {
  expect(classify("ＡＭＡＺＯＮ．ＣＯ．ＪＰ")).toBe("amazon");
  expect(classify("Ａｍａｚｏｎ　Ｄｏｗｎｌｏａｄｓ")).toBe("amazon");
  expect(classify("アマゾン　ＪＰ　マーケットプレイス")).toBe("amazon");
  expect(classify("ﾃｽﾄﾃﾞﾝｷﾗｸﾃﾝｲﾁ")).toBe("rakuten");
  expect(classify("楽天ブックス")).toBe("rakuten");
  expect(classify("楽天モバイル通信料")).toBe("normal");
  expect(classify("テストマート／ｉＤ")).toBe("normal");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/core.test.ts`
Expected: FAIL，报 `Cannot find module './spend'` 一类的错误

- [ ] **Step 3: 写最小实现**

Create `src/spend.ts`:

```ts
export type Group = "amazon" | "rakuten" | "normal";
export const GROUPS: readonly Group[] = ["amazon", "rakuten", "normal"];

export type Spend = { card: string; date: string; month: string; shop: string; amount: number; group: Group };

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

// 按序匹配，第一条命中即止；店名先 NFKC，统一全角/半角（ＡＭＡＺＯＮ→AMAZON、ﾗｸﾃﾝ→ラクテン）
const GROUP_RULES: [RegExp, Group][] = [
  // 通信费，不是网购
  [/楽天モバイル/, "normal"],
  [/アマゾン|AMAZON/i, "amazon"],
  [/楽天|ラクテン/, "rakuten"],
];

export const classify = (shop: string): Group => GROUP_RULES.find(([re]) => re.test(shop.normalize("NFKC")))?.[1] ?? "normal";

export function toSpend(card: string, data: Row): Spend | "skip" | "invalid" {
  const rule = CARDS[card];
  if (!rule) return "invalid";

  const raw = rule.fields(data);
  if (rule.skip?.(raw)) return "skip";

  const date = parseDate(raw.date);
  const amount = parseAmount(raw.amount);
  if (!date || amount === null) return "invalid";

  const shop = text(raw.shop);
  return { card, date, month: date.slice(0, 7), shop, amount, group: classify(shop) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/core.test.ts && bunx tsc --noEmit -p .`
Expected: 全部 PASS（原有 9 个 + 新增 4 个 = 13 个），tsc 无输出

- [ ] **Step 5: Commit**

```bash
git add src/spend.ts src/core.test.ts
git commit -m "feat: 各卡明细转统一的消费记录并按 Amazon / 楽天系 / 普通 分组"
```

---

### Task 2: `src/report.ts` —— 按月汇总并渲染静态 HTML

**Files:**
- Create: `src/report.ts`
- Test: `src/core.test.ts`（在文件末尾追加）

**Interfaces:**
- Consumes: `GROUPS`、`Group`、`Spend`、`toSpend` from `./spend`；`Database` from `bun:sqlite`
- Produces:
  - `export type MonthSummary = { month: string; totals: Record<Group, number>; total: number; items: Spend[] }`
  - `export type ReportData = { generatedAt: string; months: MonthSummary[]; coverage: { card: string; from: string; to: string }[]; invalid: number }`
  - `export function summarize(spends: Spend[]): MonthSummary[]`（月份降序；`items` 按日期升序）
  - `export function buildReport(db: Database): ReportData`
  - `export function renderHtml(data: ReportData): string`
  - `export async function writeReport(db: Database, path: string): Promise<void>`

- [ ] **Step 1: 写失败的测试**

在 `src/core.test.ts` 顶部 import 区追加：

```ts
import { buildReport, renderHtml, summarize } from "./report";
import type { Spend } from "./spend";
```

在文件末尾追加：

```ts
const spend = (over: Partial<Spend>): Spend => ({ card: "amex", date: "2026-09-01", month: "2026-09", shop: "テスト", amount: 100, group: "normal", ...over });

test("summarize：按月分组求和，退款负数抵扣，月份降序、明细按日期升序", () => {
  const months = summarize([
    spend({ date: "2026-09-20", amount: 3000, group: "amazon" }),
    spend({ date: "2026-09-05", amount: -500, group: "amazon" }),
    spend({ date: "2026-09-10", amount: 800, group: "rakuten" }),
    spend({ date: "2026-08-31", month: "2026-08", amount: 200 }),
  ]);

  expect(months.map((m) => m.month)).toEqual(["2026-09", "2026-08"]);
  expect(months[0]!.totals).toEqual({ amazon: 2500, rakuten: 800, normal: 0 });
  expect(months[0]!.total).toBe(3300);
  expect(months[0]!.items.map((s) => s.date)).toEqual(["2026-09-05", "2026-09-10", "2026-09-20"]);
});

test("buildReport：读库、跳过还款行、统计未能解析的行和各卡覆盖范围", () => {
  const db = openDb(":memory:");
  const meta = { card: "amex", account: "", month: "2026-09", sha256: "a", rawPath: "x" };

  saveStatement(db, meta, [
    { ご利用日: "2026/08/10", 金額: "1,000", ご利用内容: "アマゾン　シーオージェーピー" },
    { ご利用日: "2026/09/02", 金額: "-9,999", ご利用内容: "前回分口座振替金額" },
    { ご利用日: "壊れた日付", 金額: "100", ご利用内容: "テスト" },
  ]);

  const data = buildReport(db);
  expect(data.months.map((m) => [m.month, m.totals.amazon])).toEqual([["2026-08", 1000]]);
  expect(data.invalid).toBe(1);
  expect(data.coverage).toEqual([{ card: "amex", from: "2026-08-10", to: "2026-08-10" }]);
});

test("renderHtml：店名转义、负数合计不画负高度、空数据也能生成", () => {
  const months = summarize([
    spend({ shop: 'A&B <限定> "特価"', amount: 1200, group: "amazon" }),
    spend({ shop: "返品", amount: -5000, group: "rakuten" }),
  ]);
  const html = renderHtml({ generatedAt: "2026-10-14 12:00", months, coverage: [], invalid: 0 });

  expect(html).toContain("A&amp;B &lt;限定&gt; &quot;特価&quot;");
  expect(html).not.toContain("<限定>");
  expect(html).toContain("-¥5,000");
  expect(html).not.toMatch(/height="-/);

  const empty = renderHtml({ generatedAt: "2026-10-14 12:00", months: [], coverage: [], invalid: 0 });
  expect(empty).toContain("暂无数据");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test src/core.test.ts`
Expected: FAIL，报 `Cannot find module './report'` 一类的错误

- [ ] **Step 3: 写最小实现**

Create `src/report.ts`:

```ts
import type { Database } from "bun:sqlite";
import { GROUPS, toSpend, type Group, type Spend } from "./spend";

export type MonthSummary = { month: string; totals: Record<Group, number>; total: number; items: Spend[] };
export type ReportData = { generatedAt: string; months: MonthSummary[]; coverage: { card: string; from: string; to: string }[]; invalid: number };

const sum = (items: Spend[]) => items.reduce((acc, s) => acc + s.amount, 0);

export function summarize(spends: Spend[]): MonthSummary[] {
  return [...Map.groupBy(spends, (s) => s.month)]
    .map(([month, items]) => ({
      month,
      totals: Object.fromEntries(GROUPS.map((g) => [g, sum(items.filter((s) => s.group === g))])) as Record<Group, number>,
      total: sum(items),
      items: items.toSorted((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

// 最早的一两个月可能只有部分卡覆盖，列出范围供判断
function coverage(spends: Spend[]): ReportData["coverage"] {
  return [...Map.groupBy(spends, (s) => s.card)]
    .map(([card, items]) => {
      const dates = items.map((s) => s.date).sort();
      return { card, from: dates[0]!, to: dates.at(-1)! };
    })
    .sort((a, b) => a.card.localeCompare(b.card));
}

export function buildReport(db: Database): ReportData {
  const rows = db.query<{ card: string; data: string }, []>("SELECT s.card, t.data FROM transactions t JOIN statements s ON s.id = t.statement_id").all();
  const results = rows.map((r) => toSpend(r.card, JSON.parse(r.data)));
  const spends = results.filter((r): r is Spend => typeof r === "object");

  return {
    generatedAt: new Date().toLocaleString("ja-JP"),
    months: summarize(spends),
    coverage: coverage(spends),
    invalid: results.filter((r) => r === "invalid").length,
  };
}

const LABELS: Record<Group, { name: string; color: string }> = {
  amazon: { name: "Amazon", color: "#f59e0b" },
  rakuten: { name: "楽天系", color: "#dc2626" },
  normal: { name: "普通", color: "#64748b" },
};
const CARD_NAMES: Record<string, string> = { rakuten: "楽天", smbc: "三井住友", amex: "Amex", aeon: "AEON", paypay: "PayPay" };

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
const yen = (n: number) => `${n < 0 ? "-" : ""}¥${Math.abs(Math.round(n)).toLocaleString("ja-JP")}`;

// 月份从左到右升序的堆叠柱；负数合计（退款多于购买）不画，只在表格里体现
function chart(months: MonthSummary[]): string {
  const asc = months.toReversed();
  const stack = (m: MonthSummary) => GROUPS.reduce((acc, g) => acc + Math.max(0, m.totals[g]), 0);
  const max = Math.max(1, ...asc.map(stack));
  const [W, H, TOP] = [72, 220, 28];

  const bars = asc.map((m, i) => {
    const x = i * W + 14;
    // 自下而上逐段叠加，需要累计高度，用 reduce 传递当前顶部位置
    const { svg, top } = GROUPS.reduce(
      (acc, g) => {
        const h = (Math.max(0, m.totals[g]) / max) * H;
        const y = acc.top - h;
        return { svg: `${acc.svg}<rect x="${x}" y="${y.toFixed(1)}" width="${W - 28}" height="${h.toFixed(1)}" fill="${LABELS[g].color}"><title>${LABELS[g].name} ${yen(m.totals[g])}</title></rect>`, top: y };
      },
      { svg: "", top: TOP + H },
    );
    const cx = x + (W - 28) / 2;

    return `${svg}<text x="${cx}" y="${(top - 6).toFixed(1)}" class="sum">${yen(m.total)}</text><text x="${cx}" y="${TOP + H + 18}" class="axis">${m.month}</text>`;
  });

  const width = asc.length * W;
  return `<svg viewBox="0 0 ${width} ${TOP + H + 28}" style="max-width:${width}px" role="img" aria-label="月度消费柱状图">${bars.join("")}</svg>`;
}

const legend = () => GROUPS.map((g) => `<span><i style="background:${LABELS[g].color}"></i>${LABELS[g].name}</span>`).join("");

const monthTable = (months: MonthSummary[]) => `
<table class="totals">
  <thead><tr><th>月份</th>${GROUPS.map((g) => `<th>${LABELS[g].name}</th>`).join("")}<th>合计</th></tr></thead>
  <tbody>${months.map((m) => `<tr><td>${m.month}</td>${GROUPS.map((g) => `<td>${yen(m.totals[g])}</td>`).join("")}<td><b>${yen(m.total)}</b></td></tr>`).join("")}</tbody>
</table>`;

function groupSection(m: MonthSummary, g: Group): string {
  const items = m.items.filter((s) => s.group === g);
  if (items.length === 0) return "";

  const rows = items.map((s) => `<tr><td>${s.date.slice(5)}</td><td>${CARD_NAMES[s.card] ?? esc(s.card)}</td><td class="shop">${esc(s.shop)}</td><td>${yen(s.amount)}</td></tr>`).join("");
  return `<h3><i style="background:${LABELS[g].color}"></i>${LABELS[g].name}<span>${items.length} 笔 · ${yen(m.totals[g])}</span></h3><table class="items">${rows}</table>`;
}

const monthDetails = (months: MonthSummary[]) =>
  months.map((m) => `<details><summary><b>${m.month}</b><span>${yen(m.total)}</span></summary>${GROUPS.map((g) => groupSection(m, g)).join("")}</details>`).join("");

const footer = (data: ReportData) => `
<footer>
  <p>各卡消费日覆盖范围：${data.coverage.map((c) => `${CARD_NAMES[c.card] ?? esc(c.card)} ${c.from} ～ ${c.to}`).join("，") || "无"}</p>
  <p>未能解析的明细：${data.invalid} 行${data.invalid > 0 ? "（卡公司可能改了格式，用 bun run inspect 查看原始文件）" : ""}</p>
  <p>生成于 ${esc(data.generatedAt)}</p>
</footer>`;

const STYLE = `
:root { --bg:#fff; --fg:#1f2937; --muted:#6b7280; --line:#e5e7eb; --card:#f9fafb; }
@media (prefers-color-scheme: dark) { :root { --bg:#111827; --fg:#e5e7eb; --muted:#9ca3af; --line:#374151; --card:#1f2937; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,"Hiragino Sans","PingFang SC",sans-serif; }
main { max-width:960px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 16px; }
.legend { display:flex; gap:16px; margin:8px 0 16px; color:var(--muted); }
i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:middle; }
svg { width:100%; display:block; margin-bottom:24px; }
svg text { font-size:11px; text-anchor:middle; fill:var(--muted); }
svg text.sum { fill:var(--fg); font-weight:600; }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
th, td { padding:6px 8px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
th:first-child, td:first-child { text-align:left; }
.totals { margin-bottom:24px; }
details { border:1px solid var(--line); border-radius:8px; margin-bottom:8px; background:var(--card); }
summary { display:flex; justify-content:space-between; padding:10px 14px; cursor:pointer; }
details[open] summary { border-bottom:1px solid var(--line); }
h3 { display:flex; align-items:center; font-size:14px; margin:14px 14px 4px; }
h3 span { margin-left:auto; color:var(--muted); font-weight:400; }
.items { margin:0 14px 8px; width:calc(100% - 28px); }
.items td.shop { text-align:left; white-space:normal; width:100%; }
footer { margin-top:32px; color:var(--muted); font-size:12px; }
@media (max-width:600px) { .totals th:nth-child(n+2):not(:last-child), .totals td:nth-child(n+2):not(:last-child) { display:none; } }
`;

export function renderHtml(data: ReportData): string {
  const body =
    data.months.length === 0
      ? "<p>暂无数据：先跑 bun run sync 或 bun run import。</p>"
      : `<div class="legend">${legend()}</div>${chart(data.months)}${monthTable(data.months)}${monthDetails(data.months)}`;

  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>月度消费</title><style>${STYLE}</style></head>
<body><main><h1>月度消费</h1>${body}${footer(data)}</main></body>
</html>`;
}

export async function writeReport(db: Database, path: string): Promise<void> {
  await Bun.write(path, renderHtml(buildReport(db)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test src/core.test.ts && bunx tsc --noEmit -p .`
Expected: 全部 PASS（16 个），tsc 无输出

- [ ] **Step 5: Commit**

```bash
git add src/report.ts src/core.test.ts
git commit -m "feat: 按月汇总消费并渲染静态 HTML 报告"
```

---

### Task 3: 接入 CLI —— `report` 命令与自动生成

**Files:**
- Modify: `src/cli.ts`（import 区；`USAGE`；`sync()` 末尾；`importFile()` 末尾；`commands` 表）
- Modify: `package.json`（`scripts`）
- Modify: `README.md`（「用法」代码块与其下说明）

**Interfaces:**
- Consumes: `writeReport(db: Database, path: string): Promise<void>` from `./report`；cli 中已有的 `DATA`、`openDb`
- Produces: CLI 命令 `bun run report`；`sync` / `import` 结束后自动生成 `data/report.html`

- [ ] **Step 1: 在 `src/cli.ts` 加 import**

在 `import { decode, isUtf8, parseCsv, shape } from "./text";` 上方加：

```ts
import { writeReport } from "./report";
```

- [ ] **Step 2: USAGE 增加一行**

把 `USAGE` 里 `bun run inspect` 那一行改为下面两行（`inspect` 行末尾的反引号移到新行）：

```ts
  bun run inspect <文件>                              输出脱敏后的格式信息，可放心贴出来
  bun run report                                      生成月度消费报告 data/report.html（sync / import 后也会自动生成）`;
```

- [ ] **Step 3: 新增 `report` 函数**

在 `async function sync(` 定义的上方加：

```ts
async function report() {
  const path = `${DATA}/report.html`;

  await writeReport(openDb(`${DATA}/ledger.db`), path);
  console.log(`\n报告：${path}`);
}

// 报告只是附带产物，生成失败不能让同步 / 导入本身判失败
const refreshReport = () => report().catch((e: Error) => console.error(`\n报告生成失败：${e.message}`));
```

- [ ] **Step 4: `sync()` 和 `importFile()` 结束后自动生成**

在 `sync()` 最后一行 `if (results.some(([, result]) => result.startsWith("失败"))) process.exitCode = 1;` 之后加：

```ts

  await refreshReport();
```

在 `importFile()` 最后的 `await ingest(...)` 那一行之后加：

```ts

  await refreshReport();
```

- [ ] **Step 5: 注册命令**

把：

```ts
const commands: Record<string, (args: string[]) => Promise<void>> = { sync, login, import: importFile, inspect };
```

改为：

```ts
const commands: Record<string, (args: string[]) => Promise<void>> = { sync, login, import: importFile, inspect, report };
```

- [ ] **Step 6: `package.json` 加脚本**

在 `"inspect": "bun src/cli.ts inspect"` 后加一行（上一行末尾补逗号）：

```json
    "report": "bun src/cli.ts report"
```

- [ ] **Step 7: README 用法**

在 README「用法」代码块里 `bun run login` 那一行之后加：

```bash
bun run report                    # 生成月度消费报告 data/report.html，浏览器打开
```

并在代码块后、`sync` 说明段落之前加一段：

```markdown
`sync` 和 `import` 跑完也会自动重新生成报告。报告按**消费日**归月，把 Amazon、楽天系（楽天市場各店、楽天ブックス等，不含楽天モバイル）和普通消费分开列出；只写在本机 `data/` 里。
```

- [ ] **Step 8: 验证**

Run: `bunx tsc --noEmit -p . && bun test && bun run report && /bin/ls -la data/report.html`
Expected: tsc 无输出；16 个测试 PASS；终端打印 `报告：.../data/report.html`；文件存在且大小 > 0

然后用浏览器打开 `data/report.html` 人工确认：
- 柱状图月份从左到右升序，每根柱三色堆叠，柱顶有合计
- 月度表每月一行，四列金额
- 点开某月能看到三组明细与小计
- 底部有各卡覆盖范围和「未能解析」行数

再跑一次导入，确认会自动生成（导入同一份已入库文件，结果应为「无变化」）：

Run: `F=$(/bin/ls data/raw/paypay/_/*.csv | head -1); M=$(basename "$F" | cut -c1-7); bun run import paypay "$F" --month "$M"`
Expected: 输出 `…：无变化（N 行）`，随后 `报告：.../data/report.html`

- [ ] **Step 9: Commit**

```bash
git add src/cli.ts package.json README.md
git commit -m "feat: 新增 report 命令，sync / import 后自动生成月度报告"
```
