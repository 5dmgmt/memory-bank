import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, printHelp } from "../cli.ts";

describe("CLI parseArgs", () => {
  it("コマンドなしの場合は空文字", () => {
    const result = parseArgs(["node", "cli.ts"]);
    assert.equal(result.command, "");
    assert.deepEqual(result.flags, {});
    assert.deepEqual(result.positional, []);
  });

  it("コマンドをパースする", () => {
    const result = parseArgs(["node", "cli.ts", "stats"]);
    assert.equal(result.command, "stats");
  });

  it("フラグをパースする", () => {
    const result = parseArgs(["node", "cli.ts", "list", "--scope", "global", "--limit", "10"]);
    assert.equal(result.command, "list");
    assert.equal(result.flags["scope"], "global");
    assert.equal(result.flags["limit"], "10");
  });

  it("値なしフラグはtrueになる", () => {
    const result = parseArgs(["node", "cli.ts", "export", "--format"]);
    assert.equal(result.flags["format"], "true");
  });

  it("positional引数をパースする", () => {
    const result = parseArgs(["node", "cli.ts", "inspect", "abc-123"]);
    assert.equal(result.command, "inspect");
    assert.deepEqual(result.positional, ["abc-123"]);
  });

  it("--db フラグをパースする", () => {
    const result = parseArgs(["node", "cli.ts", "stats", "--db", "/tmp/test-db"]);
    assert.equal(result.command, "stats");
    assert.equal(result.flags["db"], "/tmp/test-db");
  });

  it("フラグとpositionalが混在しても正しくパースする", () => {
    const result = parseArgs(["node", "cli.ts", "inspect", "--db", "/tmp/db", "my-id"]);
    assert.equal(result.command, "inspect");
    assert.equal(result.flags["db"], "/tmp/db");
    assert.deepEqual(result.positional, ["my-id"]);
  });
});

describe("CLI help", () => {
  it("printHelpが例外を投げない", () => {
    // stdout を捕獲
    const originalLog = console.log;
    let output = "";
    console.log = (msg: string) => { output += msg; };
    try {
      printHelp();
      assert.ok(output.includes("memory-bank CLI"));
      assert.ok(output.includes("stats"));
      assert.ok(output.includes("list"));
      assert.ok(output.includes("inspect"));
      assert.ok(output.includes("export"));
      assert.ok(output.includes("--db"));
    } finally {
      console.log = originalLog;
    }
  });
});
