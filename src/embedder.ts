/**
 * 埋め込みベクトル生成モジュール
 * OpenAI互換APIを使用して任意のプロバイダーに対応
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

// ベクトル次元数のルックアップテーブル
const KNOWN_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "gemini-embedding-001": 768,
};

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

/**
 * LRUキャッシュ — 同一テキストの再埋め込みを防止
 */
class VectorCache {
  private entries = new Map<string, { vector: number[]; at: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 256, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private hash(text: string): string {
    return createHash("sha256").update(text).digest("hex").slice(0, 20);
  }

  get(text: string): number[] | undefined {
    const key = this.hash(text);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // LRU: 再挿入で最新に
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.vector;
  }

  set(text: string, vector: number[]): void {
    const key = this.hash(text);
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { vector, at: Date.now() });
  }
}

/**
 * Embedder を生成
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL || "https://api.openai.com/v1",
  });

  const model = config.model || "text-embedding-3-small";
  const dimensions = config.dimensions || KNOWN_DIMENSIONS[model] || 1536;
  const cache = new VectorCache();

  async function callApi(texts: string[]): Promise<number[][]> {
    const response = await client.embeddings.create({
      model,
      input: texts,
    });
    // APIレスポンスをインデックス順にソート
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  }

  return {
    get dimensions() {
      return dimensions;
    },

    async embed(text: string): Promise<number[]> {
      const cached = cache.get(text);
      if (cached) return cached;

      const [vector] = await callApi([text]);
      cache.set(text, vector);
      return vector;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const results: (number[] | null)[] = texts.map((t) => cache.get(t) || null);
      const uncached: { index: number; text: string }[] = [];

      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) uncached.push({ index: i, text: texts[i] });
      }

      if (uncached.length > 0) {
        const vectors = await callApi(uncached.map((u) => u.text));
        for (let j = 0; j < uncached.length; j++) {
          results[uncached[j].index] = vectors[j];
          cache.set(uncached[j].text, vectors[j]);
        }
      }

      return results as number[][];
    },
  };
}

/**
 * モデル名からベクトル次元数を推定
 */
export function inferDimensions(model: string): number {
  return KNOWN_DIMENSIONS[model] || 1536;
}
