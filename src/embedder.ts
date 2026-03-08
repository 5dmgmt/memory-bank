/**
 * 埋め込みベクトル生成モジュール
 * OpenAI互換APIを使用して任意のプロバイダーに対応
 * Task-Aware Embeddings: 保存用と検索用で前処理を分離
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";

/**
 * SSRF防止: URL がプライベートネットワークを指していないか検証
 */
export function validateEndpointURL(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`memory-bank: ${label} の URL が不正です: ${url}`);
  }
  const hostname = parsed.hostname.toLowerCase();
  // localhost は開発用途（Ollama等）で許可
  // 169.254.x.x（リンクローカル）とクラウドメタデータエンドポイントをブロック
  const blocked = [
    /^169\.254\./,         // リンクローカル（AWS/GCP メタデータ）
    /^10\./,               // RFC1918
    /^172\.(1[6-9]|2\d|3[01])\./,  // RFC1918
    /^192\.168\./,         // RFC1918
    /^\[?::1\]?$/,         // IPv6 loopback
    /^\[?fe80:/i,          // IPv6 リンクローカル
    /^metadata\.google\.internal$/i,
  ];
  for (const pattern of blocked) {
    if (pattern.test(hostname)) {
      throw new Error(`memory-bank: ${label} にプライベートアドレスは指定できません: ${hostname}`);
    }
  }
}

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

/** embedding の用途 */
export type EmbedTask = "store" | "query";

/**
 * task-aware prefix テーブル
 * 一部のモデル（nomic, mxbai等）は prefix でタスク種別を切り替える
 */
const TASK_PREFIXES: Record<string, Record<EmbedTask, string>> = {
  "nomic-embed-text": {
    store: "search_document: ",
    query: "search_query: ",
  },
  "mxbai-embed-large": {
    store: "",
    query: "Represent this sentence for searching relevant passages: ",
  },
};

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  dimensions?: number;
  /** task-aware embeddings を有効化 (デフォルト: true) */
  taskAware?: boolean;
}

export interface Embedder {
  embed(text: string, task?: EmbedTask): Promise<number[]>;
  embedBatch(texts: string[], task?: EmbedTask): Promise<number[][]>;
  readonly dimensions: number;
  readonly taskAwareEnabled: boolean;
}

/**
 * LRUキャッシュ — 同一テキスト+タスクの再埋め込みを防止
 */
class VectorCache {
  private entries = new Map<string, { vector: number[]; at: number }>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize = 512, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60_000;
  }

  private hash(text: string, task?: EmbedTask): string {
    const input = task ? `${task}:${text}` : text;
    return createHash("sha256").update(input).digest("hex").slice(0, 20);
  }

  get(text: string, task?: EmbedTask): number[] | undefined {
    const key = this.hash(text, task);
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

  set(text: string, task: EmbedTask | undefined, vector: number[]): void {
    const key = this.hash(text, task);
    if (this.entries.size >= this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { vector, at: Date.now() });
  }
}

/**
 * テキストに task prefix を付与
 */
export function applyTaskPrefix(text: string, model: string, task: EmbedTask, enabled: boolean): string {
  if (!enabled) return text;
  const prefixes = TASK_PREFIXES[model];
  if (!prefixes) return text;
  const prefix = prefixes[task];
  return prefix ? prefix + text : text;
}

/**
 * Embedder を生成
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const baseURL = config.baseURL || "https://api.openai.com/v1";
  // SSRF防止: プライベートネットワークへのリクエストをブロック（localhost は Ollama 用に許可）
  validateEndpointURL(baseURL, "embedding.baseURL");

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
  });

  const model = config.model || "text-embedding-3-small";
  const dimensions = config.dimensions || KNOWN_DIMENSIONS[model] || 1536;
  const cache = new VectorCache();
  const taskAwareEnabled = config.taskAware !== false; // デフォルト true

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

    get taskAwareEnabled() {
      return taskAwareEnabled;
    },

    async embed(text: string, task?: EmbedTask): Promise<number[]> {
      const cached = cache.get(text, task);
      if (cached) return cached;

      const processed = applyTaskPrefix(text, model, task || "query", taskAwareEnabled);
      const [vector] = await callApi([processed]);
      cache.set(text, task, vector);
      return vector;
    },

    async embedBatch(texts: string[], task?: EmbedTask): Promise<number[][]> {
      const results: (number[] | null)[] = texts.map((t) => cache.get(t, task) || null);
      const uncached: { index: number; text: string }[] = [];

      for (let i = 0; i < texts.length; i++) {
        if (!results[i]) uncached.push({ index: i, text: texts[i] });
      }

      if (uncached.length > 0) {
        const processed = uncached.map((u) =>
          applyTaskPrefix(u.text, model, task || "query", taskAwareEnabled),
        );
        const vectors = await callApi(processed);
        for (let j = 0; j < uncached.length; j++) {
          results[uncached[j].index] = vectors[j];
          cache.set(uncached[j].text, task, vectors[j]);
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
