import type { Page } from "playwright-core";

export type Fetched = { account: string; month: string; bytes: Uint8Array; ext: string };
export type Skip = (account: string, month: string) => boolean;

export type Card = {
  // 明细页入口，login 命令用它打开标签页
  url?: string;
  // 打开明细页，返回是否已登录。没有 open 的卡只能手动导入
  open?: (page: Page) => Promise<boolean>;
  // 只产出已确定的账单月；skip 为 true 的月份不必下载
  fetch?: (page: Page, skip: Skip) => AsyncGenerator<Fetched>;
  parse: (bytes: Uint8Array) => object[];
};

// SPA / JSF 页面没有可靠的「加载完成」信号，等网络空闲，最多 15 秒
export const settle = (page: Page) => page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

// 页面上有密码框 = 停在登录页
export const onLoginPage = async (page: Page) => (await page.locator('input[type="password"]').count()) > 0;

// 在页面里发请求：带着真实浏览器的 cookie 和指纹，比从 Node 侧请求更不容易被拦
export async function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ headers: Record<string, string>; bytes: Uint8Array }> {
  const res = await page.evaluate(
    async ([url, init]) => {
      const r = await fetch(url, { credentials: "include", ...init });
      const bytes = Array.from(new Uint8Array(await r.arrayBuffer()));

      return { status: r.status, headers: Object.fromEntries(r.headers), bytes };
    },
    [url, init] as const,
  );

  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);

  return { headers: res.headers, bytes: Uint8Array.from(res.bytes) };
}

export async function download(page: Page, trigger: () => Promise<unknown>): Promise<{ bytes: Uint8Array; filename: string }> {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), trigger()]);
  const bytes = await Bun.file(await d.path()).bytes();

  // 明细文件不留在 Playwright 的临时目录里
  await d.delete();

  return { bytes, filename: d.suggestedFilename() };
}

// 本地时区的 YYYY-MM，offset 为相对 from 所在月的月数
export function monthOf(offset = 0, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth() + offset, 1);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
