import type { Page } from "playwright-core";
import { csvRecords } from "../text";
import { debugError, onLoginPage, pageFetch, settle, type Card } from "./util";

const STATEMENT = "https://www.rakuten-card.co.jp/e-navi/members/statement/index.xhtml";
// 切换卡的下拉 id 随改版变过（j_idt609:card / cardChangeForm:cardtype）
const CARD_SELECT = 'select[id$=":card"], select[id$=":cardtype"]';
// 可回溯 15 个月
const MAX_TABS = 15;

// 刚登录完、切卡后页面会自己再跳一次同一地址，goto 会报 interrupted，等它跳完即可
async function goTab(page: Page, tab: number) {
  await page.goto(`${STATEMENT}?tabNo=${tab}`).catch((e: Error) => {
    if (!e.message.includes("interrupted by another navigation")) throw e;
  });
  await settle(page);
}

async function openTab(page: Page, tab: number, card: string | null) {
  await goTab(page, tab);

  const select = page.locator(CARD_SELECT).first();
  if (card === null || (await select.inputValue()) === card) return;

  // 切卡会重新加载页面，切完回到目标 tab
  await select.selectOption(card);
  await settle(page);
  await goTab(page, tab);
}

// tabNo=0 是下月未确定的账单，从 1 开始都是已出账单。
// 月份只有下载后才能从文件名得知，所以每次都全部下载，靠 hash 判断有无变化（每张卡最多 15 个小文件）
async function* fetch(page: Page) {
  await goTab(page, 1);

  const select = page.locator(CARD_SELECT).first();
  const options = (await select.count()) > 0 ? await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value)) : [null];

  for (const card of options) {
    for (let tab = 1; tab <= MAX_TABS; tab++) {
      await openTab(page, tab, card);

      const href = await page.locator(".stmt-csv-btn").first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
      // 没有 CSV 按钮有两种情况：被踢到验证页 / 登录页要算失败；仍在明细页说明该月无账单，继续往前翻，避免中间空一个月就丢掉更早的历史
      if (!href && (!page.url().startsWith(STATEMENT) || (await onLoginPage(page)))) throw new Error("同步途中离开了明细页：可能是验证页或会话失效");
      if (!href) continue;

      const { headers, bytes } = await pageFetch(page, new URL(href, page.url()).href);

      // 文件名形如 enavi202412(4071).csv：请求月 + 卡号末 4 位
      const disposition = decodeURIComponent(headers["content-disposition"] ?? "");
      const [, year, month, last4] = /enavi(\d{4})(\d{2})\((\d{4})\)/.exec(disposition) ?? [];
      // 不知道月份和卡号就进不了 data/raw
      if (!last4) throw await debugError("rakuten", bytes, "csv", `CSV 文件名不符合预期：${disposition || "(无 content-disposition)"}`);

      yield { account: last4, month: `${year}-${month}`, bytes, ext: "csv" };
    }
  }
}

export const rakuten: Card = {
  url: `${STATEMENT}?tabNo=1`,
  open: async (page) => {
    await goTab(page, 1);

    // 未登录会被重定向到楽天ID 登录页
    return page.url().startsWith(STATEMENT);
  },
  fetch,
  parse: csvRecords,
};
