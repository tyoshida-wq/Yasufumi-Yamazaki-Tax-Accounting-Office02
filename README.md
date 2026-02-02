# 税理士事務所向け AI議事録生成 MVP

## プロジェクト概要
- **名称**: webapp
- **目的**: 税理士事務所の定例会議や顧問先との打合せ録音から、タイムスタンプ付き全文文字起こしと議事録を自動生成する。
- **対象**: 最長3時間（約180分）の音声データ。
- **キーモデル**: 文字起こしに *Gemini 3.0 Flash Preview*、議事録生成に *Gemini 3.0 Pro Preview* を使用。

## 主な機能
- ブラウザ内録音（MediaRecorder）と既存音声ファイルのアップロードに対応。
- フロントエンドで約 1MB ごとに音声を分割し、5 秒のオーバーラップを付与したチャンクを生成。
- 各チャンクは Cloudflare Workers (Hono) の非同期キューに投入され、Gemini 3.0 Flash Preview を最大 4 並列で呼び出してタイムスタンプ付き文字起こし。
- タイムスタンプを基準にチャンク結果を再結合し、全文を Cloudflare KV に保存。
- Gemini 3.0 Pro Preview で税理士事務所向け議事録テンプレート（概要/決定事項/TODO/リスク/フォローアップ/重要タイムライン）を生成。
- Gemini API 呼び出しにタイムアウトと指数バックオフ付きリトライ（Flash 最大4回 / Pro 最大3回）を適用。
- 文字起こし全文および議事録のコピー、ダウンロード (TXT/Markdown) に対応。
- フロントエンドで進捗ログ・APIレスポンス、キュー状態（待機/処理中/完了/エラー）・サーバーログをリアルタイム表示。
- 約 6 秒ごとに `/status` をポーリングし、未処理チャンクの再処理・結合再試行ボタンを自動表示することでリカバリを支援。
- チャンク処理の停滞を 3 回検知すると自動で `/process?reason=auto` を呼び出し、サーバー側ログにも `Chunk queue stalled` を記録。

## アーキテクチャ
```
ブラウザ (Tailwind + Vanilla JS)
  ├─ 音声録音 / ファイル選択
  ├─ 1MB チャンク化（5秒オーバーラップ）
  └─ Hono API 呼び出し（最大3並列送信）

Cloudflare Pages + Workers (Hono)
  ├─ チャンク処理キュー（最大4並列で Gemini Flash を呼び出し）
  ├─ /api/tasks                … タスク作成
  ├─ /api/tasks/:id/chunks     … チャンク文字起こし (Gemini Flash)
  ├─ /api/tasks/:id/merge      … タイムスタンプ結合
  ├─ /api/tasks/:id/minutes    … 議事録生成 (Gemini Pro)
  ├─ /api/tasks/:id/status     … 進捗確認
  └─ Cloudflare KV (TASKS_KV)  … タスク/チャンク/全文/議事録保存
```

## API エンドポイント一覧
| メソッド | パス | 用途 |
|----------|------|------|
| `POST` | `/api/tasks` | 新規タスク作成（チャンク総数・ファイル情報） |
| `GET` | `/api/tasks/:taskId/status` | 処理状況、全文/議事録の有無を返却 |
| `POST` | `/api/tasks/:taskId/chunks` | チャンク音声を送信し、Gemini Flash で文字起こし |
| `POST` | `/api/tasks/:taskId/process` | キューに残るチャンクの処理をトリガー。`?reason=manual|auto` を指定可能 |
| `GET` | `/api/tasks/:taskId/logs` | タスクごとのサーバーログ（最新60件まで）を取得 |
| `POST` | `/api/tasks/:taskId/merge` | チャンク全文をタイムスタンプ基準で結合（未完了時は409 + chunkSummary を返却） |
| `GET` | `/api/tasks/:taskId/transcript` | 結合済み全文を取得 |
| `POST` | `/api/tasks/:taskId/minutes` | Gemini Pro で議事録生成 |
| `GET` | `/api/tasks/:taskId/minutes` | 生成済み議事録を取得 |
| `GET` | `/api/config` | クライアント設定（チャンクサイズ・並列数など）を取得 |
| `GET` | `/api/healthz` | 簡易ヘルスチェック |

