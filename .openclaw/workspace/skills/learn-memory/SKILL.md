# Learn Memory Skill

## Trigger Words

When user says any of these, save to memory:
- "learn this: [content]"
- "remember this: [content]"
- "save to memory: [content]"
- "note this: [content]"
- "important: [content]"

## What To Do

1. **Extract the content** after the trigger word
2. **Write to** `memory/YYYY-MM-DD.md` (create file if needed)
3. **Format as:**
   ```markdown
   ## Learned: [Brief title]
   
   [Content user provided]
   
   - Saved: [current time]
   - Context: [1-line summary of what was being discussed]
   ```

## Rules

- ✅ Save exactly what user says (don't summarize unless asked)
- ✅ Add timestamp and brief context
- ✅ Create `memory/` folder if it doesn't exist
- ✅ Append to today's memory file (don't overwrite)
- ❌ Don't save duplicates (check if similar content exists)
- ❌ Don't save secrets/passwords (warn user instead)

## Example

**User:** "learn this: LinkedIn posting schedule - post at 8am, 2pm, 6pm on weekdays"

**Action:** Append to `memory/YYYY-MM-DD.md`:
```markdown
## Learned: LinkedIn Posting Schedule

LinkedIn posting schedule - post at 8am, 2pm, 6pm on weekdays

- Saved: 2026-03-10 11:30
- Context: User shared social media strategy during planning session
```

**Response:** "✅ Saved to memory/YYYY-MM-DD.md"

## Response Style

Keep it brief:
- "✅ Saved to memory"
- "✅ Remembered: [brief title]"
- "📝 Noted: [brief title]"

No long explanations.
