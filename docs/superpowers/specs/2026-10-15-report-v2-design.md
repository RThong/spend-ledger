# 月度消费报告 v2 设计

取代 `2026-10-14-monthly-report-design.md` 中「分组规则」和「页面」两节；其余（用法、月份口径、统一字段、跳过规则、未能解析计数）不变。

## 目标

- 区分**买取**（转卖进货）与**日常**消费，分别用饼图展示构成
- 能选月份查看
- 总览每月消费走势

## 分类

每笔消费得到 `kind` 与 `category`：

| kind | category（固定集合） |
|---|---|
| `buy`（买取） | `Amazon`、`楽天系`、`Yahoo`、`其他商城` |
| `daily`（日常） | `餐饮`、`超市日用`、`交通`、`通信`、`水电燃气`、`旅行`、`服饰美容`、`其他` |

规则是有序表 `{ match, kind, category }`：`match` 为正则源串，对 NFKC 规范化后的店名做不区分大小写匹配，第一条命中即止；全不命中 → `daily / 其他`。

**规则来源与顺序**：

1. 用户规则 `data/categories.json`（可选，数组，最先匹配）。放带具体店名的规则：店名可能暴露住址、常去的店，`data/` 已 gitignore，不进公开仓库。
2. 代码内默认规则：只用通用关键词。

**默认规则**（按此顺序）：

| match | kind / category | 说明 |
|---|---|---|
| `チャージ` | daily / 其他 | 电子钱包充值，要先于「通信」以免「○○PAY残高チャージ」这类店名被当成话费；充值后的消费不走信用卡，不会重复计算 |
| `楽天モバイル\|ドコモ\|DOCOMO\|AHAMO\|POVO\|ソフトバンク\|SOFTBANK\|ワイモバイル\|\bUQ\b` | daily / 通信 | 要先于「楽天系」 |
| `アマゾン\|AMAZON` | buy / Amazon | |
| `楽天\|ラクテン` | buy / 楽天系 | |
| `YAHOO\|ヤフー` | buy / Yahoo | |
| `ガス\|電力\|電気\|でんき\|水道` | daily / 水电燃气 | |
| `鉄道\|\bJR\b\|メトロ\|SUICA\|PASMO\|タクシー\|バス` | daily / 交通 | |
| `\bANA\b\|\bJAL\b\|KLOOK\|TRIP\\.COM\|BOOKING\|EXPEDIA\|ホテル\|利用国` | daily / 旅行 | `利用国` 是海外刷卡的标记 |
| `バーガー\|サブウェイ\|なか卯\|マクドナルド\|すき家\|吉野家\|松屋\|スターバックス\|ドトール\|酒場\|食堂\|ラーメン\|モバイルオーダー` | daily / 餐饮 | |
| `イオン\|AEON\|ピーコック\|マツモトキヨシ\|ウエルシア\|セブン\|ローソン\|ファミリーマート\|スーパー\|ドラッグ` | daily / 超市日用 | |
| `ユニクロ\|\bGU\b\|ZARA\|HAIR\|美容` | daily / 服饰美容 | |

**用户规则文件格式**：

```json
[
  { "match": "某店名", "kind": "daily", "category": "餐饮" },
  { "match": "某网店", "kind": "buy", "category": "其他商城" }
]
```

- 文件不存在 → 只用默认规则
- 不是数组、缺字段、`kind` / `category` 不在固定集合里、`match` 不是合法正则 → 报错并指出第几条；报告不生成（`sync` / `import` 不受影响，只打印「报告生成失败」）

实现时按用户当前数据生成一份初始 `data/categories.json`（只在本机），把默认规则覆盖不到的店归好类，包括被认定为买取「其他商城」的网店。

## 页面

单个自包含 HTML，**固定浅色主题**，无外部资源。

**只内嵌汇总数据，不含任何一笔明细或店名**：

```ts
type ReportData = {
  generatedAt: string;
  months: { month: string; buy: Record<BuyCategory, number>; daily: Record<DailyCategory, number> }[]; // 升序
  coverage: { card: string; from: string; to: string }[];
  invalid: number;
};
```

数据以 JSON 写入 `<script type="application/json">`，序列化时把 `<` 转义为 `<`。页面内联一小段 JS 负责渲染与交互。

从上到下：

1. **折线图**（SVG）：x 轴为月份（升序），三条线：合计、买取、日常；y 轴 3 条刻度线，单位万円。点击任一月份（点或其所在竖条区域）即选中该月，选中月高亮。
2. **月份切换**：`◀ YYYY-MM ▶` + 该月「合计 / 买取 / 日常」金额。默认选最新月；到头时对应按钮禁用。
3. **两个环形饼图并排**（窄屏上下排）：左「日常」按类别，右「买取」按商城。图例每项：色块、类别名、金额、占比（整数 %）。只画正值；金额为 0 的类别不列；某饼全为 0 时显示「本月无」。
4. **页脚**：各卡消费日覆盖范围、未能解析行数、生成时间。

金额显示：图例与月份汇总用「¥1,234」；折线 y 轴用「万」。

**去掉**：v1 的柱状图、月度表、按月展开的明细。

## 模块

| 文件 | 职责 |
|---|---|
| `src/categories.ts` | 类别常量与类型、默认规则、`loadRules(path)` 读取并校验用户规则、`classify(shop, rules)` |
| `src/spend.ts` | `Spend` 改为带 `kind` / `category`（去掉 `group`）；`toSpend(card, data, rules)` |
| `src/report.ts` | `buildReport(db, rules)` 汇总为 `ReportData`；`renderHtml(data)` 输出 HTML（含内联 JS）；`writeReport(db, path, rulesPath)` |
| `src/cli.ts` | `report()` 传入 `data/categories.json` 路径 |

## 测试

- 分类：默认规则各类至少一例；`○○PAY残高チャージ` → 其他（不是通信）；`楽天モバイル` → 通信（不是楽天系）；全角 `ＡＭＡＺＯＮ` → Amazon；无匹配 → daily / 其他
- 用户规则优先于默认规则
- `loadRules`：文件不存在 → `[]`；非法 kind / category / 正则 → 抛错且信息含条目序号
- 汇总：同月同类求和、退款负数抵扣、月份升序、每月 `buy` / `daily` 含全部固定类别（无数据为 0）
- `renderHtml`：输出不含任何店名；JSON 中的 `<` 被转义；空数据也能生成
- 交互（选月、点折线、饼图）在浏览器中人工验证

## 不做

- 明细列表、笔数
- 在页面上编辑分类
- 深色模式
