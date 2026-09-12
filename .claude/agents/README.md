# Agent team

`shop-orchestrator` (Opus 5) plans work, splits it by **file ownership** and
integrates the result. The specialists below run on a cheaper model because
their briefs are narrow and their contracts are written down:

| Agent                 | Model            | Owns                                         |
| --------------------- | ---------------- | -------------------------------------------- |
| `shop-orchestrator`   | claude-opus-5    | shared foundations, integration, verification |
| `storefront-engineer` | claude-sonnet-5  | `src/routes/storefront.tsx`, `src/ui/components.tsx` |
| `payments-engineer`   | claude-sonnet-5  | checkout, Stripe, orders                      |
| `admin-engineer`      | claude-sonnet-5  | `/admin`, QR codes                            |
| `ebay-sync-engineer`  | claude-sonnet-5  | `src/lib/ebay/**`, `src/routes/api.ts`        |
| `qa-reviewer`         | claude-sonnet-5  | review only, no edits                         |

Swap any specialist to `claude-opus-4-8` in its frontmatter if a task needs more
horsepower — the briefs do not change.

Usage:

```
> use the shop-orchestrator agent to add a bundle-discount feature
```

The one rule that keeps parallel work safe: **two agents never edit the same
file in the same round.** Anything shared belongs to the orchestrator.
