/**
 * ハイブリッド検索エンジン
 * ベクトル検索 + BM25 を RRF（Reciprocal Rank Fusion）で統合
 * オプションでCross-Encoderリランキング
 */

import type { MemoryStore, SearchHit, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "none";
  rerankApiKey?: string;
  rerankModel: string;
  rerankEndpoint: string;
  candidatePoolSize: number;
  recencyBoostDays: number;
  recencyBoostMax: number;
  decayHalfLifeDays: number;
}

export interface RetrievalResult {
  entry: MemoryEntry;
  score: number;
  sources: string[];
}

export const DEFAULT_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "none",
  rerankModel: "jina-reranker-v2-base-multilingual",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  candidatePoolSize: 20,
  recencyBoostDays: 14,
  recencyBoostMax: 0.1,
  decayHalfLifeDays: 60,
};

/**
 * RRF（Reciprocal Rank Fusion）スコア計算
 * 複数の検索結果リストを統合するための標準手法
 */
function computeRRF(rankings: Map<string, number>[], weights: number[], k = 60): Map<string, number> {
  const fused = new Map<string, number>();

  for (let i = 0; i < rankings.length; i++) {
    const ranking = rankings[i];
    const weight = weights[i];
    for (const [id, rank] of ranking) {
      const current = fused.get(id) || 0;
      fused.set(id, current + weight / (k + rank));
    }
  }

  return fused;
}

/**
 * 近時ブースト — 新しい記憶ほどスコアが高い
 */
function recencyBoost(timestampMs: number, halfLifeDays: number, maxBoost: number): number {
  if (halfLifeDays <= 0 || maxBoost <= 0) return 0;
  const ageDays = (Date.now() - timestampMs) / 86_400_000;
  return maxBoost * Math.exp(-ageDays * (Math.LN2 / halfLifeDays));
}

/**
 * 時間減衰 — 古い記憶のスコアを徐々に下げる
 * フロア 0.5x（完全に忘れない）
 */
function timeDecay(timestampMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = (Date.now() - timestampMs) / 86_400_000;
  return 0.5 + 0.5 * Math.exp(-ageDays * (Math.LN2 / halfLifeDays));
}

/**
 * Cross-Encoder リランキング
 */
async function rerankWithCrossEncoder(
  query: string,
  candidates: RetrievalResult[],
  config: RetrievalConfig,
): Promise<RetrievalResult[]> {
  if (!config.rerankApiKey || candidates.length === 0) return candidates;

  const documents = candidates.map((c) => c.entry.text);

  const response = await fetch(config.rerankEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.rerankApiKey}`,
    },
    body: JSON.stringify({
      model: config.rerankModel,
      query,
      documents,
      top_n: candidates.length,
    }),
  });

  if (!response.ok) {
    // リランキング失敗時は元のスコアで返す
    return candidates;
  }

  const data = (await response.json()) as {
    results: Array<{ index: number; relevance_score: number }>;
  };

  return data.results
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .map((r) => ({
      ...candidates[r.index],
      score: r.relevance_score,
      sources: [...candidates[r.index].sources, "rerank"],
    }));
}

export interface MemoryRetriever {
  recall(query: string, scope: string, limit: number): Promise<RetrievalResult[]>;
}

/**
 * Retriever を生成
 */
export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  userConfig: Partial<RetrievalConfig> = {},
): MemoryRetriever {
  const config: RetrievalConfig = { ...DEFAULT_CONFIG, ...userConfig };

  return {
    async recall(query: string, scope: string, limit: number): Promise<RetrievalResult[]> {
      const poolSize = config.candidatePoolSize;

      // 1. ベクトル検索
      const queryVector = await embedder.embed(query);
      const vectorHits = await store.search(queryVector, scope, poolSize);

      // ベクトル結果のランキング
      const vectorRanking = new Map<string, number>();
      vectorHits.forEach((hit, i) => vectorRanking.set(hit.entry.id, i + 1));

      // エントリをIDで参照できるように
      const entryMap = new Map<string, MemoryEntry>();
      vectorHits.forEach((h) => entryMap.set(h.entry.id, h.entry));

      let fusedScores: Map<string, number>;

      if (config.mode === "hybrid") {
        // 2. BM25 フルテキスト検索
        const textHits = await store.searchFullText(query, scope, poolSize);
        textHits.forEach((h) => entryMap.set(h.entry.id, h.entry));

        const bm25Ranking = new Map<string, number>();
        textHits.forEach((hit, i) => bm25Ranking.set(hit.entry.id, i + 1));

        // 3. RRF 融合
        fusedScores = computeRRF(
          [vectorRanking, bm25Ranking],
          [config.vectorWeight, config.bm25Weight],
        );
      } else {
        // ベクトルのみ
        fusedScores = new Map<string, number>();
        for (const [id, rank] of vectorRanking) {
          fusedScores.set(id, 1 / (60 + rank));
        }
      }

      // 4. スコアリングパイプライン
      let results: RetrievalResult[] = [];

      for (const [id, rawScore] of fusedScores) {
        const entry = entryMap.get(id);
        if (!entry) continue;

        // 時間減衰
        const decay = timeDecay(entry.timestamp, config.decayHalfLifeDays);
        // 近時ブースト
        const boost = recencyBoost(entry.timestamp, config.recencyBoostDays, config.recencyBoostMax);
        // 重要度ボーナス
        const importanceBonus = (entry.importance - 0.5) * 0.05;

        const finalScore = rawScore * decay + boost + importanceBonus;

        if (finalScore >= config.minScore) {
          const sources: string[] = [];
          if (vectorRanking.has(id)) sources.push("vector");
          if (config.mode === "hybrid") sources.push("bm25");

          results.push({ entry, score: finalScore, sources });
        }
      }

      // 5. スコア降順ソート
      results.sort((a, b) => b.score - a.score);

      // 6. オプション: Cross-Encoder リランキング
      if (config.rerank === "cross-encoder" && config.rerankApiKey) {
        results = await rerankWithCrossEncoder(query, results.slice(0, poolSize), config);
      }

      return results.slice(0, limit);
    },
  };
}
