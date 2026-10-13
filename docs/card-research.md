# 五家信用卡数据获取调研

> 调研日期：2026-10-13。来源标记：[官方] 官方页面 / [社区] 博客·GitHub·论坛 / [推测] 推断。
> CSV 列名、内部接口、选择器大多来自社区代码，**落地前每家都要先手动下载一份真实文件核对表头和编码**。

## 结论

1. **五家都没有个人可用的免费 API**。卡公司不受銀行法开放 API 义务约束；经产省 2026-03 的方针是软法推进，目标 2028 年度末，且只对签约的電代業者开放 [官方] https://www.fapi.or.jp/wp-content/uploads/2026/03/当協会見解_20260330.pdf
2. **免费聚合服务不可行**：MoneyForward ME / Zaim / Moneytree 对这些卡基本都是代存密码抓取（违反「不向第三方提供密码」），且免费档基本不能导出（MF 限 4 账户无导出；Moneytree 导出付费；Zaim 免费档「制限あり」）。
3. **主方案：真实 Chrome + 人工登录 + Playwright 下载官方 CSV**。Amex、三井住友（Akamai）已知会拒绝自动化浏览器的登录请求，所以统一为：
   - 工具用独立 `--user-data-dir` + `--remote-debugging-port` 启动本机 Chrome（Chrome 136+ 禁止对默认 profile 开远程调试）
   - 用户在里面手动登录、完成 OTP / パスキー，工具不接触密码
   - Playwright `connectOverCDP` 接入，按「卡 × 月」下载 CSV，原样存档后解析入库
   - 会话失效、出现认证页时停下交给人；**失败不自动重试**（楽天锁号 48h，AEON 锁号不可恢复）
4. **五家都没有可靠的交易 ID**（CSV 层面）。去重只能用指纹 `(卡, 日期, 店名, 金额, 支払区分, 利用者)` + 同键内出现序号；未確定（速報）数据单独存，每次同步整月替换，以確定数据为准。

## 对比表

| | PayPayカード | 楽天カード | Amex JP | AEONカード | 三井住友 Vpass |
|---|---|---|---|---|---|
| 官方 API | 无 | 无（仅電代業者·法人卡） | 无（仅 EU/UK AISP） | 无 | 无 |
| CSV 下载 | 有，Web/App 按请求月 | 有，仅 PC 版 e-NAVI 按请求月 | 有，Web，CSV/Excel/QIF | 有，Web/App 按请求月，每次需输有効期限+CVV | 有，仅 Web 按卡×月 |
| 历史长度 | 24 个月 | 15 个月 | 24 个月 | Web 24 / App 12 个月 | 15 个月 |
| 含未確定 | 否 | 未确认 | **是** | 否 | 是（格式不同） |
| 编码 | 大概率 Shift_JIS [推测] | UTF-8（有无 BOM 都有） | Shift_JIS | 未知 | Shift_JIS |
| 表头 | 有 | 有，列名带月份会变 | 有 | 有，数据从第 9 行起 [社区·2020] | **无**，按卡分段+合计行 |
| 交易 ID | 无（App 取引履歴 CSV 有 取引番号） | 无 | 无（内部 JSON 有 `reference_id` [推测]） | 无 | 无 |
| 登录 | Yahoo! JAPAN ID，SMS/OTP/パスキー，2027 春取消仅密码登录 | 楽天ID，风险触发邮件 OTP/パスキー | User ID，风险触发 OTP，可登记信頼するデバイス | AEON Pay ID，异常环境发邮件 OTP | VpassID，目前纯 ID/PW |
| 反爬 | 未知 | 未知 | **强**，Playwright 浏览器登录 403 | 疑似 Akamai | **Akamai**，自动化浏览器登录 403 |
| 开源参考 | 少，均过时 | 多 | mizzy/amexcsv（2026-06） | 无 | schroneko/skills（2026-09） |
| 自动化难度 | Web 入会：中；App 入会：**不可自动** | 低 | 高 | 中（锁号风险高） | 中（解析最难） |

## PayPayカード

