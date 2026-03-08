import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createScopeManager } from "../src/scopes.ts";

describe("ScopeManager", () => {
  it("デフォルトスコープを返す", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve(), "global");
  });

  it("カスタムデフォルトスコープ", () => {
    const sm = createScopeManager({ defaultScope: "workspace" });
    assert.equal(sm.resolve(), "workspace");
  });

  it("agentIdがあればagent:プレフィックスのスコープを返す", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent"), "agent:my-agent");
  });

  it("明示的スコープが定義済みならそちらを優先", () => {
    const sm = createScopeManager({
      definitions: { project: { description: "プロジェクト用" } },
    });
    assert.equal(sm.resolve("my-agent", "project"), "project");
  });

  it("未定義の明示的スコープはagent:にフォールバック", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent", "unknown-scope"), "agent:my-agent");
  });

  it("agent:プレフィックスのスコープは有効と判定", () => {
    const sm = createScopeManager();
    assert.equal(sm.isValid("agent:test"), true);
  });

  it("組み込みスコープを列挙", () => {
    const sm = createScopeManager();
    const scopes = sm.listScopes();
    assert.ok(scopes.includes("global"));
    assert.ok(scopes.includes("_system"));
  });

  // Phase 3: project: / user: プレフィックス
  it("project:プレフィックスのスコープは有効と判定", () => {
    const sm = createScopeManager();
    assert.equal(sm.isValid("project:my-project"), true);
  });

  it("user:プレフィックスのスコープは有効と判定", () => {
    const sm = createScopeManager();
    assert.equal(sm.isValid("user:alice"), true);
  });

  it("project:スコープをresolveで使用できる", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent", "project:my-project"), "project:my-project");
  });

  it("user:スコープをresolveで使用できる", () => {
    const sm = createScopeManager();
    assert.equal(sm.resolve("my-agent", "user:bob"), "user:bob");
  });

  // Phase 3: canAccess アクセス制御
  it("agentAccess未設定なら全スコープにアクセス可", () => {
    const sm = createScopeManager();
    assert.equal(sm.canAccess("any-agent", "global"), true);
    assert.equal(sm.canAccess("any-agent", "project:x"), true);
  });

  it("agentAccessに当該エージェントが未登録なら全許可", () => {
    const sm = createScopeManager({
      agentAccess: { "restricted-agent": ["global"] },
    });
    assert.equal(sm.canAccess("other-agent", "global"), true);
    assert.equal(sm.canAccess("other-agent", "project:secret"), true);
  });

  it("agentAccessで許可されたスコープにはアクセス可", () => {
    const sm = createScopeManager({
      agentAccess: { "agent-a": ["global", "project:docs"] },
    });
    assert.equal(sm.canAccess("agent-a", "global"), true);
    assert.equal(sm.canAccess("agent-a", "project:docs"), true);
  });

  it("agentAccessで許可されていないスコープはアクセス不可", () => {
    const sm = createScopeManager({
      agentAccess: { "agent-a": ["global"] },
    });
    assert.equal(sm.canAccess("agent-a", "project:secret"), false);
    assert.equal(sm.canAccess("agent-a", "user:admin"), false);
  });

  it("agentAccessでワイルドカード '*' は全スコープ許可", () => {
    const sm = createScopeManager({
      agentAccess: { "super-agent": ["*"] },
    });
    assert.equal(sm.canAccess("super-agent", "global"), true);
    assert.equal(sm.canAccess("super-agent", "project:anything"), true);
    assert.equal(sm.canAccess("super-agent", "user:anyone"), true);
  });

  it("agentAccessで空配列の場合は全スコープ不可", () => {
    const sm = createScopeManager({
      agentAccess: { "sandbox-agent": [] },
    });
    assert.equal(sm.canAccess("sandbox-agent", "global"), false);
  });
});
