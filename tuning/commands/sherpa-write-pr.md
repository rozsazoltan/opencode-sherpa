---
description: Draft a pull request summary from verified changes and checks.
---
Task and context: $ARGUMENTS

Inspect the verified diff and check results. Look for an applicable repository pull request template and follow it when present. Use the existing `sherpa-pr-writing` skill when available. If unavailable or unselected, apply the same safeguards: describe only verified changes, report checks with observed results, and mark skipped checks. Do not invent links, references, or review details. Return draft text only. Do not create, update, or publish a pull request unless the user explicitly requests that action through an appropriate authorized workflow; do not commit or push as part of drafting.
