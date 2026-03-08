import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lengthNorm, cosineSimilarity, applyMMR, adaptConfig, DEFAULT_CONFIG } from "../src/retriever.ts";
import type { RetrievalResult, RetrievalConfig } from "../src/retriever.ts";
import type { MemoryEntry } from "../src/store.ts";

// テスト用ヘルパー: ダミーの RetrievalResult を生成
function makeResult(
  id: string,
  score: number,
  textLength: number,
  vector: number[],
): RetrievalResult {
  const entry: MemoryEntry = {
    id,
    text: "x".repeat(textLength),
    vector,
    category: "fact",
    scope: "global",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: "{}",
  };
  return { entry, score, sources: ["vector"] };
}

// ========================================================================
// Length Normalization
// ========================================================================
describe("lengthNorm", () => {
  it("アンカーより短いテキストに微増ブースト", () => {
    const norm = lengthNorm(100, 300);
    assert.ok(norm > 1, `expected > 1, got ${norm}`);
    assert.ok(norm <= 1.1, `expected <= 1.1, got ${norm}`);
  });

  it("アンカーと同じ長さで 1.0", () => {
    const norm = lengthNorm(300, 300);
    assert.equal(norm, 1);
  });

  it("アンカーの2倍で < 1", () => {
    const norm = lengthNorm(600, 300);
    assert.ok(norm < 1, `expected < 1, got ${norm}`);
    // 1 / (1 + log2(2)) = 1/2 = 0.5
    assert.ok(Math.abs(norm - 0.5) < 0.001, `expected ~0.5, got ${norm}`);
  });

  it("アンカーの4倍でさらに低下", () => {
    const norm600 = lengthNorm(600, 300);
    const norm1200 = lengthNorm(1200, 300);
    assert.ok(norm1200 < norm600, `1200 should score lower than 600`);
  });

  it("anchor=0 で無効（常に1.0）", () => {
    assert.equal(lengthNorm(100, 0), 1);
    assert.equal(lengthNorm(10000, 0), 1);
  });

  it("textLength=0 で最大ブースト", () => {
    const norm = lengthNorm(0, 300);
    assert.ok(Math.abs(norm - 1.1) < 0.001, `expected ~1.1, got ${norm}`);
  });
});

// ========================================================================
// Cosine Similarity
// ========================================================================
describe("cosineSimilarity", () => {
  it("同一ベクトルで 1.0", () => {
    const v = [1, 0, 0];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 0.0001);
  });

  it("直交ベクトルで 0.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 0.0001);
  });

  it("反対方向で -1.0", () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 0.0001);
  });

  it("空ベクトルで 0", () => {
    assert.equal(cosineSimilarity([], []), 0);
  });

  it("長さ不一致で 0", () => {
    assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  });
});

// ========================================================================
// MMR (Maximal Marginal Relevance)
// ========================================================================
describe("applyMMR", () => {
  it("lambda=1 でスコア順そのまま（MMR無効）", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0, 0]),
      makeResult("b", 0.8, 100, [1, 0, 0]),  // a と同一ベクトル
      makeResult("c", 0.7, 100, [0, 1, 0]),
    ];
    const result = applyMMR(candidates, 3, 1.0);
    assert.equal(result.length, 3);
    assert.equal(result[0].entry.id, "a");
    assert.equal(result[1].entry.id, "b");
    assert.equal(result[2].entry.id, "c");
  });

  it("lambda < 1 で類似候補を間引いて多様性確保", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0, 0]),
      makeResult("b", 0.85, 100, [0.99, 0.01, 0]),  // a とほぼ同一
      makeResult("c", 0.7, 100, [0, 1, 0]),           // a と直交（多様）
    ];
    const result = applyMMR(candidates, 2, 0.5);
    assert.equal(result.length, 2);
    assert.equal(result[0].entry.id, "a");
    // 2番目は c（多様なほう）が b（類似したほう）より優先されるべき
    assert.equal(result[1].entry.id, "c");
  });

  it("候補が1件以下ならそのまま返す", () => {
    const single = [makeResult("a", 0.9, 100, [1, 0])];
    assert.equal(applyMMR(single, 5, 0.5).length, 1);
    assert.equal(applyMMR([], 5, 0.5).length, 0);
  });

  it("limit で件数を制限", () => {
    const candidates = [
      makeResult("a", 0.9, 100, [1, 0]),
      makeResult("b", 0.8, 100, [0, 1]),
      makeResult("c", 0.7, 100, [1, 1]),
    ];
    const result = applyMMR(candidates, 2, 0.7);
    assert.equal(result.length, 2);
  });

  it("最高スコアの候補は常に最初に選択される", () => {
    const candidates = [
      makeResult("top", 0.95, 100, [1, 0, 0]),
      makeResult("diverse", 0.5, 100, [0, 1, 0]),
    ];
    const result = applyMMR(candidates, 2, 0.1); // 多様性重視でもトップは変わらない
    assert.equal(result[0].entry.id, "top");
  });
});