### タスク状態管理
- `TASKS_KV` に `task:${id}`, `task:${id}:job:${index}`, `task:${id}:chunk:${index}`, `task:${id}:chunk-state:${index}`, `task:${id}:transcript`, `task:${id}:minutes` を保存。
- ステータス: `initialized` → `transcribing` → `transcribed` → `completed`。エラー時 `error`。
- チャンク状態: `queued` / `processing` / `completed` / `error` を `task:${id}:chunk-state:${index}` で追跡。
- `/api/tasks/:taskId/process` 実行時に `reason` とキュー残数をサーバーログへ記録。停滞が続くと `Chunk queue stalled after reprocess attempt` を警告出力。

## デプロイ状況
- **本番**: https://yasufumi-yamazaki-tax-accounting-office02.pages.dev
- **最新デプロイ ID**: `2f9a243d-9049-490f-8fe0-bcad7cd21c08`（2026-02-02 01:58 UTC）
- **ステータス**: ✅ 稼働中
- **メモ**: `__STATIC_CONTENT_MANIFEST` 未定義エラーは `hono/cloudflare-pages` アダプター利用と再ビルド済み。Gemini API 呼び出しのリトライ/タイムアウト、サーバーログ可視化、チャンクサイズ最適化（約1MB）とキュー並列処理（最大4並列）を反映。

## フロントエンドフロー
1. 音声録音またはファイル選択。
2. 音声を約 1MB チャンク + 5 秒オーバーラップで分割（時間はファイルサイズと全体長から推定）。
3. 各チャンクを最大 3 並列でアップロードしつつ `/status` をポーリングして進捗とサーバーログを更新。
4. サマリ上で待機/処理中が無くなり、エラーが無いことを確認してから `/merge` を実行（未完了時は UI が自動的に再処理/再結合ボタンを表示）。
5. 必要に応じて「議事録生成」ボタンで `/minutes` を呼び出す。
6. 結果をコピーまたはダウンロード可能。

- UI の「未処理チャンクを再処理」ボタンは `/api/tasks/:taskId/process?reason=manual` を呼び出して残チャンクを再キューイングします。
- `/status` ポーリングでキュー停滞を検知すると自動的に `/api/tasks/:taskId/process?reason=auto` を実行します（サーバーログに記録）。
- 「結合を再試行」ボタンは再度 `/api/tasks/:taskId/merge` を試行し、準備完了後に全文を取得できます。

> **注意**: チャンク時間は平均ビットレートから算出するため可逆的ではありません。実運用時は音声のエンコード条件に応じた補正・メタデータ利用をご検討ください。

## セットアップ
### 事前準備
- Node.js 18 以上、npm 10 以上。
- Cloudflare アカウント（Pages/Workers 有効）。
- Gemini API キー（Google AI Studio / Vertex AI などで取得）。
- Cloudflare KV 名前空間（`TASKS_KV`）。

### ローカル開発
```bash
npm install
npm run build          # SSR bundle を生成
npm run preview        # wrangler pages dev を起動
```
開発中は `npm run dev` で Vite 開発サーバー、Cloudflare Workers 実機テストは `npm run preview` を推奨。

### Secrets / Bindings
```bash
# Gemini API キーを Workers Secret に登録
wrangler secret put GEMINI_API_KEY

# KV 名前空間を wrangler.jsonc に設定
"kv_namespaces": [
  {
    "binding": "TASKS_KV",
    "id": "YOUR_PRODUCTION_ID",
    "preview_id": "YOUR_PREVIEW_ID"
  }
]
```
Cloudflare Pages で運用する場合、`wrangler pages project create` → `wrangler pages deploy dist --project-name <project>` を利用します。

