import type { Page, Request } from "playwright-core";
import { decode, parseCsv, toRecords } from "../text";
import { debugError, monthOf, onLoginPage, pageFetch, settle, type Card, type Skip } from "./util";

// 接口路径、请求体、req-id 的行为都已在真实账户上只读观察确认（2026-10）
const DETAILS = "https://www.aeon.co.jp/app/details/";
const isBilling = (r: Request) => r.url().includes("/usedetail/GetBillingPriceUseDetail");
// 浏览器不允许 fetch 自行设置的请求头；HTTP/2 伪头（:authority 等）传给 fetch 会直接报 Invalid name
const FORBIDDEN = /^(:|cookie|host|content-length|origin|referer|user-agent|accept-encoding|connection|sec-)/i;
// Web 可回溯 24 个月，但只取最近 6 个月：用户不需要更早的历史，且首次同步少发请求，降低被当成异常访问的风险（AEON 封号不可恢复）
const MAX_MONTHS = 6;

// 官方 CSV 每次下载都要输有效期 + 安全码，所以改为复用明细页自己发出的接口请求（含认证头），换个月份重放
// ponytail: 只取页面默认选中的那张卡，持多张 AEON 卡时再加切卡
// open() 打开明细页时，页面已经自己请求过一次最新月；把这次请求留给 fetch 用，不再导航，避免同一个月被请求两次
let pageRequest: Promise<Request | null> = Promise.resolve(null);

async function* fetch(page: Page, skip: Skip) {
  console.log("  等待明细页发出账单请求；一直没反应的话，请在 Chrome 里点开「ご利用明細」里最新的已确定月份（打开页面后最多等 60 秒）");

  const req = await pageRequest;
  if (!req) throw new Error("没等到明细页的账单请求");

  // 页面自己那次请求不带月份，响应里是最新的已确定月，直接用它的响应，不再重发
  const firstBytes = new Uint8Array((await (await req.response())?.body()) ?? []);
  const latest = tryJson(decode(firstBytes))?.billingYearMonth;
  if (!latest) throw await debugError("aeon", firstBytes, "txt", "账单接口响应里没有 billingYearMonth");

  const headers = Object.fromEntries(Object.entries(await req.allHeaders()).filter(([k]) => !FORBIDDEN.test(k)));
  const body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
  const base = new Date(Number(latest.slice(0, 4)), Number(latest.slice(4)) - 1, 1);

  // 更早的月份：照页面切换月份时的样子重放请求
  const replay = async (month: string, isFirstReplay: boolean): Promise<Uint8Array | null> => {
    // 页面上是人点一下发一次；连发容易被当成异常访问，而 AEON 的 ID 被封后不可恢复
    await Bun.sleep(1_500);

    return pageFetch(page, req.url(), {
      method: "POST",
      // 实测页面每次请求的 req-id 都是新的 UUID，重放同一个可能被拒或被标记
      headers: { ...headers, "req-id": crypto.randomUUID() },
      body: JSON.stringify({ ...body, billingYearMonth: month.replace("-", "") }),
    })
      .then((res) => res.bytes)
      .catch(async (e: Error & { bytes?: Uint8Array }) => {
        // 往前查到头时请求会失败，当作历史结束；第一次重放就失败（接口不通）或 401/403（会话失效）要算失败
        if (isFirstReplay || /^HTTP 40[13]/.test(e.message)) throw e.bytes ? await debugError("aeon", e.bytes, "txt", e.message) : e;
        console.log(`  ${month} 请求失败，停止往前查：${e.message}`);
        return null;
      });
  };

  // 中间可能有已入库被跳过的月份，所以按实际发出的次数判断是不是第一次重放
  let replays = 0;

  for (let i = 0; i < MAX_MONTHS; i++) {
    const month = monthOf(-i, base);
    if (skip("", month)) continue;

    const bytes = i === 0 ? firstBytes : await replay(month, replays++ === 0);
    if (!bytes) break;

    // 会话失效时可能返回 200 的 HTML 或错误码，入库后早于上月的月份会被永久跳过，所以先确认成功（实测成功为 "00"）
    const code = tryJson(decode(bytes))?.resultCode;
    if (code !== "00") throw await debugError("aeon", bytes, "txt", `账单接口返回异常（resultCode=${code ?? "非 JSON"}）`);
    yield { account: "", month, bytes, ext: "json" };
  }
}

// 会话失效时响应可能是 HTML，解析失败返回 undefined
const tryJson = (text: string): { billingYearMonth?: string; resultCode?: string } | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
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
    pageRequest = page.waitForRequest(isBilling, { timeout: 60_000 }).catch(() => null);
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
