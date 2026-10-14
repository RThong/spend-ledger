import type { Database } from "bun:sqlite";
import { extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { BrowserContext, Page } from "playwright-core";
import { cards } from "./cards";
import { DATA, monthOf, type Fetched } from "./cards/util";
import { loginInPlainChrome, openChrome } from "./chrome";
import { hasStatement, openDb, saveStatement, type SaveResult } from "./db";
import { decode, isUtf8, parseCsv, shape } from "./text";

const PROFILE = `${DATA}/chrome-profile`;
const syncable = Object.keys(cards).filter((id) => cards[id]!.fetch);

const USAGE = `用法：
  bun run sync [${syncable.join("|")} ...]            自动同步（默认全部）
  bun run login [卡 ...]                              兜底：在普通 Chrome 里登录，完成后 Cmd+Q，再跑 sync
  bun run import <卡> <文件> --month YYYY-MM [--account X] [--force]   手动导入（PayPay 走这个）；--force 强制重新解析已入库的同一份文件
  bun run inspect <文件>                              输出脱敏后的格式信息，可放心贴出来`;

// 不用同步的 prompt()：它会卡住事件循环，Playwright 处理不了 CDP 消息，登录页里新开的 iframe / 弹窗会一直挂起
async function ask(question: string): Promise<string> {
  // 输入流已经结束过（前一家卡就没拿到输入），新建的 readline 不会再触发 close
  if (process.stdin.readableEnded) throw new Error("没有终端输入，无法等待人工登录");

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 没有终端输入（cron、< /dev/null）时 question 永远不返回；输入流一结束就判失败，好让 sync 收尾关掉 Chrome
  try {
    return await new Promise((resolve, reject) => {
      rl.once("close", () => reject(new Error("没有终端输入，无法等待人工登录")));
      rl.question(question).then(resolve, reject);
    });
  } finally {
    rl.close();
  }
}

const LABEL: Record<SaveResult, string> = { new: "新增", updated: "已更正", unchanged: "无变化" };

// 原始文件路径带 hash 前缀：卡公司更正账单时旧版本也保留
async function ingest(db: Database, card: string, { account, month, bytes, ext }: Fetched, force = false): Promise<{ result: SaveResult; rows: number }> {
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const rawPath = `raw/${card}/${account.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "_"}/${month}.${sha256.slice(0, 8)}.${ext}`;

  // 先归档再解析：格式变了解析失败时，原始文件还在，可以拿来 inspect
  await Bun.write(`${DATA}/${rawPath}`, bytes);
  const rows = cards[card]!.parse(bytes);
  const result = saveStatement(db, { card, account, month, sha256, rawPath }, rows, force);

  console.log(`  ${`${month} ${account}`.trim()}：${LABEL[result]}（${rows.length} 行）`);
  return { result, rows: rows.length };
}

// 从保存下来的 HTML 里取可点击元素的文字。不在页面里执行 JS：Amex 禁用了 eval，page.evaluate 会失败。
// 不含 select：卡选择下拉的选项里有卡名、卡号末位
function clickableLabels(html: string): string[] {
  const labels: string[] = [];

  new HTMLRewriter()
    .on("a, button", {
      element: () => void labels.push(""),
      text: (t) => void (labels[labels.length - 1] += t.text),
    })
    .on("input[type=submit], input[type=button]", { element: (el) => void labels.push(el.getAttribute("value") ?? "") })
    .transform(html);

  return labels.map((l) => l.replace(/\s+/g, " ").trim().slice(0, 30));
}

// 失败现场留在本机。截图和 HTML 可能含个人信息，终端只打印页面路径和可点击元素的文字，方便贴出来排查选择器
async function dumpDebug(page: Page, id: string): Promise<string> {
  const base = `${DATA}/debug/${id}-${Date.now()}`;

  const html = await page.content().catch(() => "");
  await Bun.write(`${base}.html`, html);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  const labels = clickableLabels(html);

  return [
    `    页面：${new URL(page.url()).pathname}`,
    `    现场：${base}.png / .html（本机查看，别外传）`,
    `    可点击元素：${[...new Set(labels.filter(Boolean))].slice(0, 40).join(" | ")}`,
  ].join("\n");
}

async function syncCard(db: Database, context: BrowserContext, id: string): Promise<string> {
  const card = cards[id]!;
  if (!card.open || !card.fetch) return `只能手动导入：bun run import ${id} <文件> --month YYYY-MM`;

  // 浏览器被关掉时 newPage 会抛错，也要算这一家失败，而不是中断整个 sync
  const page = await context.newPage().catch((e: Error) => e);
  if (page instanceof Error) return `失败：${page.message.split("\n")[0]}`;

  try {
    if (!(await card.open(page))) {
      const answer = await ask(`  请在弹出的 Chrome 里登录 ${id}（含 OTP），完成后回车；输入 s 跳过：`);
      if (answer.trim() === "s") return "跳过";
      // 抛出去走 catch，留下现场方便排查为什么登录没生效
      if (!(await card.open(page))) throw new Error("未登录（如果登录被拒，试试 bun run login）");
    }

    // 上月和本月总是重新下载：月初最新账单可能还没确定，靠 hash 决定是否替换；更早的已入库就跳过
    const recent = monthOf(-1);
    const skip = (account: string, month: string) => month < recent && hasStatement(db, id, account, month);
    const counts: Record<SaveResult, number> = { new: 0, updated: 0, unchanged: 0 };
    const empty: string[] = [];

    for await (const statement of card.fetch(page, skip)) {
      const { result, rows } = await ingest(db, id, statement);
      counts[result]++;
      if (rows === 0) empty.push(`${statement.month} ${statement.account}`.trim());
    }

    // 选择器失效时各家都会「一个文件都没找到」而正常结束，不能汇总成成功
    if (counts.new + counts.updated + counts.unchanged === 0) throw new Error("一个账单都没取到：选择器可能已失效");

    // 0 行可能是当月确实没消费，也可能是解析器猜错了格式，单独列出来人工核对（修好后用 import --force 重解析）
    const summary = `新增 ${counts.new}，更正 ${counts.updated}，无变化 ${counts.unchanged}`;
    return empty.length > 0 ? `${summary}；0 行，请核对：${empty.join("、")}` : summary;
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

  // kill / launchd 超时只发给 bun 进程，finally 不会执行，已登录且开着调试端口的 Chrome 会留下来
  ["SIGTERM", "SIGHUP"].forEach((signal) => process.once(signal, () => close().finally(() => process.exit(1))));

  // 逐家串行：同一个浏览器里可能要人工登录，并行会乱。单家失败不影响其他家
  try {
    for (const id of ids) {
      console.log(`\n[${id}]`);
      // CDP 断开（用户 Cmd+Q、Chrome 崩溃）后默认 context 会被移除，剩下的卡都记失败，汇总照常打印
      const context = browser.contexts()[0];
      results.push([id, context ? await syncCard(db, context, id) : "失败：浏览器已断开"]);
    }
  } finally {
    await close();
  }

  console.log("\n汇总");
  results.forEach(([id, result]) => console.log(`  ${id}：${result}`));

  // 放进 cron / 脚本时能发现失败
  if (results.some(([, result]) => result.startsWith("失败"))) process.exitCode = 1;
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
    options: { month: { type: "string" }, account: { type: "string", default: "" }, force: { type: "boolean", default: false } },
  });
  const [card, file] = positionals;

  if (!card || !cards[card] || !file || !/^\d{4}-(0[1-9]|1[0-2])$/.test(values.month ?? "")) throw new Error(USAGE);

  const bytes = await Bun.file(file).bytes();
  const ext = extname(file).slice(1).toLowerCase() || "csv";

  await ingest(openDb(`${DATA}/ledger.db`), card, { account: values.account ?? "", month: values.month!, bytes, ext }, values.force);
}

// 表头行里的已知列名照原样显示（不含个人信息），其余一律脱敏成形状
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
  return typeof v === "string" ? shape(v) : v === null ? "null" : typeof v;
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
  // 只有表头行豁免：数据格里也可能出现「3月分年会費」这类能命中规则的文字。三井住友没有表头，全部脱敏
  const head = rows.findIndex((r) => r.some((c) => KNOWN_COLUMNS.has(c.trim())));
  rows.slice(0, 12).forEach((r, i) => console.log(`${i}: ${r.map(i === head ? mask : shape).join(" | ")}`));
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