> **本项目目前只实现手动导入**：PayPayアプリ入会的会员没有 Web 会員メニュー（用 Yahoo! JAPAN ID 访问会被导向申请流程），无法用 Playwright 自动化，只能从手机 App 导出 CSV：
> - 優先 取引履歴 CSV（含 取引番号、外币字段，去重最可靠）
> - 請求明細 CSV（App「あと払い」→ 明細出力）作对账补充

**前提**：Web 入会才能用 Web 会員メニュー；**PayPayアプリ入会的卡没有 Web 入口**，只能 App 内操作 [官方] https://www.paypay-card.co.jp/service/000449.html

- **請求明細 CSV**（2023-02 上线）[官方] https://www.paypay-card.co.jp/service/000247.html
  - 路径：会員メニュー（或 App「あと払い」）→ 选月 →「明細出力」→「CSVをダウンロードする」
  - 逐月下载、过去 24 个月、**不含未確定**
  - 表头 [社区] https://github.com/yumiachira/CSV-to-Qianji ：
    `利用日/キャンセル日, 利用店名・商品名, 利用者, 決済方法, 支払区分, 利用金額, 手数料, 支払総額, 当月支払金額, 翌月以降繰越金額, 調整額, 当月お支払日`
  - 取消为负数单独一行；无外币字段
- **PayPayアプリ 取引履歴 CSV**（2025-02 上线）[官方] https://paypay.ne.jp/help/c0447/
  - 列：`取引日, 出金金額（円）, 入金金額（円）, 海外出金金額, 通貨, 変換レート（円）, 利用国, 取引内容, 取引先, 取引方法, 支払い区分, 利用者, 取引番号`
  - 有 **取引番号** 和外币字段；回溯 2 年、单次 365 天；需申请后 24h 内下载；**只能手机操作**，只适合手动导入
- **速報**：メッセージボックス「利用速報」仅 3 天 / 20 条
- **登录**：Yahoo! JAPAN ID；LINEヤフー 计划约 2027 年春结束仅密码登录，统一到パスキー [官方] https://www.lycorp.co.jp/ja/news/release/020333/
- **规约**：会員メニュー利用者規定 第9条，取得信息仅限「私的範囲内」使用
- **开源**：mu373/paypaycard-fetcher（Selenium，2024-02，依赖哈希类名，大概率失效）

## 楽天カード

- **CSV**：PC 版 e-NAVI →「ご利用明細」→ 下拉切换卡 → 选請求月 →「明細コピー用 Excel(CSV)」[官方] https://support.rakuten-card.jp/faq/show/2385?site_domain=guest
  - 需每张卡分别登记「WEB明細サービス」；过去 15 个月；App 只出 PDF [官方] https://www.rakuten-card.co.jp/service/bill/
  - URL [社区]：`/e-navi/members/statement/index.xhtml?tabNo=N`（0=下月未确定），CSV 为 `?downloadAsCsv=1`；切卡 `select#cardChangeForm:cardtype`
  - 文件名 `enavi202412(4071).csv`（括号内卡号末 4 位）
  - 编码 UTF-8 [社区] https://github.com/RyoyaYahagi/KakeiMatch/blob/main/docs/STATEMENT_FORMATS.md
  - 表头随月份变化，已见 10 / 12 列两种格式：
    - `利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,1月支払金額,2月繰越残高,新規サイン`
    - `利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,支払月,10月支払金額,当月請求額,11月繰越残高,11月以降請求額`
    - 解析器按列名定位，`\d{1,2}月…` 用正则
  - 坑：画面两行的明细 CSV 也是两行（续行，海外消费信息在续行里）；店名可能截断；リボ只出新规利用 [官方]
  - 家族卡出现在本卡明细，`利用者=家族`；ETC 并入本卡
- **登录**：楽天ID 两步页面 `#user_id`→`#cta001`→`#password_current`→`#cta011` [社区] https://github.com/kzkadc/rakuten_campaign ；2FA 目前风险触发
- **锁号**：E01_009 需走解锁表单约 48h [官方] https://www.rakuten-card.co.jp/service/e-navi/login-support/
- **补充来源**：「カード利用お知らせメール」，速報版次日到但无店名 [官方]
- **开源**：nphamvn/rakuten-card-usage-management（2025-12）、LaoshuBaby/beancount-rakuten（2025-04）

