import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BrowserContext, Page } from "playwright-core";
import { cards } from "./cards";
import { monthOf, type Fetched } from "./cards/util";
import { loginInPlainChrome, openChrome } from "./chrome";
import { hasStatement, openDb, saveStatement, type SaveResult } from "./db";
import { decode, isUtf8, parseCsv, shape } from "./text";

const DATA = resolve(import.meta.dir, "../data");
const PROFILE = `${DATA}/chrome-profile`;
const syncable = Object.keys(cards).filter((id) => cards[id]!.fetch);

const USAGE = `用法：
  bun run sync [${syncable.join("|")} ...]            自动同步（默认全部）
  bun run login [卡 ...]                              兜底：在普通 Chrome 里登录，完成后 Cmd+Q，再跑 sync
  bun run import <卡> <文件> --month YYYY-MM [--account X]   手动导入（PayPay 走这个）
  bun run inspect <文件>                              输出脱敏后的格式信息，可放心贴出来`;

const LABEL: Record<SaveResult, string> = { new: "新增", updated: "已更正", unchanged: "无变化" };

// 原始文件路径带 hash 前缀：卡公司更正账单时旧版本也保留
async function ingest(db: Database, card: string, { account, month, bytes, ext }: Fetched): Promise<SaveResult> {
  const rows = cards[card]!.parse(bytes);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const rawPath = `raw/${card}/${account.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "_"}/${month}.${sha256.slice(0, 8)}.${ext}`;

  await Bun.write(`${DATA}/${rawPath}`, bytes);
  const result = saveStatement(db, { card, account, month, sha256, rawPath }, rows);

  console.log(`  ${month} ${account}：${LABEL[result]}（${rows.length} 行）`);
  return result;
}

// 失败现场留在本机。截图和 HTML 可能含个人信息，终端只打印页面路径和可点击元素的文字，方便贴出来排查选择器
async function dumpDebug(page: Page, id: string): Promise<string> {
  const base = `${DATA}/debug/${id}-${Date.now()}`;

  await Bun.write(`${base}.html`, await page.content().catch(() => ""));
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  const labels = await page
    .locator("a, button, select, input[type=submit], input[type=button]")
    .evaluateAll((els) =>
      els.map((e) => ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute("name") || "").trim().slice(0, 30)),
    )
    .catch(() => [] as string[]);

  return [
    `    页面：${new URL(page.url()).pathname}`,
    `    现场：${base}.png / .html（本机查看，别外传）`,
    `    可点击元素：${[...new Set(labels.filter(Boolean))].slice(0, 40).join(" | ")}`,
  ].join("\n");
}

async function syncCard(db: Database, context: BrowserContext, id: string): Promise<string> {
  const card = cards[id]!;
  if (!card.open || !card.fetch) return `只能手动导入：bun run import ${id} <文件> --month YYYY-MM`;

  const page = await context.newPage();

  try {
    if (!(await card.open(page))) {
      const answer = prompt(`  请在弹出的 Chrome 里登录 ${id}（含 OTP），完成后回车；输入 s 跳过：`);
      if (answer?.trim() === "s") return "跳过";
      if (!(await card.open(page))) return "未登录（如果登录被拒，试试 bun run login）";
    }

    // 上月和本月总是重新下载：月初最新账单可能还没确定，靠 hash 决定是否替换；更早的已入库就跳过
    const recent = monthOf(-1);
    const skip = (account: string, month: string) => month < recent && hasStatement(db, id, account, month);
    const counts: Record<SaveResult, number> = { new: 0, updated: 0, unchanged: 0 };

    for await (const statement of card.fetch(page, skip)) counts[await ingest(db, id, statement)]++;

    return `新增 ${counts.new}，更正 ${counts.updated}，无变化 ${counts.unchanged}`;
  } catch (e) {
    return `失败：${String((e as Error).message).split("\n")[0]}\n${await dumpDebug(page, id)}`;
  } finally {
    await page.close().catch(() => {});
  }
}

