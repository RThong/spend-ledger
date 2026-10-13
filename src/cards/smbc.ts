import type { Page } from "playwright-core";
import { decode, parseCsv } from "../text";
import { download, monthOf, settle, type Card, type Skip } from "./util";

const TOP = "https://www.smbc-card.com/memx/web_meisai/top/index.html";
const CARD_SELECT = 'select[name="vp-view-VC0205-001_RS0051_cardIdentifyKey"]';
const DATE = /^\d{4}\/\d{1,2}\/\d{1,2}$/;

const monthSelect = (page: Page) => page.locator(`select:not(${CARD_SELECT})`).filter({ has: page.locator('option[value^="20"]') }).first();

// 卡下拉的 value 每次加载都会变，只能按显示名选
async function openCard(page: Page, card: string) {
  await page.goto(TOP);
  await settle(page);
  await page.locator(CARD_SELECT).selectOption({ label: card });
  await settle(page);
}

async function* fetch(page: Page, skip: Skip) {
  const cards = await page.locator(`${CARD_SELECT} option`).evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).label));

  for (const card of cards) {
    await openCard(page, card);

    const values = await monthSelect(page).locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const months = values.filter((v) => /^20\d{4}$/.test(v));

    for (const value of months) {
      const month = `${value.slice(0, 4)}-${value.slice(4)}`;

      // 下拉里是支付月：未来的支付月还是「ご利用速報」（未确定），不要
      if (month > monthOf() || skip(card.trim(), month)) continue;

      await openCard(page, card);
      await monthSelect(page).selectOption(value);
      await page.locator('input[value="照会"], button:has-text("照会")').first().click();
      await settle(page);

      // 该月没有明细时没有 CSV 链接
      const csv = page.locator("a", { hasText: "CSV形式で保存する" }).first();
      if ((await csv.count()) === 0) continue;

      const { bytes } = await download(page, () => csv.click());
      yield { account: card.trim(), month, bytes, ext: "csv" };
    }
  }
}

// Vpass CSV 没有表头，按卡分段：段头「氏名 様,卡号,卡名」→ 明细行 → 合计行（首列为空）。
// ponytail: 没有表头就不臆造列名，按位置原样存；店名里可能有不带引号的逗号，所以列数不固定，分析时从右往左取金额
function parse(bytes: Uint8Array): object[] {
  const rows: object[] = [];
  let section: string[] = [];

  for (const cols of parseCsv(decode(bytes))) {
    if (DATE.test(cols[0] ?? "")) rows.push({ section, cols });
    else if (cols[0]) section = cols;
  }

  return rows;
}

export const smbc: Card = {
  url: TOP,
  open: async (page) => {
    await page.goto(TOP);
    await settle(page);

    return (await page.locator(CARD_SELECT).count()) > 0;
  },
  fetch,
  parse,
};
