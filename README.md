# spend-ledger

把日本信用卡已确定的月度账单明细同步到本地 SQLite。数据只存在本机，工具不接触密码。

调研结论见 [docs/card-research.md](docs/card-research.md)。

## 要求

- macOS + Google Chrome（装在 `/Applications`）
- Bun ≥ 1.4（1.2.x 下 Playwright 的 `connectOverCDP` 会断连）

```bash
bun install
```

## 用法

```bash
bun run sync                      # 同步 楽天 / 三井住友 / Amex / AEON
bun run sync rakuten amex         # 只同步指定的卡
bun run import paypay ~/Downloads/xxx.csv --month 2026-09   # PayPay（App 导出）或任何卡的手动导入
bun run import aeon data/raw/aeon/_/2026-09.xxxx.json --month 2026-09 --force   # 解析器修好后，按原始文件强制重新解析
bun run inspect data/raw/smbc/.../2026-09.xxxx.csv          # 脱敏后的格式信息
bun run login                     # 兜底登录，见下文
```

`sync` 会打开一个独立 profile 的 Chrome。哪家没登录，终端就会提示，你在那个 Chrome 里手动登录（含 OTP），然后回车。每次运行：

- 本月和上月的账单一定重新下载，内容有变就替换整月；
- 更早的月份已入库就跳过；
- 某一家失败不影响其他家，最后会打印汇总；有失败时退出码为 1；
- 解析出 0 行的账单月会在汇总里单独列出，请核对；
- 楽天每次新开浏览器都要重新输密码，所以每次 sync 都得手动登录一次。

### 登录被拒时的兜底

带调试端口启动的 Chrome 里 `navigator.webdriver` 默认是 true，楽天登录会因此一直转圈（已实测）。`sync` 启动 Chrome 时加了 `--disable-blink-features=AutomationControlled` 把它关掉，楽天已经能正常登录。如果某家仍然拒绝登录：

1. `bun run login`：打开一个不带调试端口的普通 Chrome，在里面登录各家
2. 在这个 Chrome 里按 Cmd+Q 正常退出（不要直接关窗口，也不要在终端里 Ctrl+C）
3. `bun run sync`：复用刚才保存的会话

实测对楽天无效：会话带到 sync 的 Chrome 里后，楽天会要求重新输密码。其他几家还没试过。

## 数据

全部在 `data/`（已 gitignore）：

| 路径 | 内容 |
|---|---|
| `data/ledger.db` | `statements`：一行是一张卡一个账单月；`transactions`：一行一笔，`data` 列存卡公司原始字段的 JSON |
| `data/raw/<卡>/<子卡>/<月>.<hash前8位>.<ext>` | 原始文件，账单被更正时旧版也保留 |
| `data/chrome-profile/` | 登录会话（权限 700） |
| `data/debug/` | 失败时的截图和 HTML（含个人信息，不要外传） |

`month` 是各家卡自己的账单月，含义不同：

| 卡 | month | account |
|---|---|---|
| rakuten | 请求月（CSV 文件名里的 YYYYMM） | 卡号末 4 位 |
| smbc | 支付月 | Vpass 里的卡名（只有一张卡时为空） |
| amex | 締め日所在月 | 空 |
| aeon | 请求月（billingYearMonth） | 空 |
| paypay | 导入时 `--month` 指定 | `--account` 指定，默认空 |

要按消费月统计，就用 `data` 里的利用日字段。ETC、海外消费会晚 1–2 个月才进账单。

查询示例：

```sql
SELECT s.card, s.month, json_extract(t.data, '$.利用日'), json_extract(t.data, '$.利用金額')
FROM transactions t JOIN statements s ON s.id = t.statement_id
WHERE s.card = 'rakuten';
```

## 首次实测清单

选择器和接口来自公开资料和开源项目，都没有在真实账户上验证过。

1. `bun test`：确认环境正常
2. `bun run sync rakuten`：成功的话再逐个试 `smbc`、`amex`、`aeon`
3. 某家失败时，终端会打印「页面路径 + 可点击元素」。确认里面没有个人信息后，贴出来排查
4. 对下载到的文件跑 `bun run inspect <文件>`，把输出贴出来核对列名和编码。输出已经脱敏：数字变成 9，文字变成 ＊
5. PayPay：在 App「あと払い」→ 明細出力 导出 CSV，`bun run import paypay <文件> --month YYYY-MM`，再跑 `inspect`

不要在公司电脑上用真实账户运行。
