import type { Database } from "bun:sqlite";
import { BUY_CATEGORIES, DAILY_CATEGORIES, DEFAULT_RULES, loadRules, type BuyCategory, type DailyCategory, type Rule } from "./categories";
import { toSpend, type Spend } from "./spend";

export type MonthData = { month: string; buy: Record<BuyCategory, number>; daily: Record<DailyCategory, number> };
// 只有按月、按类别的合计：页面里不出现任何一笔明细或店名
export type ReportData = { generatedAt: string; months: MonthData[]; coverage: { card: string; from: string; to: string }[]; invalid: number };

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

// 月份升序；每月含全部固定类别（没有消费的为 0），类别顺序即图例顺序
export function summarize(spends: Spend[]): MonthData[] {
  return [...Map.groupBy(spends, (s) => s.month)]
    .map(([month, items]) =>
      items.reduce<MonthData>(
        (acc, s) => {
          (acc[s.kind] as Record<string, number>)[s.category]! += s.amount;
          return acc;
        },
        { month, buy: zeros(BUY_CATEGORIES), daily: zeros(DAILY_CATEGORIES) },
      ),
    )
    .sort((a, b) => a.month.localeCompare(b.month));
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

export function buildReport(db: Database, rules: Rule[]): ReportData {
  const rows = db.query<{ card: string; data: string }, []>("SELECT s.card, t.data FROM transactions t JOIN statements s ON s.id = t.statement_id").all();
  const results = rows.map((r) => toSpend(r.card, JSON.parse(r.data), rules));
  const spends = results.filter((r): r is Spend => typeof r === "object");

  return {
    generatedAt: new Date().toLocaleString("ja-JP"),
    months: summarize(spends),
    coverage: coverage(spends),
    invalid: results.filter((r) => r === "invalid").length,
  };
}

const CARD_NAMES: Record<string, string> = { rakuten: "楽天", smbc: "三井住友", amex: "Amex", aeon: "AEON", paypay: "PayPay" };
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

// 在浏览器里执行：经 toString() 内联进页面，所以不能引用本模块的任何变量
function client() {
  type Month = { month: string; buy: Record<string, number>; daily: Record<string, number> };

  const months: Month[] = JSON.parse(document.getElementById("data")!.textContent!).months;
  const $ = (id: string) => document.getElementById(id)!;
  const SVG = "http://www.w3.org/2000/svg";
  const PALETTE = {
    buy: ["#f59e0b", "#dc2626", "#7c3aed", "#64748b"],
    daily: ["#3b82f6", "#22c55e", "#a855f7", "#14b8a6", "#eab308", "#f97316", "#ec4899", "#94a3b8"],
  };
  const LINES = [
    { name: "合计", color: "#111827", value: (m: Month) => sum(m.buy) + sum(m.daily) },
    { name: "买取", color: "#f59e0b", value: (m: Month) => sum(m.buy) },
    { name: "日常", color: "#3b82f6", value: (m: Month) => sum(m.daily) },
  ];

  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  const yen = (n: number) => `${n < 0 ? "-" : ""}¥${Math.abs(Math.round(n)).toLocaleString("ja-JP")}`;
  const man = (n: number) => `${Math.round(n / 10000)}万`;
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const node = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  let selected = months.length - 1;

  function drawLine() {
    const [W, H, L, T, B] = [720, 220, 52, 12, 26];
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "每月消费折线" });
    // y 轴上限取 1 万的整数倍，留出顶部空间
    const top = Math.max(10000, Math.ceil(Math.max(...months.flatMap((m) => LINES.map((l) => l.value(m)))) / 10000) * 10000);
    // 右侧留出半个选中竖条的宽度，最后一个月的标签和竖条不被裁掉
    const step = (W - L - 44) / Math.max(1, months.length - 1);
    const x = (i: number) => (months.length === 1 ? (W + L) / 2 : L + i * step);
    const y = (v: number) => T + (1 - Math.max(0, v) / top) * (H - T - B);

    [0, 0.5, 1].forEach((f) => {
      svg.append(el("line", { x1: L, x2: W - 8, y1: y(top * f), y2: y(top * f), stroke: "#e5e7eb" }));
      svg.append(el("text", { x: L - 8, y: y(top * f) + 4, "text-anchor": "end", class: "tick" }, man(top * f)));
    });

    // 选中月的竖条在线下面
    const band = Math.max(24, Math.min(step, 80));
    svg.append(el("rect", { x: x(selected) - band / 2, y: T, width: band, height: H - T - B, fill: "#2563eb", opacity: 0.08 }));

    LINES.forEach((l) => {
      svg.append(el("polyline", { points: months.map((m, i) => `${x(i)},${y(l.value(m))}`).join(" "), fill: "none", stroke: l.color, "stroke-width": l.name === "合计" ? 2.5 : 2 }));
      months.forEach((m, i) => svg.append(el("circle", { cx: x(i), cy: y(l.value(m)), r: i === selected ? 4.5 : 3, fill: l.color })));
    });

    months.forEach((m, i) => {
      svg.append(el("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: i === selected ? "tick on" : "tick" }, m.month.slice(2)));
      // 透明的整列热区：点月份附近任意位置都能选中
      const hit = el("rect", { x: x(i) - band / 2, y: 0, width: band, height: H, fill: "transparent", class: "hit" });
      hit.addEventListener("click", () => select(i));
      svg.append(hit);
    });

    $("line").replaceChildren(svg);
  }

  function drawPie(id: string, title: string, values: Record<string, number>, palette: string[]) {
    const items = Object.entries(values).map(([name, v], i) => ({ name, v, color: palette[i % palette.length]! }));
    const positive = items.filter((it) => it.v > 0);
    const total = positive.reduce((a, it) => a + it.v, 0);
    const box = $(id);

    box.replaceChildren();
    box.append(Object.assign(document.createElement("h2"), { textContent: `${title} ${yen(sum(values))}` }));

    if (total <= 0) {
      box.append(Object.assign(document.createElement("p"), { className: "none", textContent: "本月无" }));
      return;
    }

    // 环形图：每段是一条描边弧，靠 dasharray 截出长度、dashoffset 定起点
    const [R, C] = [42, 2 * Math.PI * 42];
    const svg = el("svg", { viewBox: "0 0 120 120", class: "pie" });
    let offset = 0;
    positive.forEach((it) => {
      const len = (it.v / total) * C;
      svg.append(el("circle", { r: R, cx: 60, cy: 60, fill: "none", stroke: it.color, "stroke-width": 22, "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -offset, transform: "rotate(-90 60 60)" }));
      offset += len;
    });

    const legend = document.createElement("ul");
    items
      .filter((it) => it.v !== 0)
      .forEach((it) => {
        const li = document.createElement("li");
        const pct = it.v > 0 ? `${Math.round((it.v / total) * 100)}%` : "";
        li.innerHTML = `<i style="background:${it.color}"></i><span></span><b>${yen(it.v)}</b><em>${pct}</em>`;
        li.querySelector("span")!.textContent = it.name;
        legend.append(li);
      });

    const row = document.createElement("div");
    row.className = "pie-row";
    row.append(svg, legend);
    box.append(row);
  }

  function select(i: number) {
    selected = i;
    const m = months[i]!;

    $("month").textContent = m.month;
    $("summary").textContent = `合计 ${yen(sum(m.buy) + sum(m.daily))} ・ 买取 ${yen(sum(m.buy))} ・ 日常 ${yen(sum(m.daily))}`;
    ($("prev") as HTMLButtonElement).disabled = i === 0;
    ($("next") as HTMLButtonElement).disabled = i === months.length - 1;

    drawLine();
    drawPie("pie-daily", "日常", m.daily, PALETTE.daily);
    drawPie("pie-buy", "买取", m.buy, PALETTE.buy);
  }

  if (months.length === 0) return;

  $("prev").addEventListener("click", () => select(selected - 1));
  $("next").addEventListener("click", () => select(selected + 1));
  $("legend").innerHTML = LINES.map((l) => `<span><i style="background:${l.color}"></i>${l.name}</span>`).join("");
  select(selected);
}

const STYLE = `
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:#f8fafc; color:#1f2937; font:14px/1.6 -apple-system,"Hiragino Sans","PingFang SC",sans-serif; }
main { max-width:960px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 12px; }
.card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; }
#legend { display:flex; gap:16px; color:#6b7280; font-size:13px; margin-bottom:4px; }
i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:middle; }
#line svg { width:100%; display:block; }
.tick { font-size:11px; fill:#6b7280; }
.tick.on { fill:#2563eb; font-weight:700; }
.hit { cursor:pointer; }
.switch { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin:20px 0 12px; }
.switch button { border:1px solid #d1d5db; background:#fff; border-radius:8px; width:36px; height:32px; font-size:14px; cursor:pointer; }
.switch button:disabled { opacity:.35; cursor:default; }
#month { font-size:20px; font-weight:700; }
#summary { color:#6b7280; }
.pies { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.pies h2 { font-size:15px; margin:0 0 8px; }
.pie-row { display:flex; align-items:center; gap:16px; }
.pie { width:140px; flex:none; }
ul { list-style:none; margin:0; padding:0; flex:1; font-size:13px; }
li { display:grid; grid-template-columns:auto 1fr auto 3em; align-items:center; gap:6px; padding:3px 0; border-bottom:1px solid #f1f5f9; }
li b { font-weight:500; font-variant-numeric:tabular-nums; }
li em { font-style:normal; color:#6b7280; text-align:right; }
.none { color:#9ca3af; }
footer { margin-top:28px; color:#6b7280; font-size:12px; }
`;

const footer = (data: ReportData) => `
<footer>
  <p>各卡消费日覆盖范围：${data.coverage.map((c) => `${CARD_NAMES[c.card] ?? esc(c.card)} ${c.from} ～ ${c.to}`).join("，") || "无"}</p>
  <p>未能解析的明细：${data.invalid} 行${data.invalid > 0 ? "（卡公司可能改了格式，用 bun run inspect 查看原始文件）" : ""}</p>
  <p>生成于 ${esc(data.generatedAt)}</p>
</footer>`;

export function renderHtml(data: ReportData): string {
  // 数据放进 <script> 里，< 转义掉，防止内容提前闭合标签
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const body =
    data.months.length === 0
      ? "<p>暂无数据：先跑 bun run sync 或 bun run import。</p>"
      : `<section class="card"><div id="legend"></div><div id="line"></div></section>
<div class="switch"><button id="prev" aria-label="上个月">◀</button><span id="month"></span><button id="next" aria-label="下个月">▶</button><span id="summary"></span></div>
<div class="pies"><section class="card" id="pie-daily"></section><section class="card" id="pie-buy"></section></div>`;

  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>月度消费</title><style>${STYLE}</style></head>
<body><main><h1>月度消费</h1>${body}${footer(data)}</main>
<script type="application/json" id="data">${json}</script>
<script>(${client.toString()})();</script>
</body>
</html>`;
}

// 用户规则（data/categories.json）排在默认规则前面，优先匹配
export async function writeReport(db: Database, path: string, rulesPath: string): Promise<void> {
  const rules = [...(await loadRules(rulesPath)), ...DEFAULT_RULES];
  await Bun.write(path, renderHtml(buildReport(db, rules)));
}
