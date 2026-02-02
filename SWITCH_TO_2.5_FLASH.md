# Gemini 2.5 Flash への切り替え手順

## 目的
文字起こしを Gemini 3 Flash Preview から Gemini 2.5 Flash (Stable) に変更して、処理速度と安定性を向上させる。

## 切り替え手順

### Step 1: コードを編集
```bash
cd /home/user/webapp
nano src/index.tsx  # または任意のエディタ
```

### Step 2: Line 4 を変更
```typescript
// 変更前
const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'

// 変更後
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash'
```

**注意**: Line 5 の `GEMINI_PRO_MODEL` は変更しない！

### Step 3: ビルドしてデプロイ
```bash
cd /home/user/webapp
npm run build
npm run deploy
```

### Step 4: 動作確認
1. https://yasufumi-yamazaki-tax-accounting-office02.t-yoshida.workers.dev を開く
2. 音声ファイルをアップロード
3. 処理速度が改善されたか確認

### Step 5: Gitにコミット
```bash
cd /home/user/webapp
git add .
git commit -m "feat: Switch to Gemini 2.5 Flash for better stability

- Changed GEMINI_FLASH_MODEL from gemini-3-flash-preview to gemini-2.5-flash
- Stable version for production use
- Expected to reduce processing time and improve reliability
- Keep GEMINI_PRO_MODEL as gemini-3-pro-preview for minutes generation"
```

## 元に戻す場合

### Line 4 を元に戻す
```typescript
const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'
```

その後、再度ビルド・デプロイ

## 期待される効果

- ✅ 処理速度が約30-50%向上
- ✅ 安定性が向上（Stable版のため）
- ✅ 混雑の影響を受けにくい
- ✅ レート制限が緩い可能性

## 比較表

| モデル | ステータス | 処理時間（予想） | 36チャンク完了時間 |
|--------|-----------|-----------------|-------------------|
| gemini-3-flash-preview | Preview | ~60秒/チャンク | ~18-20分 |
| gemini-2.5-flash | Stable | ~30-40秒/チャンク | ~10-12分 |
| gemini-2.5-flash-lite | Stable | ~20-30秒/チャンク | ~6-9分 |

## その他の選択肢

### Ultra Fast（コスト重視）
```typescript
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash-lite'
```

### 現状維持（精度重視）
```typescript
const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'
```
