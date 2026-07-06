# Recruited Agent Registry

| Name | Tool | Role | Scope | Brief | Created | Status | Resume |
|---|---|---|---|---|---|---|---|
| Sentinel | Codex (Maestri) | Drive Security Auditor | Read-only security audit of main@f0da38a perimeter (inbox/bundles/scopes/tokens/trash/MCP) | /tmp/adrive-audit-0706/brief-A.md | 2026-07-06 | done (out-A.md, FIX-FIRST→fixed in PR #24) | `maestri ask "Sentinel" ...` |
| Ledger | Codex (Maestri) | Drive Econ Auditor | Read-only engineering-economics + 6-surface docs-drift audit | /tmp/adrive-audit-0706/brief-B.md | 2026-07-06 | done (out-B.md, FIX-FIRST→fixed #24 + issues #20-#23) | `maestri ask "Ledger" ...` |
| Gauntlet | Codex (Maestri) | Drive Test Engineer | Integration tests (#8) in worktree /tmp/adrive-wt-tests, branch feat/integration-tests | /tmp/adrive-audit-0706/brief-C.md | 2026-07-06 | done (out-C.md → PR #25 merged, closes #8) | `maestri ask "Gauntlet" ...` |

Blackboard note: `adrive-audit-0706-status` · outputs: /tmp/adrive-audit-0706/out-{A,B,C}.md

## Round 2 (issues #20-#23, 2026-07-07)

| Name | Issue | Branch | Outcome |
|---|---|---|---|
| Sentinel | #20 public-share perf | perf/public-share-limits | review SHIP → PR #27 merged |
| Ledger | #21 FTS drift/rebuild | fix/fts-rebuild | review SHIP → PR #29 merged |
| Gauntlet | #22 bundle invalidation | fix/bundle-invalidation | review SHIP → PR #28 merged |
| CEO (self) | #23 list pagination | perf/list-pagination | PR #26 merged |

All four deployed to production 2026-07-07, smoke-tested. Migration 0014 (indexes) applied.
Fleet TUI crashed once mid-run after the first task completed (裸 shell); recovered via `role assign --none` + reassign to restart the Codex process, then re-dispatched.
