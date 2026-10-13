import iconv from "iconv-lite";

export function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

// 各家编码不统一：楽天 UTF-8，Amex / 三井住友 Shift_JIS。Bun 的 TextDecoder 不支持 Shift_JIS，所以用 iconv
export function decode(bytes: Uint8Array): string {
  const text = isUtf8(bytes) ? new TextDecoder().decode(bytes) : iconv.decode(Buffer.from(bytes), "cp932");

  return text.replace(/^﻿/, "");
}

// RFC 4180：引号内可含逗号、换行，"" 为转义引号。逐字符状态机，用循环比声明式清楚
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) rows.push([...row, cell]);

  return rows.filter((r) => r.some((v) => v !== ""));
}

// 首行作表头，保留卡公司原始列名；空表头或多出的列用 colN 兜底
export function toRecords(rows: string[][]): Record<string, string>[] {
  const [header = [], ...body] = rows;
  const keys = header.map((h, i) => h.trim() || `col${i}`);

  return body.map((r) => Object.fromEntries(r.map((v, i) => [keys[i] ?? `col${i}`, v])));
}

export const csvRecords = (bytes: Uint8Array) => toRecords(parseCsv(decode(bytes)));

// 脱敏成「形状」：数字→9、字母→a、其他文字→＊，保留标点和空白。用来远程诊断格式而不泄露内容
export const shape = (s: string): string =>
  s.replace(/./gsu, (c) => (/\d/.test(c) ? "9" : /[A-Za-z]/.test(c) ? "a" : /[\s\p{P}\p{S}]/u.test(c) ? c : "＊"));
