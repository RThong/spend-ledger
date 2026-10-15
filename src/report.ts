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
