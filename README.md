# 税理士事務所向け AI議事録生成 MVP

## プロジェクト概要
- **名称**: webapp
- **目的**: 税理士事務所の定例会議や顧問先との打合せ録音から、タイムスタンプ付き全文文字起こしと議事録を自動生成する。
- **対象**: 最長3時間（約180分）の音声データ。
- **キーモデル**: 文字起こしに *Gemini 3.0 Flash Preview*、議事録生成に *Gemini 3.0 Pro Preview* を使用。

## 主な機能
- ブラウザ内録音（MediaRecorder）と既存音声ファイルのアップロードに対応。
- フロントエンドで約 5MB ごとに音声を分割し、5 秒のオーバーラップを付与したチャンクを生成。
- 各チャンクを Cloudflare Workers (Hono) に送信し、Gemini 3.0 Flash Preview でタイムスタンプ付き文字起こし。
- タイムスタンプを基準にチャンク結果を再結合し、全文を Cloudflare KV に保存。
- Gemini 3.0 Pro Preview で税理士事務所向け議事録テンプレート（概要/決定事項/TODO/リスク/フォローアップ/重要タイムライン）を生成。
- 文字起こし全文および議事録のコピー、ダウンロード (TXT/Markdown) に対応。
- フロントエンドで進捗ログ・APIレスポンスをリアルタイム表示。

## アーキテクチャ
```
ブラウザ (Tailwind + Vanilla JS)
  ├─ 音声録音 / ファイル選択
  ├─ 5MB チャンク化（5秒オーバーラップ）
  └─ Hono API 呼び出し

Cloudflare Pages + Workers (Hono)
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
| `POST` | `/api/tasks/:taskId/merge` | チャンク全文をタイムスタンプ基準で結合 |
| `GET` | `/api/tasks/:taskId/transcript` | 結合済み全文を取得 |
| `POST` | `/api/tasks/:taskId/minutes` | Gemini Pro で議事録生成 |
| `GET` | `/api/tasks/:taskId/minutes` | 生成済み議事録を取得 |
| `GET` | `/api/healthz` | 簡易ヘルスチェック |

### タスク状態管理
- `TASKS_KV` に `task:${id}`, `task:${id}:chunk:${index}`, `task:${id}:transcript`, `task:${id}:minutes` として保存。
- ステータス: `initialized` → `transcribing` → `transcribed` → `completed`。エラー時 `error`。

## フロントエンドフロー
1. 音声録音またはファイル選択。
2. 音声を約 5MB チャンク + 5 秒オーバーラップで分割（時間はファイルサイズと全体長から推定）。
3. 各チャンクを順次アップロードし、進捗を表示。
4. 全チャンク完了後 `/merge` を呼び出して全文を取得。
5. 必要に応じて「議事録生成」ボタンで `/minutes` を呼び出す。
6. 結果をコピーまたはダウンロード可能。

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
- Gemini API 呼び出しは同期的に行っているため、非常に長いチャンクでは応答時間に注意が必要です。
- Cloudflare 無料プランの CPU 制限（10ms）を超える場合はチャンクサイズ調整やワーカー分割が必要です。

## 開発者向けメモ
- `src/index.tsx` は `Hono<{ Bindings: Bindings }>` で型付けし、KV 内の JSON 構造体を定義しています。
- タイムスタンプ抽出は `^\s*(\d{2}):(\d{2})(?::(\d{2}))?` パターンで解析し、閾値より前の行を除去して重複を解消。
- Gemini API 呼び出しは `https://generativelanguage.googleapis.com/v1beta/models/` 経由。必要に応じて Vertex AI / Google Cloud のエンドポイントに調整してください。
- 環境ごとの秘密情報は必ず Workers Secret 経由で注入し、フロントコードには露出しません。

## テスト
- 現状ユニットテストは未実装。`npm run build` で型・バンドル確認を行っています。
- 実運用前にステージング環境で 10 分超の音声データを用いた負荷検証を推奨します。

---
本MVPは Cloudflare Pages/Workers 上での実装を前提にしており、オンプレミスや別ランタイムに移植する場合はチャンク管理・ストレージ層を最適化してください。
