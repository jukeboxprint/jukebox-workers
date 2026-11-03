"""Every workflow file must be valid YAML with the keys GitHub needs (on, jobs).

A workflow file GitHub cannot read is not a failing check on the PR that breaks it: the PR merges green and every
later run of that workflow fails at startup with no jobs (copilot-suggest-deploy.yml, 2 Nov 2026: an unquoted
"pipeline.json: straight to 100%" in a step name; runs 41385929729 and 41386227356). This catches that class.
  python3 scripts/ci/check_workflows.py [dir]
"""
import pathlib
import sys

import yaml

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows")
bad = []
files = sorted(list(root.glob("*.yml")) + list(root.glob("*.yaml")))
for f in files:
    try:
        d = yaml.safe_load(f.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        bad.append(f"{f}: not valid YAML: {str(e).splitlines()[0]} ({getattr(e, 'problem_mark', '')})")
        continue
    if not isinstance(d, dict):
        bad.append(f"{f}: not a mapping")
        continue
    # PyYAML (YAML 1.1) reads the key `on` as True.
    if "on" not in d and True not in d:
        bad.append(f"{f}: no 'on' trigger")
    if not isinstance(d.get("jobs"), dict) or not d["jobs"]:
        bad.append(f"{f}: no jobs")
for b in bad:
    print("FAIL " + b)
print(f'{{"files": {len(files)}, "fail": {len(bad)}}}')
sys.exit(1 if bad or not files else 0)
