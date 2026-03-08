import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReflectionOutput,
  cosineSimilarity,
  isDuplicate,
  extractLessons,
  LESSON_PROMPT,
} from "../src/reflection.ts";
import type { MemoryStore, SearchHit, MemoryEntry } from "../src/store.ts";
import type { Embedder } from "../src/embedder.ts";

describe("parseReflectionOutput", () => {
  it("正常なJSON配列をパース", () => {
    const input = `[{"text":"テスト","category":"fact","importance":0.8}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "テスト");
    assert.equal(result[0].category, "fact");
    assert.equal(result[0].importance, 0.8);
  });

  it("テキスト中のJSON配列を抽出", () => {
    const input = `以下が抽出結果です:\n[{"text":"学び","category":"reflection","importance":0.9}]\n以上です。`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "学び");
  });

  it("複数アイテムをパース", () => {
    const input = `[
      {"text":"項目1","category":"fact","importance":0.8},
      {"text":"項目2","category":"preference","importance":0.6}
    ]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 2);
  });

  it("不正な入力で空配列を返す", () => {
    assert.deepEqual(parseReflectionOutput("no json here"), []);
    assert.deepEqual(parseReflectionOutput(""), []);
    assert.deepEqual(parseReflectionOutput("{not an array}"), []);
  });

  it("importanceを0-1にクランプ", () => {
    const input = `[{"text":"test","category":"fact","importance":5.0}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].importance, 1);
  });

  it("負のimportanceを0にクランプ", () => {
    const input = `[{"text":"test","category":"fact","importance":-0.5}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].importance, 0);
  });

  it("textを500文字に切り詰め", () => {
    const longText = "あ".repeat(600);
    const input = `[{"text":"${longText}","category":"fact","importance":0.7}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].text.length, 500);
  });

  it("必須フィールドが欠けたアイテムを除外", () => {
    const input = `[
      {"text":"valid","category":"fact","importance":0.8},
      {"category":"fact","importance":0.8},
      {"text":"no-cat","importance":0.8},
      {"text":"no-imp","category":"fact"}
    ]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "valid");
  });

  it("未定義カテゴリのアイテムを除外", () => {
    const input = `[
      {"text":"valid","category":"fact","importance":0.8},
      {"text":"invalid","category":"unknown","importance":0.9}
    ]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].category, "fact");
  });
});

// --- ヘルパー: モック生成 ---

function createMockEmbedder(vectorMap: Record<string, number[]>): Embedder {
  return {
    dimensions: 3,
    async embed(text: string) {
      return vectorMap[text] || [0, 0, 0];
    },
    async embedBatch(texts: string[]) {
      return texts.map((t) => vectorMap[t] || [0, 0, 0]);
    },
  };
}

function createMockStore(existingEntries: MemoryEntry[]): MemoryStore {
  const entries = [...existingEntries];
  let addCount = 0;

  return {
    async add(entry) {
      const id = `mock-id-${addCount++}`;
      entries.push({ ...entry, id, timestamp: Date.now() });
      return id;
    },
    async search(vector, scope, limit) {
      // スコープでフィルタし、コサイン類似度の降順で返す
      const scoped = entries.filter((e) => e.scope === scope);
      const scored = scoped.map((e) => ({
        entry: e,
        distance: 0, // テストでは distance は使わない
      }));
      return scored.slice(0, limit);
    },
    async searchFullText() { return []; },
    async getById() { return null; },
    async remove() { return true; },
    async listAll() { return []; },
    async count() { return entries.length; },
    async update() { return true; },
  };
}

// --- cosineSimilarity テスト ---

describe("cosineSimilarity", () => {
  it("同一ベクトルで1.0を返す", () => {
    const v = [1, 0, 0];
    assert.equal(cosineSimilarity(v, v), 1);
  });

  it("直交ベクトルで0.0を返す", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  });

  it("反対ベクトルで-1.0を返す", () => {
    assert.equal(cosineSimilarity([1, 0, 0], [-1, 0, 0]), -1);
  });

  it("長さが異なるベクトルで0を返す", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  });

  it("空ベクトルで0を返す", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("ゼロベクトルで0を返す", () => {
    assert.equal(cosineSimilarity([0, 0, 0], [1, 0, 0]), 0);
  });
});

// --- isDuplicate テスト ---

describe("isDuplicate", () => {
  it("類似度0.9以上の既存記憶があればtrueを返す", async () => {
    const existingVector = [1, 0, 0];
    const store = createMockStore([
      {
        id: "existing-1",
        text: "既存の教訓",
        vector: existingVector,
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: "{}",
      },
    ]);

    // 同一ベクトル → 類似度 1.0 → 重複
    const result = await isDuplicate([1, 0, 0], store, "global");
    assert.equal(result, true);
  });

  it("類似度0.9未満なら重複なしとしてfalseを返す", async () => {
    const store = createMockStore([
      {
        id: "existing-1",
        text: "既存の教訓",
        vector: [1, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: "{}",
      },
    ]);

    // 直交ベクトル → 類似度 0.0 → 重複なし
    const result = await isDuplicate([0, 1, 0], store, "global");
    assert.equal(result, false);
  });

  it("既存記憶が空ならfalseを返す", async () => {
    const store = createMockStore([]);
    const result = await isDuplicate([1, 0, 0], store, "global");
    assert.equal(result, false);
  });
});

// --- extractLessons テスト ---

describe("extractLessons", () => {
  it("重複のない教訓を保存する", async () => {
    const embedder = createMockEmbedder({
      "新しい教訓": [0, 1, 0],
    });
    const store = createMockStore([]);

    const items = [
      { text: "新しい教訓", category: "fact" as const, importance: 0.8 },
    ];
    const ids = await extractLessons(items, embedder, store, "global");
    assert.equal(ids.length, 1);
  });

  it("重複する教訓はスキップする", async () => {
    const vec = [1, 0, 0];
    const embedder = createMockEmbedder({
      "重複する教訓": vec,
    });
    const store = createMockStore([
      {
        id: "existing-1",
        text: "既に保存された教訓",
        vector: vec,
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: "{}",
      },
    ]);

    const items = [
      { text: "重複する教訓", category: "fact" as const, importance: 0.8 },
    ];
    const ids = await extractLessons(items, embedder, store, "global");
    assert.equal(ids.length, 0);
  });

  it("短すぎるテキストをスキップする", async () => {
    const embedder = createMockEmbedder({});
    const store = createMockStore([]);

    const items = [
      { text: "abc", category: "fact" as const, importance: 0.8 },
    ];
    const ids = await extractLessons(items, embedder, store, "global");
    assert.equal(ids.length, 0);
  });

  it("複数アイテムで重複のみスキップ", async () => {
    const embedder = createMockEmbedder({
      "教訓A（新規）": [0, 1, 0],
      "教訓B（重複）": [1, 0, 0],
    });
    const store = createMockStore([
      {
        id: "existing-1",
        text: "既存の教訓B",
        vector: [1, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.8,
        timestamp: Date.now(),
        metadata: "{}",
      },
    ]);

    const items = [
      { text: "教訓A（新規）", category: "fact" as const, importance: 0.7 },
      { text: "教訓B（重複）", category: "decision" as const, importance: 0.9 },
    ];
    const ids = await extractLessons(items, embedder, store, "global");
    assert.equal(ids.length, 1); // Aのみ保存
  });

  it("保存時のmetadataにsource: lessonが含まれる", async () => {
    const embedder = createMockEmbedder({
      "教訓テスト": [0, 0, 1],
    });
    const addedEntries: any[] = [];
    const store = createMockStore([]);
    const origAdd = store.add.bind(store);
    store.add = async (entry) => {
      addedEntries.push(entry);
      return origAdd(entry);
    };

    const items = [
      { text: "教訓テスト", category: "reflection" as const, importance: 0.8 },
    ];
    await extractLessons(items, embedder, store, "global", "test-agent");

    assert.equal(addedEntries.length, 1);
    const meta = JSON.parse(addedEntries[0].metadata);
    assert.equal(meta.source, "lesson");
    assert.equal(meta.agentId, "test-agent");
  });
});

// --- LESSON_PROMPT テスト ---

describe("LESSON_PROMPT", () => {
  it("教訓抽出用プロンプトが定義されている", () => {
    assert.ok(LESSON_PROMPT.length > 0);
    assert.ok(LESSON_PROMPT.includes("教訓"));
  });
});
