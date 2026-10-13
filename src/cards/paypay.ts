import { csvRecords } from "../text";
import type { Card } from "./util";

// 只支持手动导入：App 入会的会员没有 Web 会员页。在 App「あと払い」→ 明細出力 导出請求明細 CSV
export const paypay: Card = { parse: csvRecords };
