# Memory Bank Security Audit Report

- Date: 2026-03-08
- Repository: `5dmgmt/memory-bank`
- Audited revision: `52616e0dbb21d59524da048795f21f2e129dc60d`
- Auditor: Codex

## Executive Summary

`memory-bank` に対して、指定された対象ファイルと 14 観点で再監査を実施した。

現行リビジョンでは、監査範囲内で追加の確定的な脆弱性は確認されなかった。過去の監査で指摘した既知の実装問題は修正済みであり、現時点では次の表現が妥当である。

- 指定範囲における既知の脆弱性は修正済み
- 再監査の結果、追加の確定的な脆弱性は確認されなかった

補足として、DNS 事前検証と実接続が分離される構造に由来する一般的な TOCTOU の hardening 余地は残るが、これは現行実装における未修正脆弱性とは評価しない。

## Scope

監査対象ファイル:

- `index.ts`
- `src/store.ts`
- `src/tools.ts`
- `src/retriever.ts`
- `src/embedder.ts`
- `src/scopes.ts`
- `src/reflection.ts`
- `src/noise-filter.ts`
- `cli.ts`
- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`

監査観点:

1. SQLインジェクション / クエリインジェクション
2. SSRF
3. パストラバーサル
4. コマンドインジェクション
5. `eval` / `Function` / 危険な動的実行
6. プロトタイプ汚染
7. 認可バイパス
8. 情報漏洩
9. DoS
10. 入力バリデーション
11. 依存関係のサプライチェーンリスク
12. 安全でない `JSON.parse`
13. レースコンディション
14. Cross-Encoder リランキングでのデータ流出

## Methodology

- 対象ファイルの静的レビュー
- 修正差分の再確認
- 関連制御フローの再点検
- `npm test` 実行
- `npm audit --omit=dev --json` 実行

## Findings

### Confirmed Vulnerabilities

現行リビジョンに対して、監査範囲内で追加の確定的な脆弱性は確認されなかった。

### Hardening Notes

- `src/embedder.ts` の DNS 事前検証は毎回実行されるため、前回までの DNS rebinding 問題は解消している。
- ただし、一般論としては `lookup()` と実際の TCP/TLS 接続は別操作であり、完全な意味での接続先固定ではない。
- この点は `preflight DNS validation` 方式の構造上の限界であり、現行監査では未修正脆弱性としては扱っていない。

## Review Results by Category

### 1. SQL Injection / Query Injection

`where` 句に入る `scope`, `id` などは `sqlEscape()` を経由しており、現行コードで確定的なインジェクション経路は確認されなかった。

### 2. SSRF

`embedding.baseURL` と `retrieval.rerankEndpoint` には URL バリデーションと DNS 解決後の IP 検証が入っている。前回指摘した `embedding.baseURL` の初回のみ検証問題は解消済み。

### 3. Path Traversal

`dbPath` はホーム配下制限、`realpath` ベースの実体確認、既存親ディレクトリの検証が入っており、前回の問題は解消済み。

### 4. Command Injection

`child_process`, `exec`, `spawn` などの危険なコマンド実行は確認されなかった。

### 5. Dynamic Execution

`eval`, `new Function` は使用されていない。動的 `import()` は固定モジュール名に限定されており、現行監査では問題なしと判断した。

### 6. Prototype Pollution

主要な config マージ箇所は既知キーのみを取り込む実装になっており、確定的な汚染経路は確認されなかった。

### 7. Authorization Bypass

`memory_store`, `memory_recall`, `memory_delete`, `memory_update`, `memory_list`, `memory_stats` の ACL は再確認済み。前回の `memory_stats` 問題は解消済み。

### 8. Information Disclosure

初期化失敗ログは `message` のみに制限されている。Cross-Encoder 送信は全文ではなくスニペット化と機密パターンのマスキングが入っている。

### 9. DoS

ツール入力長、`autoRecall` 入力長、CLI `--limit`、`JSON.parse` 前サイズ制限、`listAll`/`count` の制限を確認した。既知の無制限入力問題は解消済み。

### 10. Input Validation

ツール引数、CLI 引数、`textHash` 形式、数値の clamp を確認した。確定的な入力検証不備は確認されなかった。

### 11. Dependency / Supply Chain

`npm audit --omit=dev --json` の結果、既知脆弱性は `0` 件だった。

実解決版:

- `@lancedb/lancedb`: `0.26.2`
- `openai`: `6.27.0`
- `jiti`: `2.6.1`
- `typescript`: `5.9.3`

### 12. Unsafe JSON.parse

`src/reflection.ts` の `parseReflectionOutput()` は入力サイズ制限と型チェックを持ち、現行監査では問題なしと判断した。

### 13. Race Condition

前回指摘した lesson 重複排除の fallback 問題は、`src/store.ts` の fail-closed ロック実装で解消されたことを確認した。

### 14. Cross-Encoder Data Exfiltration

外部送信自体は機能仕様に含まれるが、データはスニペット化され、機密パターンのマスキングも行われる。現行監査では未修正脆弱性とは扱わない。

## Historical Fixes Confirmed

過去の監査で指摘した以下の問題は、現行コードで解消を確認した。

- `where` 句インジェクション対策
- `memory_delete` / `memory_update` / `memory_stats` の ACL 強化
- `dbPath` の単純 prefix 判定問題
- `autoRecall` / `autoCapture` / ツール入力のサイズ制限不足
- `existsByTextHash()` の不完全な検索
- lesson 重複排除の race 緩和不足
- `embedding.baseURL` の DNS 検証不備
- `parseReflectionOutput()` の無制限 `JSON.parse`
- Cross-Encoder の全文送信

## Verification

実施コマンド:

```bash
npm test
npm audit --omit=dev --json
```

結果:

- `npm test`: `87/87 pass`
- `npm audit --omit=dev --json`: `0 vulnerabilities`

## Conclusion

現行リビジョン `52616e0dbb21d59524da048795f21f2e129dc60d` に対する本監査の結論は次のとおり。

- 指定範囲における既知の脆弱性は修正済み
- 再監査の結果、追加の確定的な脆弱性は確認されなかった

厳密な hardening をさらに進める余地はあるが、現時点で未修正の確定脆弱性として報告すべき事項はない。
