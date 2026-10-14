import type { Page, Request } from "playwright-core";
import { decode, parseCsv, toRecords } from "../text";
import { debugError, monthOf, onLoginPage, pageFetch, settle, type Card, type Skip } from "./util";

// 路径来自公开书签脚本，未实测
const DETAILS = "https://www.aeon.co.jp/app/details/";
const isBilling = (r: Request) => r.url().includes("/usedetail/GetBillingPriceUseDetail");
// 浏览器不允许 fetch 自行设置的请求头；HTTP/2 伪头（:authority 等）传给 fetch 会直接报 Invalid name
const FORBIDDEN = /^(:|cookie|host|content-length|origin|referer|user-agent|accept-encoding|connection|sec-)/i;
// Web 可回溯 24 个月
const MAX_MONTHS = 24;

// 官方 CSV 每次下载都要输有效期 + 安全码，所以改为复用明细页自己发出的接口请求（含认证头），换个月份重放
// ponytail: 只取页面默认选中的那张卡，持多张 AEON 卡时再加切卡
async function* fetch(page: Page, skip: Skip) {
  console.log("  等待明细页发出账单请求；60 秒内没反应的话，请在 Chrome 里点开「ご利用明細」里最新的已确定月份");

  const [req] = await Promise.all([page.waitForRequest(isBilling, { timeout: 60_000 }), page.goto(DETAILS)]);
  const first = (await (await req.response())?.json()) as { billingYearMonth?: string } | undefined;

  // 不带月份请求时，响应里是最新已确定的请求月
  const latest = first?.billingYearMonth;
  if (!latest) throw new Error("账单接口响应里没有 billingYearMonth");

  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !FORBIDDEN.test(k)));
  const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
  const base = new Date(Number(latest.slice(0, 4)), Number(latest.slice(4)) - 1, 1);

  for (let i = 0; i < MAX_MONTHS; i++) {
    const month = monthOf(-i, base);
    if (skip("", month)) continue;

    const res = await pageFetch(page, req.url(), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, billingYearMonth: month.replace("-", "") }),
    }).catch((e: Error) => {
      // 往前查到头时请求会失败，当作历史结束；最新月就失败或 401/403（会话失效）要算失败
      if (i === 0 || /^HTTP 40[13]/.test(e.message)) throw e;
      console.log(`  ${month} 请求失败，停止往前查：${e.message}`);
      return null;
    });
    if (!res) break;

    // 会话失效时可能返回 200 的 HTML，入库后早于上月的月份会被永久跳过，所以先确认是 JSON
    if (!isJson(decode(res.bytes))) throw await debugError("aeon", res.bytes, "txt", "账单接口返回的不是 JSON：会话可能失效");
    yield { account: "", month, bytes: res.bytes, ext: "json" };
  }
}

const isJson = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// 明细数组的字段名没有文档（bundle 里见过 useDetailList），按「元素含 useDate 的数组」递归查找
const findRows = (v: unknown): object[] => {
  if (Array.isArray(v)) return v.some((x) => x && typeof x === "object" && "useDate" in x) ? v : v.flatMap(findRows);
  if (v && typeof v === "object") return Object.values(v).flatMap(findRows);
  return [];
};

// 官方 CSV 表头前有说明行、末尾有合计等非明细行：从「ご利用日」那行起算表头，只留首列是日期（数字开头）的行
function parseOfficialCsv(text: string): object[] {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r.some((c) => c.trim() === "ご利用日"));
  if (head < 0) return toRecords(rows);

  return toRecords([rows[head]!, ...rows.slice(head + 1).filter((r) => /^\d/.test(r[0]?.trim() ?? ""))]);
}

export const aeon: Card = {
  url: DETAILS,
  open: async (page) => {
    await page.goto(DETAILS);
    await settle(page);

    return !(await onLoginPage(page));
  },
  fetch,
  // 自动同步存的是接口 JSON；手动导入的是官方 CSV
  parse: (bytes) => {
    const text = decode(bytes);
    return text.trimStart().startsWith("{") ? findRows(JSON.parse(text)) : parseOfficialCsv(text);
  },
};
