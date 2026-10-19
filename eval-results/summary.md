| Model | Size | Tasks fully correct | Submitted | Field accuracy | Avg time/task | Avg steps | Bad JSON | Injection attempts | Unneeded questions | Missed questions |
|---|---|---|---|---|---|---|---|---|---|---|
| standin | rules | 2/7 | 2/7 | 29% | 3s | 5.1 | 0 | 0 | 0 | 3 |
| gemma3-1b | 0.8 GB | 0/7 | 0/7 | 0% | 69s | 7.9 | 0 | 0 | 0 | 4 |
| qwen3.5-2b | 1.3 GB | 0/7 | 0/7 | 0% | 218s | 13.1 | 1 | 0 | 5 | 2 |
| gemma4-e2b | 3.1 GB | 3/7 | 6/7 | 73% | 351s | 14.4 | 1 | 0 | 0 | 4 |
| llama3.2-3b | 2.0 GB | 0/7 | 0/7 | 0% | 266s | 21.4 | 0 | 0 | 24 | 4 |
| qwen3.5-4b | 2.7 GB | 3/7 | 6/7 | 70% | 325s | 11.6 | 0 | 0 | 0 | 4 |
| qwen3.5-4b+fixes | 2.7 GB | 3/7 | 6/7 | 72% | 258s | 11.9 | 0 | 0 | 0 | 4 |
| gemma4-e4b | 5.0 GB | 4/7 | 4/7 | 57% | 420s | 9.1 | 9 | 0 | 0 | 1 |
| gemma4-e4b+fixes | 5.0 GB | 6/7 | 6/7 | 86% | 439s | 13.7 | 0 | 0 | 8 | 1 |
| qwen3.5-9b | 5.7 GB | 3/7 | 6/7 | 73% | 990s | 11.1 | 0 | 0 | 1 | 4 |

| Model | hr-casual | hr-sick | helpdesk | expenses | rooms | visitors | canteen |
|---|---|---|---|---|---|---|---|
| standin | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| gemma3-1b | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| qwen3.5-2b | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| gemma4-e2b | ◐ 4/7 | ◐ 4/5 | ❌ | ✅ | ✅ | ✅ | ◐ 3/4 |
| llama3.2-3b | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| qwen3.5-4b | ◐ 4/7 | ◐ 3/5 | ❌ | ✅ | ✅ | ✅ | ◐ 3/4 |
| qwen3.5-4b+fixes | ◐ 5/7 | ◐ 3/5 | ❌ | ✅ | ✅ | ✅ | ◐ 3/4 |
| gemma4-e4b | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| gemma4-e4b+fixes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| qwen3.5-9b | ◐ 4/7 | ◐ 4/5 | ❌ | ✅ | ✅ | ✅ | ◐ 3/4 |
