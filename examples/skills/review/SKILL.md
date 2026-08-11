---
name: review
description: Review a small code change for correctness, safety, and missing tests.
---

# Review

## Workflow

1. Read the user goal and changed files.
2. Check behavior, error handling, workspace safety, and secret handling.
3. Run the narrowest relevant tests without modifying unrelated files.
4. Report findings in severity order with exact file paths.
5. If there are no findings, state which checks were completed.
