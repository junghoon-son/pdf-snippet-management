# AI CLI Harness — Staged Highlight / Tag / Group Design

**Date:** 2026-06-28
**Status:** Draft for review
**Scope:** `scripts/ai-batch.mjs` + a new `src/ai/harness/` module. Independent of the web-migration work; the CLI stays a local, headless, BYOK tool.

## 1. Goal

Replace the single `record_highlights` Reader call in the AI CLI with a **deterministic staged pipeline** that formalizes three operations — **Highlight → Tag → Group** — each as its own LLM call with a typed schema and a verification check, orchestrated in plain JS. Tags and groups draw from a **shared, hybrid (seed + propose) corpus taxonomy**.

This fixes today's gaps: grouping is currently collected (`group_hint`) but **discarded** (`buildTextSnippet` hardcodes `groups: []`), tagging doesn't exist, and re-runs blindly append duplicate snippets.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| Harness shape | Staged pipeline — 3 deterministic stages, each one LLM call + a pure verify function |
| Vocabulary source | Hybrid: seed `.marklee/taxonomy.json`, classify against it, may propose additions |
| Scope | Shared corpus taxonomy across a folder; applied per-doc sidecar; proposals reconciled at end of a folder run |
| Axes | Two: **tags** (many lightweight labels) and **groups** (few named, colored thematic buckets → `GroupMeta`) |
| LLM key | Env-var BYOK, unchanged: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` by `--provider` |
| Provider mixing | **One provider per run** (v1); model may be overridden per stage within that provider. Cross-provider per-stage mixing is out of scope. |
| Verification | Lightweight — schema validation + domain checks (anchoring, vocab membership). No adversarial multi-agent voting (that was the declined "fan-out" shape). |
| Idempotency | Upsert by stable snippet key, not blind append |
| Edges | Out of scope for v1 |
| Reuse | CLI-first, but factored as `src/ai/harness/` so Phase 2's server could drive the same stages |

## 3. Architecture & data flow

```
per document:  PDF bytes + query + taxonomy
  Stage 1 Highlight → verify: anchor each text quote via findInFlat → verified snippets (text+image)
  Stage 2 Tag       → verify: tags ∈ taxonomy ∪ proposals          → snippets + tag proposals
  Stage 3 Group     → verify: groups ∈ taxonomy ∪ proposals        → snippets + group proposals
  → upsert per-doc sidecar (snippets carry tags + group refs; GroupMeta matched by name)
  → accumulate this doc's proposals

end of folder run:
  Reconcile → dedup/merge proposals across docs → proposals report
            → (only with --accept-proposals) merge reconciled proposals into taxonomy.json