// ========================================================================
// 統合テスト: lengthNorm がスコアに与える影響
// ========================================================================
describe("lengthNorm integration", () => {
  it("同一スコアなら短いテキストが長いテキストより上位", () => {
    const anchor = 300;
    const shortNorm = lengthNorm(100, anchor);
    const longNorm = lengthNorm(1000, anchor);
    assert.ok(shortNorm > longNorm, `short(${shortNorm}) should > long(${longNorm})`);
  });

  it("reduction は緩やか（極端に罰しない）", () => {
    // アンカーの10倍でも 0.2 以上はある
    const norm = lengthNorm(3000, 300);
    assert.ok(norm > 0.2, `expected > 0.2, got ${norm}`);
  });
});

// ========================================================================
// Adaptive Retrieval
// ========================================================================
describe("adaptConfig", () => {
  it("短いクエリ（< 20文字）でBM25重視・候補プール拡大", () => {
    const result = adaptConfig(DEFAULT_CONFIG, 10);
    assert.ok(result.bm25Weight > DEFAULT_CONFIG.bm25Weight, "bm25Weight should increase");
    assert.ok(result.vectorWeight < DEFAULT_CONFIG.vectorWeight, "vectorWeight should decrease");
    assert.ok(result.candidatePoolSize > DEFAULT_CONFIG.candidatePoolSize, "candidatePoolSize should increase");
    // minScore は変わらない
    assert.equal(result.minScore, DEFAULT_CONFIG.minScore);
  });

  it("長いクエリ（> 100文字）でベクトル重視・minScore緩和", () => {
    const longQuery = 150;
    const result = adaptConfig(DEFAULT_CONFIG, longQuery);
    assert.ok(result.vectorWeight > DEFAULT_CONFIG.vectorWeight, "vectorWeight should increase");
    assert.ok(result.bm25Weight < DEFAULT_CONFIG.bm25Weight, "bm25Weight should decrease");
    assert.ok(result.minScore < DEFAULT_CONFIG.minScore, "minScore should decrease");
    // candidatePoolSize は変わらない
    assert.equal(result.candidatePoolSize, DEFAULT_CONFIG.candidatePoolSize);
  });

  it("中程度のクエリ（20-100文字）でデフォルトのまま", () => {
    const result = adaptConfig(DEFAULT_CONFIG, 50);
    assert.equal(result.vectorWeight, DEFAULT_CONFIG.vectorWeight);
    assert.equal(result.bm25Weight, DEFAULT_CONFIG.bm25Weight);
    assert.equal(result.minScore, DEFAULT_CONFIG.minScore);
    assert.equal(result.candidatePoolSize, DEFAULT_CONFIG.candidatePoolSize);
  });

  it("adaptive: false で調整なし", () => {
    const configOff: RetrievalConfig = { ...DEFAULT_CONFIG, adaptive: false };
    const shortResult = adaptConfig(configOff, 5);
    assert.equal(shortResult.vectorWeight, DEFAULT_CONFIG.vectorWeight);
    assert.equal(shortResult.bm25Weight, DEFAULT_CONFIG.bm25Weight);

    const longResult = adaptConfig(configOff, 200);
    assert.equal(longResult.vectorWeight, DEFAULT_CONFIG.vectorWeight);
    assert.equal(longResult.minScore, DEFAULT_CONFIG.minScore);
  });

  it("重みが 0 未満や 1 超過にならない", () => {
    // bm25Weight が非常に小さい場合
    const lowBm25: RetrievalConfig = { ...DEFAULT_CONFIG, bm25Weight: 0.05 };
    const longResult = adaptConfig(lowBm25, 150);
    assert.ok(longResult.bm25Weight >= 0, "bm25Weight should not go below 0");

    // vectorWeight が非常に小さい場合
    const lowVector: RetrievalConfig = { ...DEFAULT_CONFIG, vectorWeight: 0.1 };
    const shortResult = adaptConfig(lowVector, 5);
    assert.ok(shortResult.vectorWeight >= 0, "vectorWeight should not go below 0");
  });

  it("minScore が過度に低下しない", () => {
    const lowMinScore: RetrievalConfig = { ...DEFAULT_CONFIG, minScore: 0.08 };
    const result = adaptConfig(lowMinScore, 150);
    assert.ok(result.minScore >= 0.05, `minScore floor should be 0.05, got ${result.minScore}`);
  });
});
