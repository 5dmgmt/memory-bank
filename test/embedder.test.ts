import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTaskPrefix } from "../src/embedder.ts";

describe("applyTaskPrefix", () => {
  it("nomic-embed-text: store タスクで search_document: プレフィックスを付与", () => {
    const result = applyTaskPrefix("hello world", "nomic-embed-text", "store", true);
    assert.equal(result, "search_document: hello world");
  });

  it("nomic-embed-text: query タスクで search_query: プレフィックスを付与", () => {
    const result = applyTaskPrefix("hello world", "nomic-embed-text", "query", true);
    assert.equal(result, "search_query: hello world");
  });

  it("mxbai-embed-large: store タスクはプレフィックスなし", () => {
    const result = applyTaskPrefix("hello world", "mxbai-embed-large", "store", true);
    assert.equal(result, "hello world");
  });

  it("mxbai-embed-large: query タスクでプレフィックスを付与", () => {
    const result = applyTaskPrefix("hello world", "mxbai-embed-large", "query", true);
    assert.equal(result, "Represent this sentence for searching relevant passages: hello world");
  });

  it("未知のモデルはプレフィックスなし", () => {
    const result = applyTaskPrefix("hello world", "text-embedding-3-small", "store", true);
    assert.equal(result, "hello world");
  });

  it("taskAware=false の場合はプレフィックスなし", () => {
    const result = applyTaskPrefix("hello world", "nomic-embed-text", "store", false);
    assert.equal(result, "hello world");
  });

  it("空文字でもプレフィックスが付与される", () => {
    const result = applyTaskPrefix("", "nomic-embed-text", "query", true);
    assert.equal(result, "search_query: ");
  });
});
