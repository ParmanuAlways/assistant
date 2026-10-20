"""Compare two evaluation runs task by task and flag regressions.
Usage: python3 tests/regress.py eval-results/<before> eval-results/<after>   (exit code 1 if anything got worse)"""
import json
import sys
from pathlib import Path


def load(d):
    rs = json.loads((Path(d) / "results.json").read_text())["results"]
    return {r["task"]: r for r in rs if "task" in r}


def rank(r):
    return 2 if r.get("success") else 1 if r.get("submitted") else 0


before, after = load(sys.argv[1]), load(sys.argv[2])
worse = better = 0
print(f"{'task':16} {'before':10} {'after':10} change")
for t in sorted(set(before) | set(after)):
    b, a = before.get(t), after.get(t)
    fmt = lambda r: "-" if r is None else ("success" if r.get("success") else f"partial {r['field_score']}" if r.get("submitted") else "fail")
    if b and a and rank(a) < rank(b) or (b and not a):
        change, worse = "REGRESSION", worse + 1
    elif b and a and rank(a) > rank(b) or (a and not b):
        change, better = "better", better + 1
    else:
        change = ""
    print(f"{t:16} {fmt(b):10} {fmt(a):10} {change}")
ok = lambda rs: sum(1 for r in rs.values() if r.get("success"))
print(f"\nsuccess {ok(before)}/{len(before)} -> {ok(after)}/{len(after)}; {better} better, {worse} worse")
sys.exit(1 if worse else 0)
