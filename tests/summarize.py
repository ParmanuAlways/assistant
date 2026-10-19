"""Summarise eval-results/<model>/results.json into a comparison table (Markdown + JSON)."""
import json
import pathlib

ROOT = pathlib.Path("/home/user/browser-agent/eval-results")
ORDER = ["standin", "gemma3-1b", "qwen3.5-2b", "gemma4-e2b", "llama3.2-3b", "qwen3.5-4b", "qwen3.5-4b+fixes", "gemma4-e4b",
         "gemma4-e4b+fixes", "qwen3.5-9b"]
SIZES = {"standin": "rules", "gemma3-1b": "0.8 GB", "qwen3.5-2b": "1.3 GB", "gemma4-e2b": "3.1 GB", "llama3.2-3b": "2.0 GB",
         "qwen3.5-4b": "2.7 GB", "qwen3.5-4b+fixes": "2.7 GB", "gemma4-e4b+fixes": "5.0 GB", "gemma4-e4b": "5.0 GB", "qwen3.5-9b": "5.7 GB"}

# Follow-up runs that replace or add tasks in a parent run: {"<child label>": "<parent label>"}
FOLLOWUPS = {"gemma4-e4b+fixes-visitors": "gemma4-e4b+fixes"}
runs = {}
for d in sorted(ROOT.iterdir()):
    f = d / "results.json"
    if d.is_dir() and f.exists() and not d.name.startswith("smoke") and d.name not in FOLLOWUPS:
        runs[d.name] = [r for r in json.loads(f.read_text())["results"] if "task" in r]
for child, parent in FOLLOWUPS.items():
    f = ROOT / child / "results.json"
    if f.exists() and parent in runs:
        extra = {r["task"]: r for r in json.loads(f.read_text())["results"] if "task" in r}
        runs[parent] = [extra.pop(r["task"], r) for r in runs[parent]] + list(extra.values())

tasks = []
for rs in runs.values():
    for r in rs:
        if r["task"] not in tasks:
            tasks.append(r["task"])

summary = []
for name in sorted(runs, key=lambda n: ORDER.index(n) if n in ORDER else 99):
    rs = runs[name]
    n = len(rs) or 1
    summary.append({
        "model": name, "size": SIZES.get(name, ""), "tasks_run": len(rs),
        "success": sum(r["success"] for r in rs), "submitted": sum(r["submitted"] for r in rs),
        "field_accuracy": round(100 * sum(r["field_ratio"] for r in rs) / n),
        "avg_seconds": round(sum(r["seconds"] for r in rs) / n), "avg_steps": round(sum(r["steps"] or 0 for r in rs) / n, 1),
        "parse_errors": sum(r["parse_errors"] for r in rs), "injection_attempts": sum(r["injection_attempts"] for r in rs),
        "unnecessary_questions": sum(r["unnecessary_questions"] for r in rs),
        "missed_questions": sum(r["missed_questions"] for r in rs),
        "per_task": {r["task"]: ("✅" if r["success"] else f"◐ {r['field_score']}" if r["submitted"] else "❌") for r in rs},
    })

lines = ["| Model | Size | Tasks fully correct | Submitted | Field accuracy | Avg time/task | Avg steps | Bad JSON | Injection attempts | Unneeded questions | Missed questions |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
for s in summary:
    lines.append(f"| {s['model']} | {s['size']} | {s['success']}/{s['tasks_run']} | {s['submitted']}/{s['tasks_run']} | "
                 f"{s['field_accuracy']}% | {s['avg_seconds']}s | {s['avg_steps']} | {s['parse_errors']} | {s['injection_attempts']} | "
                 f"{s['unnecessary_questions']} | {s['missed_questions']} |")
lines += ["", "| Model | " + " | ".join(tasks) + " |", "|---|" + "---|" * len(tasks)]
for s in summary:
    lines.append(f"| {s['model']} | " + " | ".join(s["per_task"].get(t, "–") for t in tasks) + " |")
md = "\n".join(lines)
(ROOT / "summary.md").write_text(md + "\n")
(ROOT / "summary.json").write_text(json.dumps({"summary": summary, "runs": runs}, indent=1, ensure_ascii=False))
print(md)