function pickCards(args: string[], allowed: string[]): string[] {
  const ids = args.length > 0 ? args : allowed;
  const unknown = ids.filter((id) => !allowed.includes(id));

  if (unknown.length > 0) throw new Error(`不支持：${unknown.join(", ")}（可选：${allowed.join(", ")}）`);
  return ids;
}

async function sync(args: string[]) {
  const ids = pickCards(args, syncable);
  const db = openDb(`${DATA}/ledger.db`);
  const { browser, close } = await openChrome(PROFILE);
  const results: [string, string][] = [];

  // 逐家串行：同一个浏览器里可能要人工登录，并行会乱。单家失败不影响其他家
  try {
    for (const id of ids) {
      console.log(`\n[${id}]`);
      results.push([id, await syncCard(db, browser.contexts()[0]!, id)]);
    }
  } finally {
    await close();
  }

  console.log("\n汇总");
  results.forEach(([id, result]) => console.log(`  ${id}：${result}`));
}

async function login(args: string[]) {
  const urls = pickCards(args, syncable).map((id) => cards[id]!.url!);

  console.log("在打开的 Chrome 里逐个登录（含 OTP），全部完成后在该 Chrome 里按 Cmd+Q 退出，再运行 bun run sync");
  await loginInPlainChrome(PROFILE, urls);
}

async function importFile(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { month: { type: "string" }, account: { type: "string", default: "" } },
  });
  const [card, file] = positionals;

  if (!card || !cards[card] || !file || !/^\d{4}-\d{2}$/.test(values.month ?? "")) throw new Error(USAGE);

  const bytes = await Bun.file(file).bytes();
  const ext = file.split(".").pop()?.toLowerCase() ?? "csv";

  await ingest(openDb(`${DATA}/ledger.db`), card, { account: values.account ?? "", month: values.month!, bytes, ext });
}

// 已知列名照原样显示（不含个人信息），其余值一律脱敏成形状
const KNOWN_COLUMNS = new Set([
  "利用日", "利用店名・商品名", "利用者", "支払方法", "利用金額", "手数料/利息", "支払総額", "支払月", "当月請求額", "新規サイン", "支払手数料",
  "ご利用日", "データ処理日", "ご利用内容", "カード会員様名", "会員番号 #", "金額", "海外通貨利用金額", "換算レート",
  "利用日/キャンセル日", "決済方法", "支払区分", "手数料", "当月支払金額", "翌月以降繰越金額", "調整額", "当月お支払日",
  "利用者区分", "ご利用先", "ご利用金額", "備考",
]);
const mask = (cell: string) => (KNOWN_COLUMNS.has(cell.trim()) || /^\d{1,2}月\S*$/.test(cell.trim()) ? cell : shape(cell));

// JSON 只保留键名、数组长度和值的形状
const describe = (v: unknown): unknown => {
  if (Array.isArray(v)) return [`${v.length} 项`, ...v.slice(0, 2).map(describe)];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, describe(x)]));
  return typeof v === "string" ? shape(v) : typeof v;
};

async function inspect([file]: string[]) {
  if (!file) throw new Error(USAGE);

  const bytes = await Bun.file(file).bytes();
  const text = decode(bytes);
  console.log(`编码：${isUtf8(bytes) ? "UTF-8" : "Shift_JIS (cp932)"}，${bytes.length} 字节，BOM：${bytes[0] === 0xef ? "有" : "无"}`);

  if (file.endsWith(".json")) {
    console.log(JSON.stringify(describe(JSON.parse(text)), null, 2));
    return;
  }

  const rows = parseCsv(text);
  const widths = rows.reduce((acc, r) => acc.set(r.length, (acc.get(r.length) ?? 0) + 1), new Map<number, number>());

  console.log(`行数：${rows.length}，列数分布：${[...widths].map(([w, n]) => `${w} 列×${n}`).join("，")}`);
  rows.slice(0, 12).forEach((r, i) => console.log(`${i}: ${r.map(mask).join(" | ")}`));
}

const commands: Record<string, (args: string[]) => Promise<void>> = { sync, login, import: importFile, inspect };
const [command = "", ...rest] = process.argv.slice(2);
const run = commands[command];

if (!run) {
  console.log(USAGE);
  process.exit(1);
}

await run(rest).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
