# Quick DeepSeek Automation

**Fastest way to ask DeepSeek reasoning questions via browser automation.**

## Prerequisites
- OpenClaw browser control running (gateway active)
- Chrome with DeepSeek tab open

## Usage

### 1. One-Liner (Ask DeepSeek Immediately)

```markdown
!ask-deepseek How do I optimize a Python function that scans 10,000 items?
```

This will:
1. Open DeepSeek (if not open)
2. Type your question
3. Click DeepThink
4. Wait for response
5. Return answer to you

**Time: 30-60 seconds**

---

### 2. Interactive (Better for Complex Questions)

**Step 1:** Open DeepSeek
```
!open-deepseek
```

**Step 2:** Type question
```
!type-deepseek What's the best sorting algorithm for episodic memory systems?
```

**Step 3:** Click DeepThink
```
!deepthink
```

**Step 4:** Get response
```
!get-deepseek-answer
```

---

## Automation Commands Reference

| Command | What it does | Time |
|---------|-------------|------|
| `!ask-deepseek <question>` | Full automation (open + type + click + return) | 30-60s |
| `!open-deepseek` | Opens chat.deepseek.com | 2s |
| `!type-deepseek <text>` | Types text into input field | 1s |
| `!deepthink` | Clicks DeepThink button | 1s |
| `!get-deepseek-answer` | Extracts response from page | 5-30s |

---

## How It Works

```typescript
// OpenClaw command → Browser automation → DeepSeek web interface
browser.action("open", { url: "https://chat.deepseek.com" })
browser.action("type", { ref: "input-field", text: question })
browser.action("click", { ref: "deepthink-button" })
// Wait for response, then extract
```

**Advantages over API:**
- ✅ **FREE** (no API costs)
- ✅ **Best quality** (full DeepSeek R1 reasoning)
- ✅ **No rate limits** (unlike API)
- ✅ **Web interface features** (formatting, history, etc.)

**Disadvantages:**
- ⏱️ Slower than API (30s vs 5s)
- 🌐 Requires browser tab open
- 🤖 Less reliable than API (DOM changes)

---

## Pro Tips

**1. Keep DeepSeek Tab Open**
- Pin tab in Chrome
- Run once per session

**2. Batch Questions**
- Collect multiple questions
- Ask all at once via `!ask-deepseek`

**3. Save Conversations**
- Use DeepSeek's history feature
- Bookmark important responses

**4. Combine with Local Models**
- Use DeepSeek for reasoning tasks
- Use local LM Studio for simple tasks

---

## When to Use Each Approach

| Use Case | Recommended Method | Why |
|----------|-------------------|-----|
| **Complex reasoning** | Browser automation (DeepSeek) | Best quality, free |
| **Quick questions** | Local LM Studio | Fastest, private |
| **Code review** | Mistral Le Chat | Excellent code understanding |
| **Production apps** | DeepSeek API (paid) | Reliable, programmatic |

---

## Example Session

```
You: Ask DeepSeek: "What's the optimal cache strategy for episodic memory?"

OpenClaw:
→ Opening DeepSeek...
→ Typing question...
→ Clicking DeepThink...
→ Waiting for response (15s)...
→ DeepSeek Response:

"The optimal cache strategy for episodic memory systems is **pre-computed sorted episodes**:

1. **Maintain sorted cache**: Keep episodes sorted by surprise score
2. **Lazy invalidation**: Only rebuild when episodes change
3. **Thread-safe access**: Use locks for concurrent reads

**Expected speedup:** 10x faster queries (100ms → 10ms)
**Memory overhead:** 2MB for 10,000 episodes
**Implementation time:** 30 minutes

This approach balances query performance against memory overhead..."

You: Great! Now implement it in my mcp_server.py file.
```

**Total time:** 45 seconds
**Cost:** $0.00
