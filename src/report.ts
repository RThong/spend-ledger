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

  // tooltip：一行一项 [色块, 名称, 金额]；内容全是固定类别名和数字，仍用 textContent 写入
  const tip = Object.assign(document.createElement("div"), { id: "tip" });
  document.body.append(tip);
  const showTip = (e: MouseEvent, title: string, rows: [string, string, string][]) => {
    tip.replaceChildren(Object.assign(document.createElement("strong"), { textContent: title }));
    rows.forEach(([color, name, value]) => {
      const row = document.createElement("div");
      row.innerHTML = `<i style="background:${color}"></i><span></span><b></b>`;
      row.querySelector("span")!.textContent = name;
      row.querySelector("b")!.textContent = value;
      tip.append(row);
    });
    tip.style.display = "block";
    // 靠右或靠下放不下时翻到鼠标另一侧
    const { width, height } = tip.getBoundingClientRect();
    tip.style.left = `${e.clientX + 14 + width > innerWidth ? e.clientX - 14 - width : e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14 + height > innerHeight ? e.clientY - 14 - height : e.clientY + 14}px`;
  };
  const hideTip = () => (tip.style.display = "none");

  let selected = months.length - 1;
  const hidden = new Set<string>();

  // 鼠标停在图例或线上时，其余的线淡出
  const focusLine = (name: string | null) =>
    document.querySelectorAll<SVGGElement>("#line .series").forEach((g) => g.classList.toggle("faded", name !== null && g.dataset.name !== name));

  function drawLine() {
    const [W, H, L, T, B] = [720, 220, 52, 12, 26];
    const lines = LINES.filter((l) => !hidden.has(l.name));
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "每月消费折线" });
    // y 轴上限按当前显示的线取 1 万的整数倍：隐藏「合计」后，买取 / 日常能放大看清
    const peak = Math.max(0, ...months.flatMap((m) => lines.map((l) => l.value(m))));
    const top = Math.max(10000, Math.ceil(peak / 10000) * 10000);
    // 右侧留出半个选中竖条的宽度，最后一个月的标签和竖条不被裁掉
    const step = (W - L - 44) / Math.max(1, months.length - 1);
    const x = (i: number) => (months.length === 1 ? (W + L) / 2 : L + i * step);
    const y = (v: number) => T + (1 - Math.max(0, v) / top) * (H - T - B);
    const band = Math.max(24, Math.min(step, 80));

    [0, 0.5, 1].forEach((f) => {
      svg.append(el("line", { x1: L, x2: W - 8, y1: y(top * f), y2: y(top * f), stroke: "#e5e7eb" }));
      svg.append(el("text", { x: L - 8, y: y(top * f) + 4, "text-anchor": "end", class: "tick" }, man(top * f)));
    });

    // 选中月的竖条和 hover 竖线都在线下面
    svg.append(el("rect", { x: x(selected) - band / 2, y: T, width: band, height: H - T - B, fill: "#2563eb", opacity: 0.08 }));
    const guide = el("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: "#94a3b8", "stroke-dasharray": "3 3", visibility: "hidden" });
    svg.append(guide);

    lines.forEach((l) => {
      const g = el("g", { class: "series", "data-name": l.name });
      g.append(el("polyline", { points: months.map((m, i) => `${x(i)},${y(l.value(m))}`).join(" "), fill: "none", stroke: l.color, "stroke-width": l.name === "合计" ? 2.5 : 2 }));
      months.forEach((m, i) => g.append(el("circle", { cx: x(i), cy: y(l.value(m)), r: i === selected ? 4.5 : 3, fill: l.color })));
      svg.append(g);
    });

    months.forEach((m, i) => {
      svg.append(el("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: i === selected ? "tick on" : "tick" }, m.month.slice(2)));
      // 透明的整列热区：hover 出 tooltip，点击选中该月
      const hit = el("rect", { x: x(i) - band / 2, y: 0, width: band, height: H, fill: "transparent", class: "hit" });
      hit.addEventListener("mousemove", (e) => {
        guide.setAttribute("x1", String(x(i)));
        guide.setAttribute("x2", String(x(i)));
        guide.setAttribute("visibility", "visible");
        showTip(e as MouseEvent, m.month, lines.map((l) => [l.color, l.name, yen(l.value(m))]));
      });
      hit.addEventListener("mouseleave", () => {
        guide.setAttribute("visibility", "hidden");
        hideTip();
      });
      hit.addEventListener("click", () => select(i));
      svg.append(hit);
    });

    $("line").replaceChildren(svg);
  }

  // 图例：点击显示 / 隐藏该线，hover 突出该线；至少留一条
  function drawLegend() {
    $("legend").replaceChildren(
      ...LINES.map((l) => {
        const off = hidden.has(l.name);
        const btn = Object.assign(document.createElement("button"), { className: off ? "off" : "", title: off ? "点击显示" : "点击隐藏" });
        btn.setAttribute("aria-pressed", String(!off));
        btn.innerHTML = `<i style="background:${l.color}"></i>`;
        btn.append(l.name);
        btn.addEventListener("click", () => {
          if (!off && hidden.size === LINES.length - 1) return;
          off ? hidden.delete(l.name) : hidden.add(l.name);
          drawLegend();
          drawLine();
        });
        btn.addEventListener("mouseenter", () => !off && focusLine(l.name));
        btn.addEventListener("mouseleave", () => focusLine(null));
        return btn;
      }),
    );
  }

  function drawPie(id: string, title: string, values: Record<string, number>, palette: string[]) {
    const items = Object.entries(values).map(([name, v], i) => ({ name, v, color: palette[i % palette.length]! }));
    const positive = items.filter((it) => it.v > 0);
    const total = positive.reduce((a, it) => a + it.v, 0);
    const pct = (v: number) => (v > 0 ? `${Math.round((v / total) * 100)}%` : "");
    const box = $(id);

    box.replaceChildren();
    box.append(Object.assign(document.createElement("h2"), { textContent: `${title} ${yen(sum(values))}` }));

    if (total <= 0) {
      box.append(Object.assign(document.createElement("p"), { className: "none", textContent: "本月无" }));
      return;
    }

    // 环形图：每段画成扇环路径（外弧 → 内弧）。不用描边 + dasharray：很小的一段在圆的起点附近会画成变形的块并压住相邻段
    const [R, r] = [54, 32];
    const point = (angle: number, radius: number) => `${60 + radius * Math.sin(angle)},${60 - radius * Math.cos(angle)}`;
    const arc = (from: number, to: number) => {
      // 只有一类时是整圆，起止点重合会画不出来，留一丝缺口
      const end = Math.min(to, from + 2 * Math.PI - 1e-4);
      const large = end - from > Math.PI ? 1 : 0;
      return `M${point(from, R)} A${R} ${R} 0 ${large} 1 ${point(end, R)} L${point(end, r)} A${r} ${r} 0 ${large} 0 ${point(from, r)} Z`;
    };
    const svg = el("svg", { viewBox: "0 0 120 120", class: "pie" });
    const legend = document.createElement("ul");

    // 扇区与图例行互相联动：hover 任一方，两边一起高亮
    const focus = (name: string | null) => {
      svg.querySelectorAll<SVGPathElement>(".seg").forEach((s) => s.classList.toggle("faded", name !== null && s.dataset.name !== name));
      legend.querySelectorAll<HTMLLIElement>("li").forEach((li) => li.classList.toggle("on", li.dataset.name === name));
    };

    let start = 0;
    positive.forEach((it) => {
      const sweep = (it.v / total) * 2 * Math.PI;
      const seg = el("path", { d: arc(start, start + sweep), fill: it.color, class: positive.length === 1 ? "seg full" : "seg", "data-name": it.name });
      seg.addEventListener("mousemove", (e) => {
        focus(it.name);
        showTip(e as MouseEvent, title, [[it.color, it.name, `${yen(it.v)}　${pct(it.v)}`]]);
      });
      seg.addEventListener("mouseleave", () => {
        focus(null);
        hideTip();
      });
      svg.append(seg);
      start += sweep;
    });

    items
      .filter((it) => it.v !== 0)
      .forEach((it) => {
        const li = document.createElement("li");
        li.dataset.name = it.name;
        li.innerHTML = `<i style="background:${it.color}"></i><span></span><b>${yen(it.v)}</b><em>${pct(it.v)}</em>`;
        li.querySelector("span")!.textContent = it.name;
        li.addEventListener("mouseenter", () => focus(it.name));
        li.addEventListener("mouseleave", () => focus(null));
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

    hideTip();
    drawLine();
    drawPie("pie-daily", "日常", m.daily, PALETTE.daily);
    drawPie("pie-buy", "买取", m.buy, PALETTE.buy);
  }

  if (months.length === 0) return;

  $("prev").addEventListener("click", () => select(selected - 1));
  $("next").addEventListener("click", () => select(selected + 1));
  drawLegend();
  select(selected);
}

const STYLE = `
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 48px; background:#f8fafc; color:#1f2937; font:14px/1.6 -apple-system,"Hiragino Sans","PingFang SC",sans-serif; }
main { max-width:960px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 12px; }
.card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; }
#legend { display:flex; gap:6px; margin-bottom:4px; }
#legend button { border:1px solid transparent; background:none; border-radius:999px; padding:2px 10px; font:inherit; font-size:13px; color:#374151; cursor:pointer; }
#legend button:hover { background:#f1f5f9; }
#legend button.off { color:#9ca3af; text-decoration:line-through; }
#legend button.off i { opacity:.3; }
i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:middle; }
#line svg { width:100%; display:block; }
.series { transition:opacity .15s; }
.series.faded { opacity:.12; }
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
.pie { width:140px; flex:none; overflow:visible; }
.seg { cursor:pointer; stroke:#fff; stroke-width:1; transform-origin:60px 60px; transition:opacity .15s, transform .15s; }
.seg:hover { transform:scale(1.06); }
/* 只有一类时是整圆，分隔用的白边会在顶端露出一道缝 */
.seg.full { stroke:none; }
.seg.faded { opacity:.25; }
ul { list-style:none; margin:0; padding:0; flex:1; font-size:13px; }
li { display:grid; grid-template-columns:auto 1fr auto 3em; align-items:center; gap:6px; padding:3px 6px; border-bottom:1px solid #f1f5f9; border-radius:4px; cursor:default; }
li.on { background:#f1f5f9; }
li b { font-weight:500; font-variant-numeric:tabular-nums; }
li em { font-style:normal; color:#6b7280; text-align:right; }
.none { color:#9ca3af; }
#tip { position:fixed; display:none; pointer-events:none; z-index:10; background:#fff; border:1px solid #e5e7eb; border-radius:8px; box-shadow:0 4px 16px rgba(15,23,42,.12); padding:8px 10px; font-size:12px; min-width:150px; }
#tip strong { display:block; margin-bottom:4px; font-size:13px; }
#tip div { display:flex; align-items:center; gap:4px; line-height:1.8; }
#tip b { margin-left:auto; padding-left:12px; font-weight:600; font-variant-numeric:tabular-nums; }
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
