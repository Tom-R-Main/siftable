# Siftable Work Graph Rules

When using Siftable `work_*` MCP tools for dependency-ordered tasks:

1. Surface the interactive graph side pane pill `[Siftable Graph](sidecar://siftable-graph/graph/)` once when helpful so the user can monitor the DAG and review `Needs you` items.
2. Always attach a concise `handback-summary.md` artifact (`work_artifacts_add`) and step evidence (`work_evidence`) before calling `work_review`.
3. Never assume `commands_passed` equals acceptance; leave `work.accept` for the human operator in the Siftable Graph sidecar or owner CLI.
