#!/bin/bash
# Gemini 3 Flash Preview に戻すスクリプト

set -e

echo "🔄 Switching back to Gemini 3 Flash Preview..."
echo ""

cd /home/user/webapp

# Backup current file
cp src/index.tsx src/index.tsx.backup

# Replace the model name
sed -i "s/const GEMINI_FLASH_MODEL = 'gemini-2.5-flash'/const GEMINI_FLASH_MODEL = 'gemini-3-flash-preview'/g" src/index.tsx

echo "✅ Model changed back to gemini-3-flash-preview"
echo ""

# Show the change
echo "📝 Current model configuration:"
head -6 src/index.tsx | tail -3
echo ""

# Ask for confirmation
read -p "🚀 Build and deploy? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔨 Building..."
    npm run build
    
    echo "📦 Deploying..."
    npm run deploy
    
    echo ""
    echo "✅ Deployment complete!"
    echo ""
    echo "📊 Test at: https://yasufumi-yamazaki-tax-accounting-office02.t-yoshida.workers.dev"
    echo ""
    echo "💾 Don't forget to commit:"
    echo "   git add ."
    echo "   git commit -m 'revert: Switch back to Gemini 3 Flash Preview'"
else
    echo "❌ Cancelled. Restoring backup..."
    mv src/index.tsx.backup src/index.tsx
    echo "✅ Restored original file"
fi
