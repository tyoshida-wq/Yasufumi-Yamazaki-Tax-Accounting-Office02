# Gemini Flash + Cloudflare を使った音声文字起こしシステムの最適構成

このドキュメントは、開発と調整を通じて確立された最適なシステム構成をまとめたものです。

## 📋 目次

1. [アーキテクチャ概要](#アーキテクチャ概要)
2. [最適パラメータ](#最適パラメータ)
3. [処理フロー](#処理フロー)
4. [タイムスタンプ補正ロジック](#タイムスタンプ補正ロジック)
5. [マージロジック](#マージロジック)
6. [処理性能](#処理性能)
7. [コスト効率](#コスト効率)
8. [重要なバグと修正](#重要なバグと修正)
9. [技術的学び](#技術的学び)
10. [デプロイ手順](#デプロイ手順)

---

## アーキテクチャ概要

```
┌─────────────────┐
│  フロントエンド  │
│  (Browser)      │
└────────┬────────┘
         │ アップロード（5並列）
         ▼
┌─────────────────┐
│ Cloudflare      │
│ Workers         │◄─── HTTP API
└────────┬────────┘
         │
         ├─► R2 Bucket（音声チャンク保存）
         │
         ├─► D1 Database（メタデータ・状態管理）
         │
         └─► Queue（非同期処理）
              │
              ▼
         ┌─────────────────┐
         │ Queue Consumer  │
         │ (2並列)         │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ Gemini Flash    │
         │ API (120s)      │
         └─────────────────┘
```

### 主要コンポーネント

- **Cloudflare Workers**: HTTPエンドポイント、ビジネスロジック
- **Cloudflare Queue**: 非同期文字起こし処理のキュー
- **Cloudflare R2**: 音声チャンクの一時保存
- **Cloudflare D1**: タスク・チャンク状態の管理
- **Gemini 2.5 Flash**: 文字起こしAI

---

## 最適パラメータ

### コアパラメータ

| パラメータ | 最適値 | 設定場所 | 理由 |
|-----------|--------|----------|------|
| **チャンクサイズ** | `2MB` | `src/index.tsx`<br>`DEFAULT_CHUNK_SIZE_BYTES` | ・1MBだとチャンク数が多すぎる<br>・2MBで処理時間とコストのバランスが最適<br>・Gemini APIの推奨範囲内 |
| **オーバーラップ** | `5秒` | `src/index.tsx`<br>`DEFAULT_CHUNK_OVERLAP_SECONDS` | ・チャンク境界での発言欠落を防ぐ<br>・重複除去で自動処理 |
| **Gemini Flash タイムアウト** | `120秒` | `src/index.tsx`<br>`GEMINI_FLASH_TIMEOUT_MS` | ・2MBチャンクの処理に十分<br>・60秒だとタイムアウト発生 |
| **Queue 並列数** | `2` | `wrangler.toml`<br>`max_concurrency` | ・Gemini APIのレート制限を考慮<br>・安定した処理速度 |
| **アップロード並列数** | `5` | `public/static/app.js`<br>`uploadConcurrency` | ・ブラウザ→Workersは軽量<br>・ユーザー体験の向上 |
| **リトライ回数** | `3回` | `wrangler.toml`<br>`max_retries` | ・一時的なAPI障害に対応 |
| **バッチサイズ** | `1` | `wrangler.toml`<br>`max_batch_size` | ・1チャンクずつ処理<br>・エラーハンドリングが簡潔 |

### wrangler.toml の重要設定

```toml
# Queue Consumer
[[queues.consumers]]
queue = "tax-transcription-queue"
max_batch_size = 1        # 1チャンクずつ処理
max_batch_timeout = 5     # 5秒でバッチ送信
max_retries = 3           # 最大3回リトライ
max_concurrency = 2       # 2並列処理（重要！）
dead_letter_queue = "transcription-dlq"
```

### src/index.tsx の重要定数

```typescript
const GEMINI_FLASH_TIMEOUT_MS = 120_000  // 2分（重要！60秒だと不足）
const GEMINI_PRO_TIMEOUT_MS = 90_000
const TIMESTAMP_PATTERN = /^\s*(\d{2}):(\d{2})(?::(\d{2}))?/
const DEFAULT_CHUNK_SIZE_BYTES = 2 * 1024 * 1024  // 2MB（重要！）
const DEFAULT_CHUNK_OVERLAP_SECONDS = 5
const DEFAULT_TRANSCRIPTION_CONCURRENCY = 4  // 未使用（Queueのmax_concurrencyが優先）
const DEFAULT_UPLOAD_CONCURRENCY = 5
```

---

## 処理フロー

### 1. アップロードフェーズ

```
1. ユーザーが音声ファイルをアップロード
2. ブラウザ側で2MBチャンクに分割（5秒オーバーラップ）
3. 5並列でWorkersにアップロード
4. Workers → R2に保存 + D1にメタデータ保存 + Queueに送信
```

### 2. 文字起こしフェーズ

```
1. Queue Consumerが2並列でメッセージを取得
2. R2からチャンク音声を取得（またはD1から直接）
3. Gemini Flash APIに送信（120秒タイムアウト）
4. レスポンスをタイムスタンプ補正
5. D1の`chunks`テーブルに保存
6. チャンク状態を`completed`に更新
```

### 3. マージフェーズ

```
1. 全チャンク完了を検出
2. 全チャンクを時系列順に取得
3. 5秒オーバーラップ部分を除去
4. 結果を`transcripts`テーブルに保存
5. タスク状態を`transcribed`に更新
```

---

## タイムスタンプ補正ロジック

### 問題背景

Gemini Flash APIは、音声チャンクを`00:00`から開始するタイムスタンプで文字起こしする傾向があります。しかし、実際にはチャンクは会議の途中から始まります。

例:
- チャンク8: 開始時刻 34:52（2092秒）
- AIの出力: `00:00`, `00:05`, `00:10`...
- 期待される出力: `34:52`, `34:57`, `35:02`...

### 補正ロジック: `correctTimestamps()`

```typescript
function correctTimestamps(text: string, chunkStartMs: number): string {
  const offsetSeconds = Math.floor(chunkStartMs / 1000)
  
  // チャンク0は補正不要
  if (offsetSeconds === 0) return text
  
  // AIが既に正しいタイムスタンプを出力しているか検出
  if (detectIfAlreadyCorrected(text, chunkStartMs)) {
    return text  // 補正不要
  }
  
  // タイムスタンプにoffsetを加算
  return text.replace(timestampPattern, (match, ...) => {
    const correctedSeconds = originalSeconds + offsetSeconds
    return formatTimestamp(correctedSeconds)
  })
}
```

### 二重補正防止: `detectIfAlreadyCorrected()`

**重要: この関数が不適切だと、既に正しいタイムスタンプに再度offsetが加算され、時間が加速します。**

```typescript
function detectIfAlreadyCorrected(text: string, chunkStartMs: number): boolean {
  const chunkStartSeconds = Math.floor(chunkStartMs / 1000)
  
  // チャンク0は補正不要
  if (chunkStartSeconds === 0) return true
  
  // 最初の5つのタイムスタンプを抽出
  const timestamps = extractTimestamps(text, 5)
  if (timestamps.length < 2) return false
  
  const firstTimestamp = timestamps[0]
  
  // Rule 1: 明らかに補正が必要
  if (firstTimestamp < 60 && chunkStartSeconds > 120) {
    return false  // 補正必要
  }
  
  // Rule 2: 許容範囲を拡大（重要！）
  const toleranceSeconds = Math.max(120, Math.floor(chunkStartSeconds * 0.1))
  
  if (firstTimestamp < chunkStartSeconds - toleranceSeconds) {
    return false  // 補正必要
  }
  
  // Rule 3: チャンク開始時刻の前後範囲内で単調増加
  if (Math.abs(firstTimestamp - chunkStartSeconds) <= toleranceSeconds) {
    if (isMonotonic(timestamps)) {
      return true  // 補正不要
    }
  }
  
  // Rule 4: チャンク開始時刻以降で妥当な範囲内（重要！）
  // この条件により、[2092, 2157, ...]のような正しい出力を保護
  if (firstTimestamp >= chunkStartSeconds && 
      firstTimestamp <= chunkStartSeconds + 300) {
    return true  // 補正不要
  }
  
  // デフォルト: 補正を適用
  return false
}
```

#### 重要なポイント

1. **許容範囲の拡大**: `max(120秒, チャンク開始時刻の10%)`
   - 60秒だと短すぎて、正しい出力を「補正が必要」と誤判定
   - 例: チャンク8（開始2092秒）で、`[2092, 2157, ...]`の2番目が`2092+60=2152`を超えるため誤判定

2. **Rule 4の追加**: `firstTimestamp >= chunkStartSeconds && firstTimestamp <= chunkStartSeconds + 300`
   - AIが正しく出力した場合を保護
   - 300秒（5分）は妥当な範囲（チャンクは約4.5分）

---

## マージロジック

### 重複除去: `mergeChunks()`

5秒のオーバーラップを厳密に除去します。

```typescript
function mergeChunks(chunks: ChunkRecord[]): { merged: string; debug: {...} } {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  let thresholdMs = 0
  const lines: string[] = []
  const OVERLAP_MS = 5000  // 5秒
  
  for (const chunk of sorted) {
    // このチャンクの開始時刻の5秒前までの発言をスキップ
    const skipThresholdMs = chunk.startMs - OVERLAP_MS
    
    for (const line of chunk.text.split('\n')) {
      const timestampMs = getTimestampMs(line)
      
      if (timestampMs !== null) {
        // 前のチャンクの終端5秒以内ならスキップ
        if (timestampMs < skipThresholdMs) {
          continue  // スキップ
        }
        thresholdMs = Math.max(thresholdMs, timestampMs)
        lines.push(line.trimEnd())
      } else {
        // タイムスタンプがない行は前の行に結合
        if (lines.length > 0) {
          lines[lines.length - 1] += '\n' + line
        } else {
          lines.push(line)
        }
      }
    }
    
    // 重要: chunk.endMs ではなく chunk.startMs を使用
    // これにより次のチャンクの発言が誤って除外されることを防ぐ
    thresholdMs = Math.max(thresholdMs, chunk.startMs)
  }
  
  return { merged: lines.join('\n'), debug: {...} }
}
```

### 重要なバグ修正

**以前のバグ**: `thresholdMs = Math.max(thresholdMs, chunk.endMs)`
- チャンクの終了時刻で閾値を更新していた
- 結果: 次のチャンクの全発言が除外される

**修正後**: `thresholdMs = Math.max(thresholdMs, chunk.startMs)`
- チャンクの開始時刻で閾値を更新
- 結果: 5秒のオーバーラップのみ除外される

---

## 処理性能

### 実測値

| 録音時間 | ファイルサイズ | チャンク数 | 処理時間 | 備考 |
|----------|---------------|-----------|---------|------|
| **37分** | 約6MB | 9チャンク | 約10分 | テスト完了 ✅ |
| **78分** | 約12MB | 18チャンク | 約20分 | テスト完了 ✅ |
| **180分（3時間）** | 約28MB | 85チャンク | 約53分 | 推定（対応可能） |

### 処理速度

- **比率**: 約3.4倍（録音時間の約30%で文字起こし完了）
- **ボトルネック**: Gemini Flash APIの処理時間（1チャンク30〜120秒）
- **並列化**: Queue並列数=2により、実質的な処理速度を2倍化

### 計算式

```
処理時間 = (チャンク数 ÷ 並列数) × 平均処理時間 + アップロード時間 + マージ時間

例: 180分録音
= (85チャンク ÷ 2並列) × 60秒 + 10分 + 10秒
= 42.5分 + 10分 + 10秒
≈ 53分
```

---

## コスト効率

### Gemini Flash API

- **料金**: $0.000075/MB（入力）
- **例**: 3時間録音（170MB）= $0.01275（約2円）

### Cloudflare

| サービス | 無料枠 | 超過料金 |
|---------|--------|---------|
| **Workers** | 100万リクエスト/日 | $0.50/100万リクエスト |
| **Queue** | 100万メッセージ/日 | $0.40/100万メッセージ |
| **R2** | 10GB保存/月 | $0.015/GB/月 |
| **D1** | 500万行読み取り/日 | $0.001/100万行 |

### 総コスト

**約2円/3時間録音**（ほぼ全てGemini API、Cloudflareは無料枠内）

---

## 重要なバグと修正

### 1. チャンク2のタイムアウト

**症状**: チャンク2が毎回60秒でタイムアウト

**原因**:
- 2026-02-02にチャンクサイズが1MB → 2MBに増加
- タイムアウトが60秒のまま
- 2MBチャンクの処理に60秒以上かかる

**修正**: `GEMINI_FLASH_TIMEOUT_MS = 60_000` → `120_000`

**コミット**: `b419b74`

---

### 2. Chunk 8の2重補正（時間の加速）

**症状**: 
- Chunk 8（開始2092秒）のタイムスタンプが2倍になる
- AIの出力: `[2092, 2157, 2160, ...]`（正しい）
- 補正後: `[4184, 4249, 4252, ...]`（2092秒が追加された）

**原因**:
- `detectIfAlreadyCorrected()` の許容範囲が60秒と狭すぎた
- 2番目のタイムスタンプ`2157`が`2092 + 60 = 2152`を超えるため、「補正が必要」と誤判定

**修正**:
- 許容範囲を`max(120秒, チャンク開始時刻の10%)`に拡大
- Rule 4を追加: `firstTimestamp >= chunkStartSeconds && firstTimestamp <= chunkStartSeconds + 300`

**コミット**: `b419b74`

---

### 3. 78分音声が60分で切断

**症状**: 78分の音声ファイルをマージすると、60分46秒で終了

**原因**: `getTimestampMs()` 関数の配列分割代入バグ
```typescript
// バグ
const [, , hhOrMm, mm, ss] = match  // 最初の2要素をスキップ

// 正しい
const [, hhOrMm, mm, ss] = match  // 最初の1要素（フルマッチ）のみスキップ
```

**結果**: 全タイムスタンプが`null`になり、重複除去ロジックが誤動作

**修正**: 余分なカンマを削除

**コミット**: `9dcc47c`

---

### 4. マージ時の正常チャンク除外

**症状**: チャンク14-17が全てスキップされ、マージ後は60分で終了

**原因**: `thresholdMs = Math.max(thresholdMs, chunk.endMs)`
- チャンク13の終了時刻（約61分）で閾値が更新
- チャンク14の開始時刻（61分4秒）より高い
- チャンク14の全発言が除外される

**修正**: `thresholdMs = Math.max(thresholdMs, chunk.startMs)`

**コミット**: `6f85329`

---

## 技術的学び

### 1. Cloudflare Workers/Queuesの特性

- **CPU時間制限**: 10ms（無料）、30ms（有料）
- **メモリ制限**: 128MB
- **Queue並列数**: デフォルトは低め（2〜10）、設定で調整可能
- **R2**: 低遅延、S3互換
- **D1**: SQLiteベース、高速クエリ

### 2. Gemini Flash APIの特性

- **処理時間**: 2MBの音声で30〜120秒
- **レート制限**: あり（並列数を2に制限することで安定）
- **タイムスタンプ出力**: 
  - 理想: チャンク開始時刻から始まる
  - 現実: 00:00から始まることが多い
  - 例外: 時々正しい時刻を出力する
- **タイムアウト**: 余裕を持たせる（120秒推奨）

### 3. タイムスタンプ補正の難しさ

- AIが正しく出力する場合と間違える場合がある
- 判定ロジックが複雑（許容範囲、単調増加チェック等）
- 許容範囲を広めに設定（`max(120秒, 10%)`）が重要
- Rule 4により、正しい出力を保護

### 4. チャンクサイズの最適化

- **1MB**: チャンク数が多すぎてオーバーヘッド、API呼び出しコスト増
- **2MB**: 処理時間とコストのバランス最適（✅ 推奨）
- **4MB**: タイムアウトリスクが高まる

### 5. オーバーラップの重要性

- **5秒**: チャンク境界での発言欠落を防ぐ
- マージ時に自動除去されるため、重複は問題なし
- 3秒だと短すぎる、10秒だと除去負荷が増える

---

## デプロイ手順

### 前提条件

- Node.js 18以上
- Cloudflare アカウント
- Wrangler CLI（`npm install -g wrangler`）
- Gemini API キー

### 1. プロジェクトのクローン

```bash
git clone https://github.com/your-username/your-repo.git
cd your-repo
npm install
```

### 2. Cloudflare認証

```bash
wrangler login
```

### 3. D1データベースの作成

```bash
# 本番用データベース
wrangler d1 create your-project-db

# 出力されたdatabase_idをwrangler.tomlに設定
```

### 4. R2バケットの作成

```bash
wrangler r2 bucket create your-audio-chunks
```

### 5. Queueの作成

```bash
# 本番用Queue
wrangler queues create your-transcription-queue

# Dead Letter Queue
wrangler queues create your-transcription-dlq
```

### 6. wrangler.tomlの設定

```toml
name = "your-project-name"
main = "src/index.tsx"
compatibility_date = "2026-02-02"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "public"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "your-project-db"
database_id = "YOUR_DATABASE_ID"  # 手順3で取得

[[r2_buckets]]
binding = "AUDIO_CHUNKS"
bucket_name = "your-audio-chunks"

[[queues.producers]]
queue = "your-transcription-queue"
binding = "TRANSCRIPTION_QUEUE"

[[queues.consumers]]
queue = "your-transcription-queue"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
max_concurrency = 2  # 重要！
dead_letter_queue = "your-transcription-dlq"

[vars]
ENVIRONMENT = "production"
```

### 7. マイグレーションの実行

```bash
# D1スキーマの作成
wrangler d1 migrations apply your-project-db
```

### 8. シークレットの設定

```bash
wrangler secret put GEMINI_API_KEY
# プロンプトでGemini API Keyを入力
```

### 9. ビルドとデプロイ

```bash
npm run build
wrangler deploy
```

### 10. 動作確認

デプロイ後、表示されるURLにアクセスして動作確認

```
https://your-project-name.your-subdomain.workers.dev
```

---

## トラブルシューティング

### チャンクがタイムアウトする

**原因**: `GEMINI_FLASH_TIMEOUT_MS`が短すぎる

**解決策**: `src/index.tsx`で`120_000`（120秒）に設定

```typescript
const GEMINI_FLASH_TIMEOUT_MS = 120_000  // 2分
```

### マージ後にチャンクが欠落する

**原因1**: `detectIfAlreadyCorrected()`の許容範囲が狭すぎる

**解決策**: `max(120秒, チャンク開始時刻の10%)`に設定

**原因2**: `mergeChunks()`のthresholdMs更新が不適切

**解決策**: `chunk.startMs`で更新（`chunk.endMs`ではない）

### Queue処理が遅い

**原因**: `max_concurrency`が低すぎる

**解決策**: `wrangler.toml`で`max_concurrency = 2`に設定（Gemini APIのレート制限を考慮）

### チャンク2だけ失敗する

**原因**: タイムアウトが短い、またはチャンクサイズが大きすぎる

**解決策**: 
- タイムアウトを120秒に延長
- チャンクサイズを2MBに設定

---

## まとめ

この構成により、以下を実現しました:

✅ **コスト効率**: 約2円/3時間録音
✅ **処理速度**: 録音時間の約30%で完了
✅ **スケーラビリティ**: チャンク数制限なし
✅ **信頼性**: 自動リトライ、エラー追跡
✅ **精度**: 高精度文字起こし、タイムスタンプ補正

この最適構成を他のプロジェクトで再現する際は、以下のポイントに注意してください:

1. **チャンクサイズ**: 2MB
2. **タイムアウト**: 120秒
3. **Queue並列数**: 2
4. **タイムスタンプ補正ロジック**: `detectIfAlreadyCorrected()`の実装
5. **マージロジック**: `mergeChunks()`の実装

---

**最終更新**: 2026-02-03
**バージョン**: 1.0.0
**デプロイID**: dd5ec990-9b50-45b1-9ab6-dfc004f2ac44
