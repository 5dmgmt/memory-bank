/**
 * LanceDB ストレージレイヤー
 * メモリエントリの永続化と基本検索を担当
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, accessSync, constants } from "node:fs";

/** scope / id に使える文字を制限（SQLインジェクション防止） */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_:@.\-\u3000-\u9fff\uff00-\uffef]+$/;

/**
 * SQL フィルター文字列のサニタイズ（エクスポート用）
 * SAFE_IDENTIFIER にマッチしない場合はシングルクォートエスケープ + 危険文字除去
 */
export function sqlEscape(s: string): string {
  if (SAFE_IDENTIFIER.test(s)) return s;
  // バックスラッシュ、セミコロン、ダブルダッシュ、括弧を除去し、シングルクォートをエスケープ
  return s
    .replace(/\\/g, "")
    .replace(/;/g, "")
    .replace(/--/g, "")
    .replace(/[()]/g, "")
    .replace(/'/g, "''");
}

// LanceDB は動的インポート（ネイティブモジュールのため）
let lancedbModule: typeof import("@lancedb/lancedb") | null = null;

async function loadLanceDB() {
  if (!lancedbModule) {
    lancedbModule = await import("@lancedb/lancedb");
  }
  return lancedbModule;
}

// 記憶カテゴリ
export const CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
] as const;

export type MemoryCategory = (typeof CATEGORIES)[number];

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  timestamp: number;
  metadata: string; // JSON文字列
}

export interface SearchHit {
  entry: MemoryEntry;
  distance: number;
}

export interface MemoryStore {
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<string>;
  search(vector: number[], scope: string, limit: number): Promise<SearchHit[]>;
  searchFullText(query: string, scope: string, limit: number): Promise<SearchHit[]>;
  getById(id: string): Promise<MemoryEntry | null>;
  remove(id: string): Promise<boolean>;
  listAll(scope: string, limit: number, offset: number): Promise<MemoryEntry[]>;
  count(scope?: string): Promise<number>;
  update(id: string, fields: Partial<Pick<MemoryEntry, "text" | "vector" | "category" | "importance" | "metadata">>): Promise<boolean>;
  /** metadata 内の textHash で検索（lesson 重複チェック用） */
  existsByTextHash(hash: string, scope: string): Promise<boolean>;
}

/**
 * ストレージパスの検証と作成
 * LanceDB の connect(path) は path 自体をディレクトリとして扱う
 */
function ensureStoragePath(dbPath: string): string {
  if (!existsSync(dbPath)) {
    mkdirSync(dbPath, { recursive: true });
  }
  accessSync(dbPath, constants.R_OK | constants.W_OK);
  return dbPath;
}

const TABLE_NAME = "memories";

/**
 * LanceDB ベースのメモリストアを生成
 */
