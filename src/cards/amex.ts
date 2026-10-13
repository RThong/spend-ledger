import type { Page } from "playwright-core";
import { csvRecords, decode } from "../text";
import { pageFetch, settle, type Card, type Skip } from "./util";

const DASHBOARD = "https://global.americanexpress.com/dashboard";
const API = "https://global.americanexpress.com/api/servicing/v1/financials";

// 接口来自 mizzy/amexcsv（JP，2026-06）和 woob 的 americanexpress 模块，非公开 API
// ponytail: 只取「ご利用履歴」链接里的第一个 account_key，持多张 Amex 时再按卡遍历
async function* fetch(page: Page, skip: Skip) {
  const href = await page.getByTitle("ご利用履歴").first().getAttribute("href");
  const key = href ? new URL(href, page.url()).searchParams.get("account_key") : null;
  if (!key) throw new Error("找不到 account_key（dashboard 上「ご利用履歴」链接）");

  const headers = { account_token: key };
  const periods = JSON.parse(decode((await pageFetch(page, `${API}/statement_periods`, { headers })).bytes)) as { statement_end_date: string }[];
  const today = new Date().toLocaleDateString("sv-SE");

  for (const { statement_end_date: end } of periods) {
    const month = end.slice(0, 7);

    // 締め日还没过的是当期，未确定
    if (end >= today || skip("", month)) continue;

    const query = new URLSearchParams({ file_format: "csv", limit: "1000", status: "posted", account_key: key, statement_end_date: end });
    const { bytes } = await pageFetch(page, `${API}/documents?${query}`, { headers });

    yield { account: "", month, bytes, ext: "csv" };
  }
}

export const amex: Card = {
  url: DASHBOARD,
  open: async (page) => {
    await page.goto(DASHBOARD);
    await settle(page);

    const { hostname, pathname } = new URL(page.url());
    return hostname === "global.americanexpress.com" && pathname.startsWith("/dashboard");
  },
  fetch,
  parse: csvRecords,
};