### 設定値 (.dev.vars / Secrets)
| KEY | 役割 | 既定値 |
|-----|------|--------|
| `GEMINI_API_KEY` | Gemini Flash / Pro API への認証トークン。Cloudflare Secret で管理。 | （必須・値なし） |
| `CHUNK_SIZE_BYTES` | 1 チャンクのバイトサイズ。フロント/サーバー双方に配信。 | `1048576` (≒1MB) |
| `CHUNK_OVERLAP_SECONDS` | チャンク間のオーバーラップ秒数。 | `5` |
| `TRANSCRIPTION_MAX_CONCURRENCY` | Gemini Flash 呼び出しの最大並列数（Workers 側）。 | `4` |
| `CHUNK_JOB_MAX_ATTEMPTS` | 1 チャンクに対するキュー再試行上限。 | `6` |
| `UPLOAD_CONCURRENCY` | フロントエンドが同時に送信するチャンク数。 | `3` |

ローカル環境では `.dev.vars` を利用して上記値を定義できます。

```bash
# .dev.vars (例)
GEMINI_API_KEY="[REDACTED]"
CHUNK_SIZE_BYTES="1048576"
CHUNK_OVERLAP_SECONDS="5"
TRANSCRIPTION_MAX_CONCURRENCY="4"
CHUNK_JOB_MAX_ATTEMPTS="6"
UPLOAD_CONCURRENCY="3"
```

本番では `wrangler secret put` と `wrangler pages project secret put` を利用し、公開リポジトリへはコミットしないでください。

## ディレクトリ構成
```
webapp/
├── public/
│   ├── index.html            # 録音・アップロード UI
│   └── static/
│       ├── app.js            # チャンク化・API連携ロジック
│       └── style.css         # UI カスタムスタイル
├── src/
│   ├── index.tsx             # Hono エントリ / API 実装
│   └── renderer.tsx          # （未使用: JSX サーバレンダリング例）
├── dist/                     # `npm run build` 後に生成
├── wrangler.jsonc            # Cloudflare Pages/Workers 設定
├── package.json
└── README.md
```

## 今後の拡張候補
- D1 によるタスク・顧客・会議メタデータの永続化。
- Cloudflare R2 で原本音声の一時保存と自動削除。
- 音声メタデータ分析（話者識別、話者ごとの集計）。
- Slack / Teams / メール送信連携。
- チャンク時間算出の高精度化（WebCodecs / AudioWorklet 等）。
- 議事録テンプレートの顧客別カスタマイズ、TODOのタスク管理システム連携。

## 制限事項
- チャンク時間は平均ビットレートで推定しており、可変ビットレート音源では数秒のズレが発生する可能性があります。
- フロントエンドで最大 300MB 程度のメモリを消費する想定です。ブラウザのリソース状況に注意してください。
- Gemini API 呼び出しはタイムアウト・リトライを実装しているものの、非常に長いチャンクでは応答時間に注意が必要です。
- Cloudflare 無料プランの CPU 制限（10ms）を超える場合はチャンクサイズ調整やワーカー分割が必要です。

## 開発者向けメモ
- `src/index.tsx` は `Hono<{ Bindings: Bindings }>` で型付けし、KV 内の JSON 構造体を定義しています。
- タスクごとの KV ログ (`task:${id}:logs`) に API 呼び出し結果・リトライ情報を蓄積し、`/api/tasks/:taskId/status` / `/logs` で参照可能。
- タイムスタンプ抽出は `^\s*(\d{2}):(\d{2})(?::(\d{2}))?` パターンで解析し、閾値より前の行を除去して重複を解消。
- Gemini API 呼び出しは `https://generativelanguage.googleapis.com/v1beta/models/` 経由。必要に応じて Vertex AI / Google Cloud のエンドポイントに調整してください。
- 環境ごとの秘密情報は必ず Workers Secret 経由で注入し、フロントコードには露出しません。

## テスト
- ✅ `npm run build` で型 / バンドル検証（2026-02-02 実行済み）。
- 🔄 約 5 分の短時間音声でエンドツーエンド（分割 → キュー処理 → 議事録）確認を推奨。
- 🔄 90〜180 分の長時間音声でチャンク総数・リトライ挙動・Gemini レート制限の確認を推奨。
- 実運用前にステージング環境で並列数・チャンクサイズを調整し、Cloudflare の CPU 限界に留意してください。

---
本MVPは Cloudflare Pages/Workers 上での実装を前提にしており、オンプレミスや別ランタイムに移植する場合はチャンク管理・ストレージ層を最適化してください。