export async function createStore(dbPath: string, vectorDim: number): Promise<MemoryStore> {
  const lancedb = await loadLanceDB();
  const validPath = ensureStoragePath(dbPath);
  const db = await lancedb.connect(validPath);

  // テーブル取得または作成
  let table: Awaited<ReturnType<typeof db.openTable>>;
  const tableNames = await db.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    table = await db.openTable(TABLE_NAME);
    // 既存テーブルでも FTS インデックスがなければ作成
    try {
      const indices = await table.listIndices();
      const hasFts = indices.some((idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"));
      if (!hasFts) {
        await table.createIndex("text", { config: lancedb.Index.fts() });
      }
    } catch {
      // インデックス確認/作成失敗はサイレントに
    }
  } else {
    // 初期ダミーレコードでスキーマ定義
    const seed: MemoryEntry = {
      id: "__seed__",
      text: "",
      vector: new Array(vectorDim).fill(0),
      category: "other",
      scope: "_system",
      importance: 0,
      timestamp: 0,
      metadata: "{}",
    };
    table = await db.createTable(TABLE_NAME, [seed]);

    // FTS インデックス作成（ハイブリッド検索の BM25 側に必要）
    try {
      await table.createIndex("text", { config: lancedb.Index.fts() });
    } catch (e) {
      console.warn("[memory-bank] FTS index creation failed, hybrid search will fall back to vector-only:", e);
    }
  }

  return {
    async add(entry) {
      const id = randomUUID();
      const row: MemoryEntry = {
        ...entry,
        id,
        timestamp: Date.now(),
      };
      await table.add([row]);
      return id;
    },

    async search(vector, scope, limit) {
      const results = await table
        .search(vector)
        .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
        .limit(limit)
        .toArray();

      return results.map((row: any) => ({
        entry: {
          id: row.id,
          text: row.text,
          vector: row.vector,
          category: row.category,
          scope: row.scope,
          importance: row.importance,
          timestamp: row.timestamp,
          metadata: row.metadata || "{}",
        },
        distance: row._distance ?? 0,
      }));
    },

    async searchFullText(query, scope, limit) {
      // LanceDB fullTextSearch API（query().fullTextSearch() を使用）
      // .search(query, "text") は embedding function が必要でエラーになる
      try {
        const results = await table
          .query()
          .fullTextSearch(query)
          .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
          .limit(limit)
          .toArray();

        return results.map((row: any) => ({
          entry: {
            id: row.id,
            text: row.text,
            vector: row.vector || [],
            category: row.category,
            scope: row.scope,
            importance: row.importance,
            timestamp: row.timestamp,
            metadata: row.metadata || "{}",
          },
          distance: row._distance ?? row._score ?? 0,
        }));
      } catch (e) {
        console.warn("[memory-bank] Full-text search failed, falling back to vector-only:", e);
        return [];
      }
    },

    async getById(id) {
      const results = await table
        .query()
        .where(`id = '${sqlEscape(id)}'`)
        .limit(1)
        .toArray();
      if (results.length === 0) return null;
      const row: any = results[0];
      return {
        id: row.id,
        text: row.text,
        vector: row.vector,
        category: row.category,
        scope: row.scope,
        importance: row.importance,
        timestamp: row.timestamp,
        metadata: row.metadata || "{}",
      };
    },

    async remove(id) {
      await table.delete(`id = '${sqlEscape(id)}'`);
      return true;
    },

    async listAll(scope, limit, offset) {
      // offset + limit の上限を制限してメモリ枯渇を防止
      const maxTotal = 1000;
      const safeOffset = Math.min(offset, maxTotal);
      const safeLimit = Math.min(limit, maxTotal - safeOffset);
      const results = await table
        .query()
        .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
        .limit(safeLimit + safeOffset)
        .toArray();

      return results.slice(safeOffset).map((row: any) => ({
        id: row.id,
        text: row.text,
        vector: row.vector,
        category: row.category,
        scope: row.scope,
        importance: row.importance,
        timestamp: row.timestamp,
        metadata: row.metadata || "{}",
      }));
    },

    async count(scope) {
      const filter = scope
        ? `scope = '${sqlEscape(scope)}' AND id != '__seed__'`
        : "id != '__seed__'";
      // countRows が使えればそちらを使い、メモリ消費を抑える
      try {
        return await table.countRows(filter);
      } catch {
        // fallback: IDのみ取得してカウント
        const results = await table.query().select(["id"]).where(filter).toArray();
        return results.length;
      }
    },

    async update(id, fields) {
      const existing = await this.getById(id);
      if (!existing) return false;
      // 部分更新: 変更フィールドのみ渡す（read-modify-write の競合リスクを軽減）
      // LanceDB の update は where マッチした行の指定フィールドを上書き
      const updateValues: Record<string, any> = {};
      if (fields.text !== undefined) updateValues.text = fields.text;
      if (fields.vector !== undefined) updateValues.vector = fields.vector;
      if (fields.category !== undefined) updateValues.category = fields.category;
      if (fields.importance !== undefined) updateValues.importance = fields.importance;
      if (fields.metadata !== undefined) updateValues.metadata = fields.metadata;
      await table.update({ where: `id = '${sqlEscape(id)}'`, values: updateValues });
      return true;
    },

    async existsByTextHash(hash, scope) {
      // metadata カラムに textHash が含まれるか where 句で検索
      // LanceDB の文字列 LIKE 検索で metadata JSON 内の hash を探す
      try {
        const results = await table
          .query()
          .select(["id", "metadata"])
          .where(`scope = '${sqlEscape(scope)}' AND id != '__seed__'`)
          .limit(100)
          .toArray();
        return results.some((row: any) => {
          try {
            return JSON.parse(row.metadata || "{}").textHash === hash;
          } catch {
            return false;
          }
        });
      } catch {
        return false;
      }
    },
  };
}