```

**Cost shape:** only Stage 1 uploads the PDF. Stages 2–3 receive the *extracted snippet list* (small text) + the taxonomy — cheap text-classification calls, no PDF re-upload. This is why per-stage cheap models pay off.

## 4. The three stages

Each stage is its own file in `src/ai/harness/` with a typed tool schema and a **pure verify function** (so it can be unit-tested by feeding inputs and asserting outputs, with no network).

### 4.1 Stage 1 — Highlight
Reuses the **existing** `READER_SYSTEM` / `READER_TOOL` (`src/ai/reader-prompt.js`) and the `findInFlat` / `computeLineRects` anchoring path **unchanged**. Text quotes that don't anchor drop to `orphan`; image rects are accepted as-is (same as today). The harness **ignores the legacy `group_hint` field** — grouping is now Stage 3.

> **No change to `reader-prompt.js` or the desktop app.** The shared Reader prompt/tool is left intact; the harness simply doesn't depend on `group_hint`. This keeps the app's `reader.js` working untouched.

Output: `verified snippets` = `[{ id, kind, page, text|label, rects, contextBefore, contextAfter, textNormalized, reason, confidence }]` (the current `buildTextSnippet`/`buildImageSnippet` shape, minus the hardcoded `groups: []`).

### 4.2 Stage 2 — Tag
LLM call with input = the verified snippets (`id`, `kind`, `page`, `text`/`label`, `reason`) + `taxonomy.tags` (`[{name, description}]`). Tool:

```jsonc
// assign_tags
{
  "assignments": [ { "id": "<snippet id>", "tags": ["<tag name>", ...] } ],
  "proposals":   [ { "name": "<new-tag>", "description": "<one line>" } ]  // only when nothing fits
}
```

Verify (`verifyTags(assignments, taxonomy, proposals)`): each assigned tag must be a taxonomy tag name OR a well-formed proposal name; unknown/malformed tags are dropped (recorded). Proposals capped per doc (default 8). A snippet may have zero tags.

### 4.3 Stage 3 — Group
LLM call with input = verified snippets + `taxonomy.groups` (`[{name, description}]`). Tool:

```jsonc
// assign_groups
{
  "assignments": [ { "id": "<snippet id>", "groups": ["<group name>", ...] } ],
  "proposals":   [ { "name": "<New Group>", "description": "<one line>", "color": "<css color, optional>" } ]
}
```

Verify (`verifyGroups(...)`): each group resolves to a taxonomy group OR a proposal; unknown dropped. Every snippet must land in ≥1 group — a snippet the model leaves ungrouped is assigned to a built-in `"Ungrouped"` group (and flagged in the report). Writes `GroupMeta` (`{id, name, color}`, matched/created by name) into the sidecar and sets `snippet.groups` to the matching ids. Tags are written to `snippet.tags` (plain strings).

### 4.4 Reconcile (corpus pass, folder runs only)
Collect all docs' proposals. Dedup by **normalized name** (case-fold, collapse whitespace, light stemming) so "Methodology"/"Methods" merge. Produce a merged proposal set with per-name doc counts. Write to the proposals report. With `--accept-proposals`, append the reconciled proposals to `taxonomy.json` (tags: `{name, description}`; groups: `{id: uuid, name, color, description}`).

## 5. Taxonomy file

Folder-level `.marklee/taxonomy.json`:

```json
{
  "version": "0.1",
  "tags": [
    { "name": "key-finding", "description": "A headline result or conclusion." },
    { "name": "limitation",  "description": "A stated weakness or caveat." }
  ],
  "groups": [
    { "id": "5f...", "name": "Methods", "color": "#d4a017", "description": "How the work was done." }
  ]
}
```

A missing file is treated as an empty taxonomy (`{tags:[], groups:[]}`) — the first run is then effectively open-ended and everything is a proposal, which `--accept-proposals` can bootstrap into the file.

## 6. Proposal mechanics (headless-friendly)

A batch CLI can't prompt interactively, so:
- Snippets **are** tagged/grouped with proposed names immediately — the run is useful on its own.
- Proposals are written to a **proposals report + stdout**; `taxonomy.json` is **not** mutated by default.
- `--accept-proposals` is what folds reconciled proposals into the canonical file.

This keeps the taxonomy curated and reproducible while never blocking the batch.

## 7. CLI surface

New/changed flags on `ai-batch.mjs`:

| Flag | Meaning |
|---|---|
| `--taxonomy <path>` | Taxonomy file (default: `.marklee/taxonomy.json` in the target dir) |
| `--stages highlight,tag,group` | Which stages to run (default all). Subsets allowed — e.g. `--stages tag,group` re-tags/re-groups existing AI snippets without re-highlighting (no PDF upload). |
| `--accept-proposals` | Merge reconciled proposals into the taxonomy file |
| `--tag-model <id>` / `--group-model <id>` | Override the model for stages 2/3 (within the run's `--provider`) |
| existing `--group <name>` | Retained as a "force everything into this one group" shortcut; bypasses Stage 3 |
| existing `--provider`, `--model`, `--json`, `--dry-run`, `--no-html`, `--filter` | Unchanged |

**Per-stage model defaults** (within the chosen provider): Stage 1 = the provider's capable PDF model (`claude-sonnet-4-6` / `gemini-2.5-flash`); Stages 2–3 = a cheap model (`claude-haiku-4-5` / `gemini-flash-lite`). Single provider per run reads a single env key.

## 8. Idempotency

Today `applySidecar` always appends, so re-running duplicates every snippet. The harness upserts: each AI-CLI snippet gets a stable key `sha256(kind | page | quote||label | JSON(rects))` stored at `meta.harnessKey`. On write, existing snippets with `meta.source === "ai-cli"` are matched by key and **updated** (tags/groups/comment refreshed) rather than duplicated. Manual snippets and other sources are never touched. `--stages tag,group` therefore re-classifies in place.

## 9. Module layout

```
src/ai/harness/
  index.js          runHarness(doc, query, taxonomy, opts) → { snippets, tagProposals, groupProposals, stats }
  provider.js       callTool(provider, model, apiKey, {system, content, tool}) → tool input  (generalized from ai-batch's callAnthropicReader/callGeminiReader)
  stage-highlight.js  runHighlight(...) → verified snippets   (reuses reader-prompt + resolver)
  stage-tag.js        runTag(...) + verifyTags(...)
  stage-group.js      runGroup(...) + verifyGroups(...)
  taxonomy.js         load/save/validate/mergeProposals/dedupByNormalizedName
  reconcile.js        reconcileProposals(perDocProposals[]) → merged set
scripts/ai-batch.mjs  arg parsing, taxonomy load, per-doc runHarness loop, end-of-run reconcile, HTML reports, sidecar upsert
```

Each unit has one responsibility and a network-free pure core (verify/merge/dedup/anchor) that is unit-testable.

## 10. Reports

Extend the existing per-doc HTML report to show, per snippet, its **tags** (chips) and **groups** (colored badges), plus a **Proposals** section (new tags/groups this doc suggested). The folder index gains a **reconciled taxonomy + proposals** summary.

## 11. Testing

`bun` unit tests in `spec/tests/`:
- `verifyTags` / `verifyGroups`: feed assignments + taxonomy + proposals, assert unknowns dropped, proposals capped, ungrouped → "Ungrouped".
- `taxonomy.js`: load defaults on missing file; `dedupByNormalizedName` merges "Methods"/"Methodology"; `mergeProposals` appends without duplicating existing.
- `reconcile.js`: cross-doc proposal dedup with doc counts.
- idempotency: the stable-key upsert updates rather than appends on a second run (against a fixture sidecar).
- Stage LLM calls themselves are integration-tested manually (live key) — the pure verify/merge cores carry the unit coverage.

## 12. Out of scope (v1)

- **Edges** (`supports`/`contradicts`/`elaborates` between snippets) — the spec supports them; deferred.
- **Adversarial multi-agent verification** (the fan-out workflow shape) — kept the pipeline deterministic and cheap.
- **Cross-provider per-stage mixing** — one provider per run; only model overrides within it.
- **App / web integration** — CLI-only; the module is structured to be reusable later but no app wiring here.

## 13. Open parameters for owner

1. Proposal cap per doc (default 8 tags / 8 groups).
2. Cheap-stage model defaults (`haiku` / `gemini-flash-lite`) — confirm or pin.
3. Whether `--group <name>` legacy shortcut is worth keeping once Stage 3 exists, or should be removed.

## 14. Risks

- **Snippet IDs across stages:** Stage 1 assigns each snippet an `id`; Stages 2–3 reference those ids. If the model echoes a malformed/unknown id, that assignment is dropped (verify) — a snippet can end up untagged/ungrouped (→ "Ungrouped"). Acceptable, surfaced in the report.
- **Native-PDF image-rect reliability** (carried over from today): Stage 1 image rects from a native-PDF model can be misaligned; out of scope to fix here, noted.
- **Taxonomy drift if `--accept-proposals` is run carelessly:** every proposed name gets added. Reconciliation dedups, but a human should still review the proposals report before accepting on a large corpus.
