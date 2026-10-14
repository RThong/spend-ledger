import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE_ARGS = ["--no-first-run", "--no-default-browser-check"];

// 首次创建 profile 时打开「继续浏览上次打开的网页」：这样 Cmd+Q 退出后会话 cookie 会保留，login 命令依赖这一点。
// 只在创建时写：之后再改会被 Chrome 的受保护设置校验重置
function ensureProfile(profileDir: string) {
  if (!existsSync(`${profileDir}/Default/Preferences`)) {
    mkdirSync(`${profileDir}/Default`, { recursive: true });
    writeFileSync(`${profileDir}/Default/Preferences`, JSON.stringify({ session: { restore_on_startup: 1 } }));
  }

  chmodSync(profileDir, 0o700);
}

// 端口用 0 让 Chrome 自选，再从 profile 的 DevToolsActivePort 读 ws 地址：
// 固定 9222 会撞上日常 Chrome 开的远程调试（chrome://inspect），连到别的浏览器上
const wsUrl = async (profileDir: string) => {
  const file = Bun.file(`${profileDir}/DevToolsActivePort`);
  if (!(await file.exists())) return null;

  const [port, path] = (await file.text()).trim().split("\n");
  return port && path ? `ws://127.0.0.1:${port}${path}` : null;
};

// 用本机真实 Chrome + 独立 profile，而不是 Playwright 启动的浏览器：后者的登录会被 Amex / Akamai(Vpass) 拒绝（403）。
// 用户在里面手动登录，工具不接触密码。Chrome 136+ 不允许对默认 profile 开调试端口，所以必须独立 profile
export async function openChrome(profileDir: string): Promise<{ browser: Browser; close: () => Promise<void> }> {
  ensureProfile(profileDir);

  // 上次异常退出残留的文件会指向已关闭的端口
  rmSync(`${profileDir}/DevToolsActivePort`, { force: true });

  // 调试端口会让 navigator.webdriver 为 true，楽天登录会因此一直转圈，关掉这个标记
  const proc = Bun.spawn([CHROME, "--remote-debugging-port=0", "--disable-blink-features=AutomationControlled", `--user-data-dir=${profileDir}`, ...BASE_ARGS], {
    stdout: "ignore",
    stderr: "ignore",
  });

  let ws = await wsUrl(profileDir);
  for (let i = 0; i < 50 && !ws; i++) {
    await Bun.sleep(300);
    ws = await wsUrl(profileDir);
  }

  if (!ws) {
    proc.kill();
    throw new Error("Chrome 没有打开调试端口：同一 profile 的 Chrome 是否已在运行？先 Cmd+Q 关掉它");
  }

  const browser = await chromium.connectOverCDP(ws).catch((e) => {
    proc.kill();
    throw e;
  });

  // 调试端口开着时本机任何进程都能操控这个已登录的浏览器，所以用完就关。
  // 用 CDP 的 Browser.close 正常退出：直接 kill 会被当成崩溃，cookie 可能来不及落盘
  const close = async () => {
    // CDP 已断开时 newBrowserCDPSession 也会抛错，吞掉，保证走到下面的 kill
    await browser.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => {});
    await Promise.race([proc.exited, Bun.sleep(5_000)]);
    proc.kill();
  };

  return { browser, close };
}

// 兜底登录：带调试端口启动的 Chrome 里 navigator.webdriver 为 true，若某家因此拒绝登录，
// 就用不带调试端口的「普通」Chrome 登录，用户 Cmd+Q 正常退出后会话随 profile 保存，再由 sync 复用
export async function loginInPlainChrome(profileDir: string, urls: string[]): Promise<void> {
  ensureProfile(profileDir);

  const proc = Bun.spawn([CHROME, `--user-data-dir=${profileDir}`, ...BASE_ARGS, ...urls], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}
