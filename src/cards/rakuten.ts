import type { Page } from "playwright-core";
import { csvRecords } from "../text";
import { pageFetch, settle, type Card } from "./util";

const STATEMENT = "https://www.rakuten-card.co.jp/e-navi/members/statement/index.xhtml";
// 切换卡的下拉 id 随改版变过（j_idt609:card / cardChangeForm:cardtype）
const CARD_SELECT = 'select[id$=":card"], select[id$=":cardtype"]';
// 可回溯 15 个月
const MAX_TABS = 15;

async function openTab(page: Page, tab: number, card: string | null) {
  await page.goto(`${STATEMENT}?tabNo=${tab}`);
  await settle(page);

  const select = page.locator(CARD_SELECT).first();
  if (card === null || (await select.inputValue()) === card) return;

  // 切卡会重新加载页面，切完回到目标 tab
  await select.selectOption(card);
  await settle(page);
  await page.goto(`${STATEMENT}?tabNo=${tab}`);
  await settle(page);
}

// tabNo=0 是下月未确定的账单，从 1 开始都是已出账单。
// 月份只有下载后才能从文件名得知，所以每次都全部下载，靠 hash 判断有无变化（每张卡最多 15 个小文件）
async function* fetch(page: Page) {
  await page.goto(`${STATEMENT}?tabNo=1`);
  await settle(page);

  const select = page.locator(CARD_SELECT).first();
  const options = (await select.count()) > 0 ? await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)) : [null];

  for (const card of options) {
    for (let tab = 1; tab <= MAX_TABS; tab++) {
      await openTab(page, tab, card);

      const href = await page.locator(".stmt-csv-btn").first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
      if (!href) break;

      const { headers, bytes } = await pageFetch(page, new URL(href, page.url()).href);

      // 文件名形如 enavi202412(4071).csv：请求月 + 卡号末 4 位
      const disposition = decodeURIComponent(headers["content-disposition"] ?? "");
      const [, year, month, last4] = /enavi(\d{4})(\d{2})\((\d{4})\)/.exec(disposition) ?? [];
      if (!last4) throw new Error(`CSV 文件名不符合预期：${disposition || "(无 content-disposition)"}`);

      yield { account: last4, month: `${year}-${month}`, bytes, ext: "csv" };
    }
  }
}

export const rakuten: Card = {
  url: `${STATEMENT}?tabNo=1`,
  open: async (page) => {
    await page.goto(`${STATEMENT}?tabNo=1`);
    await settle(page);

    // 未登录会被重定向到楽天ID 登录页
    return page.url().startsWith(STATEMENT);
  },
  fetch,
  parse: csvRecords,
};
