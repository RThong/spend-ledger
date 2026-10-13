import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type StatementMeta = { card: string; account: string; month: string; sha256: string; rawPath: string };
export type SaveResult = "new" | "updated" | "unchanged";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS statements (
  id          INTEGER PRIMARY KEY,
  card        TEXT NOT NULL,
  account     TEXT NOT NULL,  -- 同一家卡下的哪张卡（楽天末4位 / Vpass 卡名），单卡为空串
  month       TEXT NOT NULL,  -- 该卡自己的账单月 YYYY-MM，各家含义不同，见 README
  sha256      TEXT NOT NULL,
  raw_path    TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (card, account, month)
);
CREATE TABLE IF NOT EXISTS transactions (
  statement_id INTEGER NOT NULL REFERENCES statements(id),
  row_no       INTEGER NOT NULL,
  data         TEXT NOT NULL,  -- JSON：卡公司原始字段，不做统一
  PRIMARY KEY (statement_id, row_no)
);`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true, strict: true });

  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);

  return db;
}

export function hasStatement(db: Database, card: string, account: string, month: string): boolean {
  return db.query("SELECT 1 FROM statements WHERE card = ? AND account = ? AND month = ?").get(card, account, month) !== null;
}

// 去重单位是「一张卡的一个账单月」：已确定账单不会变，hash 相同跳过；卡公司更正过（hash 变了）就整月替换。
// 同一账单内同日同店同额的多笔各占一行，不会被误合并
export function saveStatement(db: Database, meta: StatementMeta, rows: object[]): SaveResult {
  const { card, account, month, sha256, rawPath } = meta;
  const prev = db
    .query<{ id: number; sha256: string }, [string, string, string]>(
      "SELECT id, sha256 FROM statements WHERE card = ? AND account = ? AND month = ?",
    )
    .get(card, account, month);

  if (prev?.sha256 === sha256) return "unchanged";

  db.transaction(() => {
    const id = prev
      ? prev.id
      : db
          .query<{ id: number }, [string, string, string, string, string]>(
            "INSERT INTO statements (card, account, month, sha256, raw_path) VALUES (?, ?, ?, ?, ?) RETURNING id",
          )
          .get(card, account, month, sha256, rawPath)!.id;

    if (prev) {
      db.run("UPDATE statements SET sha256 = ?, raw_path = ?, imported_at = datetime('now', 'localtime') WHERE id = ?", [sha256, rawPath, id]);
      db.run("DELETE FROM transactions WHERE statement_id = ?", [id]);
    }

    const insert = db.prepare("INSERT INTO transactions (statement_id, row_no, data) VALUES (?, ?, ?)");
    rows.forEach((row, i) => insert.run(id, i, JSON.stringify(row)));
  })();

  return prev ? "updated" : "new";
}
