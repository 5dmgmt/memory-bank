/**
 * 基本テスト — ノイズフィルターとリフレクションパーサー
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ノイズフィルターのテスト（直接インポートできないためロジックを再現）
const NOISE_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it)\s*[.!?]?$/i,
  /^(こんにちは|ありがとう|はい|いいえ|了解|わかりました|おはよう)\s*[。！？]?$/,
  /^.{0,5}$/,
  /^(i (can't|cannot|don't|won't)|sorry,? (i|but)|i('m| am) (not able|unable))/i,
  /^(申し訳|すみません|できません|対応できません)/,
];

function isNoise(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  return NOISE_PATTERNS.some((p) => p.test(trimmed));
}

describe("noise filter", () => {
  it("短すぎるテキストをノイズと判定", () => {
    assert.equal(isNoise("hi"), true);
    assert.equal(isNoise("ok"), true);
    assert.equal(isNoise(""), true);
  });

  it("挨拶をノイズと判定", () => {
    assert.equal(isNoise("hello"), true);
    assert.equal(isNoise("こんにちは"), true);
    assert.equal(isNoise("ありがとう"), true);
  });

  it("実質的な内容はノイズでないと判定", () => {
    assert.equal(isNoise("TypeScriptでは型推論が強力です"), false);
    assert.equal(isNoise("LanceDBのベクトル検索を使ってメモリを実装する"), false);
  });
});

// リフレクションパーサーのテスト
function parseReflectionOutput(output) {
  const jsonMatch = output.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item) =>
          typeof item.text === "string" &&
          typeof item.category === "string" &&
          typeof item.importance === "number"
      )
      .map((item) => ({
        text: item.text.slice(0, 500),
        category: item.category,
        importance: Math.min(1, Math.max(0, item.importance)),
      }));
  } catch {
    return [];
  }
}

describe("reflection parser", () => {
  it("正常なJSON配列をパース", () => {
    const input = `[{"text":"テスト","category":"fact","importance":0.8}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, "テスト");
    assert.equal(result[0].category, "fact");
  });

  it("テキスト中のJSON配列を抽出", () => {
    const input = `以下が抽出結果です:\n[{"text":"学び","category":"reflection","importance":0.9}]\n以上です。`;
    const result = parseReflectionOutput(input);
    assert.equal(result.length, 1);
  });

  it("不正な入力で空配列を返す", () => {
    assert.deepEqual(parseReflectionOutput("no json here"), []);
    assert.deepEqual(parseReflectionOutput(""), []);
  });

  it("importanceを0-1にクランプ", () => {
    const input = `[{"text":"test","category":"fact","importance":5.0}]`;
    const result = parseReflectionOutput(input);
    assert.equal(result[0].importance, 1);
  });
});