## American Express Japan

- **API**：Amex for Developers 只对 EU/UK 持证 AISP 开放 [官方] https://developer.americanexpress.com/open-banking
- **CSV**：Web「ご利用履歴」→「ダウンロード」→ CSV / Excel / QIF；App 只出 PDF；24 个月 [官方] https://www.americanexpress.com/ja-jp/support/guide/statement/
  - **履歴含确定前的消费**，是五家中唯一能导出未確定的
  - Shift_JIS，「ー」会变「?」；文件名 `activity.csv`
  - 表头 [社区] https://github.com/nownabe/go-bqloader/blob/main/contrib/handlers/testdata/amex_statement.csv ：
    `ご利用日,データ処理日,ご利用内容,カード会員様名,会員番号 #,金額,海外通貨利用金額,換算レート`
  - 金額带千分位逗号；退款负数；「前回分口座振替金額」是还款行，需排除
  - 家族卡合并在同一明细；2024-06 改版后网站不再显示家族卡卡号，`会員番号` 可能无法区分 [推测]
- **内部接口** [社区·EU] https://github.com/rbignon/woob/tree/master/modules/americanexpress ：
  `global.americanexpress.com/api/servicing/v1/financials/transactions?status=pending|posted` 返回 `identifier`、`reference_id` 等；JP 走同一 global 平台 [推测]
- **日期坑**：确定前日期按 GMT-07:00，日本 16 点前的消费显示为前一天；确定后日期/店名/金额都可能变 [官方]
- **登录**：User ID + 密码，2026 年起多一个账户类型下拉；风险触发 6 位码（邮件/SMS/App）；可登记「信頼するデバイス」[官方]；2026-07 起分批弹 AML「カード会員様情報のご確認」页，需人工
- **反爬**：2026-06 起 Playwright 驱动的浏览器登录返回 403，mizzy/amexcsv 改用 CDP 接真实 Chrome [社区] https://github.com/mizzy/amexcsv
- **规约**：App EULA 禁止逆向

## AEONカード

- **时效**：2026-04 起 イオンウォレット 改名 AEON Pay アプリ，ID 改名 AEON Pay ID [官方] https://faq.aeon.co.jp/faq/show/36399 ；Web 仍是暮らしのマネーサイト（https://www.aeon.co.jp/app/ ，React SPA）；2026-06 系统更新后速報金额改为折扣后金额 [社区]
- **下载**：＜ご利用明細＞→ 选月 →＜ご請求明細書ダウンロード＞→ PDF / パスワード付きPDF / CSV [官方] https://faq.aeon.co.jp/faq/show/226
  - 只能下已確定月；Web 24 / App 12 个月
  - **每次下载都要输入有効期限 + セキュリティコード**
  - CSV 表头 [社区·2020，可能过时] https://logicalifer.com/post-663/ ：`ご利用日, 利用者区分, ご利用先, 支払方法, (空白), (空白), ご利用金額, 備考`，数据从第 9 行开始，日期 YYMMDD，末尾有非明细行
  - 编码未知
  - 一个 ID 下可看本人 + 家族（最多 3 张）明细；多张卡需逐张查看 [官方] https://faq.aeon.co.jp/faq/show/701
- **内部接口** [推测，来自公开 JS bundle]：
  - 已确定：`POST /usedetail/GetBillingPriceUseDetail {cardIdentifier, billingYearMonth}`
  - 未确定：`/usedetail/GetUsePartItemRecent`
  - 字段：`useDate`、`useStoreName`、`useAmount`、`useTypeName`、`paymentMethodsName`、`saleTypeName`、`fee`、`purchasingAmount`（割引前金額）、`remarks`；无交易 ID
  - 截获这两个响应可以不输 CVV、还能拿到速報
- **登录**：AEON Pay ID；「普段と異なる環境」时发 6 位邮件 OTP，固定环境可减少触发 [官方] https://faq.aeon.co.jp/faq/show/170
- **锁号（最致命）**：密码或 OTP 输错超过次数 ID 失效且**不可解锁**，只能重新注册 [官方] https://faq.aeon.co.jp/faq/show/36399
- **其他坑**：ETC、海外交易晚到 1〜2 个月；ボーナス払い 不进速報 [官方]
- **开源**：无可用项目

