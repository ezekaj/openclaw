#!/bin/bash
# Code Cleanup Script - 2026-03-10
# Generated from deduplication report

set -e  # Stop on errors

echo "🔧 OpenClaw Code Cleanup Script"
echo "================================"
echo ""

# Phase 1: Fix Corrupted Files
echo "📋 Phase 1: Fixing corrupted files..."
echo ""

# Check if conversation-summarizer.ts is tracked
if git ls-files --error-unmatch src/agents/conversation-summarizer.ts > /dev/null 2>&1; then
    echo "✓ Restoring src/agents/conversation-summarizer.ts from git..."
    git checkout HEAD -- src/agents/conversation-summarizer.ts
else
    echo "⚠️  src/agents/conversation-summarizer.ts is untracked (manual fix required)"
fi

# Remove misplace test file
if [ -f "src/agents/neuro-memory-bridge-simple.ts" ]; then
    echo "✓ Removing misplaced test file..."
    rm src/agents/neuro-memory-bridge-simple.ts
fi

echo ""
echo "✅ Phase 1 complete!"
echo ""

# Phase 2: Update Security Vulnerabilities
echo "🔒 Phase 2: Updating vulnerable packages..."
echo ""

echo "Updating fast-xml-parser..."
pnpm update fast-xml-parser@>=5.3.6

echo "Updating hono..."
pnpm update hono@>=4.12.7

echo ""
echo "✅ Phase 2 complete!"
echo ""

# Verify
echo "🔍 Running TypeScript check..."
npx tsc --noEmit 2>&1 | head -20

echo ""
echo "🎉 Cleanup complete!"
echo ""
echo "Next steps:"
echo "1. Review TypeScript errors (if any)"
echo "2. Run tests: pnpm test"
echo "3. Commit changes: git add -A && git commit -m 'chore: fix corrupted files and update deps'"
echo ""
