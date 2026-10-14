import type { Page } from "playwright-core";
import { csvRecords, decode } from "../text";
import { debugError, download, settle, type Card, type Skip } from "./util";

const DASHBOARD = "https://global.americanexpress.com/dashboard";
const STATEMENT = "https://global.americanexpress.com/activity/statement";
// 没登录时 dashboard 会按浏览器语言跳登录页，中文 Chrome 会跳到不存在的 zh-cn 页面（404），所以直接给日文登录页
const LOGIN = "https://www.americanexpress.com/ja-jp/account/login";
const DOCUMENTS = "https://global.americanexpress.com/api/servicing/v1/financials/documents";
// 只取最近 6 个已确定账单期：用户不需要更早的历史，首次同步也少发请求
const MAX_PERIODS = 6;

// Amex 页面禁用了 eval，page.evaluate（以及基于它的 pageFetch）都会失败，所以完全照页面自己的行为来：
// 账单期取自明细页自己发出的 statement_periods 请求；CSV 照「ダウンロード」按钮的方式导航下载（只带 cookie）。
// 以上均在真实账户上只读观察确认（2026-10）
// ponytail: 只取页面默认的那张卡，持多张 Amex 时再按卡遍历
async function* fetch(page: Page, skip: Skip) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => /\/financials\/statement_periods$/.test(new URL(r.url()).pathname) && r.status() === 200, { timeout: 30_000 }),
    page.goto(STATEMENT),
  ]);
  // 下载要的 account_key（32 位）和请求头里的 account_token（15 位）不是一回事，用错会 400。
  // 实测明细页的地址栏会带上 account_key；没带的话再找页面上带它的链接
  await page.waitForURL(/account_key=/, { timeout: 10_000 }).catch(() => {});
  const href = new URL(page.url()).searchParams.has("account_key")
    ? page.url()
    : await page.locator("a[href*='account_key=']").first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
  const key = href ? new URL(href, page.url()).searchParams.get("account_key") : null;
  if (!key) throw new Error("明细页上找不到 account_key");

  const periods = (await res.json()) as { statement_end_date: string }[];
  const today = new Date().toLocaleDateString("sv-SE");

  // 締め日还没过的是当期，未确定
  const closed = periods.map((p) => p.statement_end_date).filter((end) => end < today);
  const recent = closed.sort().reverse().slice(0, MAX_PERIODS);

  for (const end of recent) {
    const month = end.slice(0, 7);
    if (skip("", month)) continue;

    // 页面上是人点一下发一次，别连发
    await Bun.sleep(1_500);

    // 参数照页面下载按钮；页面的 limit 等于该期笔数，这里给足上限
    const query = new URLSearchParams({ file_format: "csv", limit: "1000", status: "posted", statement_end_date: end, account_key: key, client_id: "AmexAPI" });
    const url = `${DOCUMENTS}?${query}`;

    // 页面的下载请求带 Referer（明细页），照着带上；下载失败时把服务器实际返回的状态和内容留到 data/debug
    const response = page.waitForResponse((r) => r.url() === url, { timeout: 30_000 }).catch(() => null);
    const { bytes } = await download(page, () => page.goto(url, { referer: STATEMENT }).catch(() => {})).catch(async (e: Error) => {
      const r = await response;
      if (!r) throw e;
      throw await debugError("amex", new Uint8Array(await r.body().catch(() => Buffer.from(""))), "txt", `documents 没有返回文件（HTTP ${r.status()}）`);
    });

    // 会话失效时可能返回 HTML，入库后早于上月的月份会被永久跳过
    if (decode(bytes).trimStart().startsWith("<")) throw await debugError("amex", bytes, "html", "documents 返回了 HTML：会话可能失效");
    yield { account: "", month, bytes, ext: "csv" };
  }
}

export const amex: Card = {
  url: LOGIN,
  open: async (page) => {
    await page.goto(DASHBOARD).catch(() => {});
    await settle(page);

    const { hostname, pathname } = new URL(page.url());
    const loggedIn = hostname === "global.americanexpress.com" && pathname.startsWith("/dashboard");
    if (!loggedIn) await page.goto(LOGIN).catch(() => {});

    return loggedIn;
  },
  fetch,
  parse: csvRecords,
};