## 三井住友カード（Vpass / Olive）

- **CSV**：Vpass Web → ご利用明細 → 选支付月 →「照会」→「CSV形式で保存する」；15 个月 [官方] https://www.smbc-card.com/mem/oshiharai/meisai_about.jsp
  - 直达 `https://www.smbc-card.com/memx/web_meisai/top/index.html`；卡下拉 `select[name="vp-view-VC0205-001_RS0051_cardIdentifyKey"]`（value 每次会变，不能当卡 ID），月份 option 为 `YYYYMM` [社区] https://github.com/schroneko/skills/tree/main/download-smbc-card-statements
  - Shift_JIS，**无表头行**，按卡分段：
    ```
    氏名　様,4980-05**-****-****,三井住友カードＶＩＳＡ（ＮＬ）
    2022/08/18,ファミリーマート／ｉＤ,340,１,１,340,ﾌｱﾐﾘ-ﾏ-ﾄ/ID
    ,,,,,123456
    ```
  - 確定月列：`ご利用日,ご利用店名,ご利用金額,支払区分,今回回数,お支払い金額,備考`（海外消费另有 `現地通貨額/略称/換算レート/換算日`）
  - 未確定月列：`ご利用日,ご利用店名,ご利用者,支払区分,分割回数,支払予定月,ご利用金額,…`
  - 坑：確定 `YYYY/MM/DD` vs 未確定 `YYYY/M/D`；全角数字；店名含不带引号的逗号（需从右往左定位金额列）；Apple Pay/iD 单独成段 [社区] https://github.com/DRS22DownForce/SmartHouseholdAccountBook
- **Olive**：
  - クレジットモード（4980/4539 开头）走 Vpass CSV
  - デビット / ポイント払い 在 Vpass 无 CSV；退路是 SMBCダイレクト Web通帳 的入出金明細 CSV [官方] https://www.smbc.co.jp/direct/sousa/help_kouza/10.html
- **登录**：Vpass Web 只能用 VpassID（SMBC ID 仅限 App）[官方]；2026-10 社区实测纯 ID/PW 可登录无额外验证
- **反爬**：Akamai Bot Manager（`_abck` cookie）；`navigator.webdriver=true` 登录被拒，已登录的会话 cookie 可在别的 Chrome 继续用 [社区]
- **规约**：Vpass アプリ規約 禁止逆向（2026-09-30 修订）
- **补充来源**：ご利用通知メール（发件域 vpass.ne.jp），仅授权通知，公共料金/ETC/加油站不发

## 待决定

1. **真实 Chrome 规避 bot 检测是否接受**：OTP 由本人完成，不算绕过身份验证，但确实避开了 Amex / Akamai 的自动化检测。不接受则 Amex、三井住友只能手动下载 CSV 后导入。
2. **AEON 用哪条路**：截获内部 JSON（不输 CVV、含速報、但依赖未公开接口）vs 官方 CSV（正规、但每次输 CVV）。
3. **是否接入利用通知メール**：楽天、三井住友有近实时邮件通知，可作速報补充，但要授权读本地邮件。

## 待实测

- 每家下载一份真实 CSV，核对编码、表头、家族卡区分方式
- Amex 内部 `financials/transactions` 接口在 JP 是否返回 `reference_id`
- 楽天未確定月（`tabNo=0`）能否下载 CSV
- PayPay App 导出的两种 CSV（取引履歴 / 請求明細）实际编码与表头，取引履歴里 PayPayカード 消费如何标识
- Bun 1.2.19 下 `connectOverCDP` + 下载在本机是否稳定（调研 agent 已在本机验证 `launchPersistentContext` / 下载 / `storageState` 可用）

## 不采用

- 第三方聚合服务（交出密码 + 付费）
- 逆向 App API（各家规约禁止）
- stealth 插件、bundled headless 浏览器自动填密码登录
- MaebashiRamens/VpassFucker（绕过 Vpass App 安全检测）、emranlatif/PHP-Laravel（AEON 钓鱼页面）
