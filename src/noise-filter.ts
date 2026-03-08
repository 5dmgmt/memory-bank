/**
 * ノイズフィルター
 * 無意味な記憶（挨拶、メタ質問、定型文）を除外
 */

const NOISE_PATTERNS = [
  // 挨拶・定型
  /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|got it)\s*[.!?]?$/i,
  /^(こんにちは|ありがとう|はい|いいえ|了解|わかりました|おはよう)\s*[。！？]?$/,
  // 短すぎる
  /^.{0,5}$/,
  // エージェントの断り文句
  /^(i (can't|cannot|don't|won't)|sorry,? (i|but)|i('m| am) (not able|unable))/i,
  /^(申し訳|すみません|できません|対応できません)/,
  // メタ質問
  /^(what can you do|how do you work|who are you|are you an? ai)/i,
  /^(あなたは誰|何ができ(ます|る)|どう(やって|動い))/,
];

/**
 * テキストがノイズかどうかを判定
 */
export function isNoise(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * 検索結果からノイズを除去
 */
export function filterNoise<T extends { entry: { text: string } }>(results: T[]): T[] {
  return results.filter((r) => !isNoise(r.entry.text));
}
