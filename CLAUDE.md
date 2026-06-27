# CLAUDE.md — DIGEST

> Production blueprint for **DIGEST**, a personal news-intelligence routine.
> This file loads every session. It separates **what exists today** from **what is
> planned** — do not treat the unbuilt pipeline as if it runs.

## 1. What this is

DIGEST is a scheduled Claude routine that fetches **open-web** news in three domains,
**truth-gates every source**, and renders the verified result into a single
self-contained interactive HTML report (dark Bloomberg / terminal aesthetic, readable
on phone + PC).

Domains: **AI & Tech** · **Markets & Investing** (US + Bursa Malaysia; energy, tech,
semiconductors, data-center) · **Game Development** (Unreal Engine).

Scope decisions: fetch from **any open-web source** (X is just one possible source, not
special). There is **no** "creators to follow" recommender — DIGEST surfaces *stories*,
not people.

## 2. What exists TODAY

The pipeline in §5 is **built and dry-run verified (2026-06-27)**. It has not yet been
scheduled for unattended production runs.

- `prototype.html` — a single self-contained file (no deps, hand-built SVG/CSS charts).
  It is the **frozen template + the output contract**, populated with hand-curated,
  agent-verified June-2026 data. The JS `DIGEST` object at the top **is** the contract;
  the UI renders whatever is in it.
- `.qa/check.py` — Playwright headless render-check. Catches cross-surface duplicate
  strings, clipping, viewport overflow, template/placeholder leaks; writes screenshots
  to `.qa/`. Accepts `--file <path>` to check any generated report; defaults to
  `prototype.html`. **This is the page's real QA gate.**
- `.claude/agents/news-{investigator,verifier,consolidator,summarizer,renderer}.md` —
  the five pipeline stage agents (§5). Dry-run verified end-to-end 2026-06-27.
- `.claude/workflows/digest-pipeline.js` — the orchestrating Workflow that chains all
  five stages (fan-out per domain for stages 1–2; global single-call for stages 3–5).
- `.claude/workflows/digest-text-qa.js` — multi-agent static text-bug audit (8 render
  surfaces × refuter pass). Weaker than `check.py` for layout/cross-surface bugs.
- `draft.md`, `draft copy.md` — original intent notes (superseded by this file where they
  conflict).

Detailed change-history lives in the user-local memory store (not in-repo, does not
travel with this project) — this file restates only what a fresh session needs to build.

## 3. The DIGEST contract (`digest.json`)

The renderer's job is to emit a valid object of this shape; the template renders it.
Per-story fields the UI depends on:

- `generatedAt`, `prevKept`, `categories{ai,markets,gamedev}`
- `stories[]`: `{ id, cat, type, time, media:{src,credit}, head, brief, tldr, why,
  rel, tags, sentiment, sources[] }`
  - `brief` is a tight compression of `tldr` — **never** a copy of `head`, and the Lede's
    brief must not equal any TL;DR row (cross-surface dup; `check.py` enforces this).
  - `sources[]`: `{ type, publisher, handle, url, time, tier(T1|T2), primary, reachable,
    excerptVerified, excerpt, recovered?, recoverVia?, archiveUrl? }`
- `fallback{attempted,recovered,methods,...}`, `rejected[]` (the audit trail).

`media.src` must be a **real `og:image`/newsroom asset from the story's true source** —
never stock/AI/placeholder (gate-compliant), layered over a deterministic generative SVG
tile that shows if the real image 403s.

## 4. The non-negotiable rule

**Verification is a GATE, not a label.** Bad / dead / low-trust sources are killed
*before* summarizing — they never appear in the report. There is no "flagged bad source"
in the reading view. The user's core constraint is "summarize from true sources, no
hallucination."

Pipeline order: **Fetch → Verify → GATE (drop failures) → Consolidate → Summarize (only
from survivors) → Render.** Rejected sources go to the `rejected[]` audit / "N filtered"
count only. Tiering (T1 primary / T2 secondary — **no red tier**) ranks *surviving*
sources by degree; it never surfaces junk. This honesty applies to **this document too**:
do not describe the unbuilt pipeline as running.

## 5. Production pipeline (built · dry-run verified 2026-06-27 · not yet scheduled)

One deterministic **Workflow** script (`digest-pipeline.js`), fanned out from one
orchestrator session, triggered on a cron via `/schedule` (e.g. daily morning brief).

| Stage | Model | Job |
|---|---|---|
| **investigator** | Sonnet (cheap) | WebFetch the open web per domain/source; **recover bot-blocked sources inline** (curl + browser-UA → `r.jina.ai` → Wayback) before recording; emit provenance rows `{url, publisher/creator, date, summary, excerpt}`. |
| **verifier** | Sonnet (cheap) | Score credibility; **gate-trim** sources below a confidence threshold (configurable). Judges trust only — reachability was already solved upstream. |
| **consolidator** | Sonnet (cheap) | Global view of the gated pool; cluster sources describing the same event → **one story per event** with its N verified sources. |
| **summarizer** | **Opus (strong)** | Write `tldr` / `why` / `brief`, **strictly grounded** in source excerpts — no new claims. Low-volume, high-stakes: this is the prose the user reads. |
| **renderer** | cheap | Emit + **schema-validate** the `DIGEST` object, inject into the frozen template. Never regenerates HTML/CSS. |

Recovery insight (proven once): **every** bot-blocked (403) source recovered via
Wayback/mirror/reader-proxy turned out usable — "blocked" never meant "junk." Only a
genuine low-trust source (unsupported claim) is dropped on credibility. `WebFetch`
**cannot** fetch `web.archive.org` — use `curl` for Wayback.

**Two-step rendering:** routine runs do data-fill only (cheap, stable). Changing the
template's look is a **separate, human-initiated** pass — run the QA gates (§7) *then*.

## 6. Storage layout

```
runs/YYYYMMDD-HHMM/
  report.html     # durable — the rendered digest
  digest.json     # durable — the contract / data object
  audit.json      # durable — what was filtered & recovered, with reasons (backs "N filtered")
  .work/          # prunable — raw per-source fetch dumps
```

`audit.json` is **not** disposable: the report's "TRUE SOURCES ONLY · N verified · N
filtered" claims are only honest if a real record backs them.

## 7. Conventions

- Aesthetic: dark Bloomberg/terminal; list→detail UX (lean teaser cards → centered
  article-reader modal holding summary + why-it-matters + verified sources inline).
- Real source images only (see §3). Offline-safe via the generative SVG fallback tile.
- After any **template** change: `python .qa/check.py` (checks `prototype.html`).
- After any **pipeline run**: `python .qa/check.py --file runs/<runDir>/report.html`
  (the renderer runs this automatically; re-run manually to debug).

## 8. Known gaps (not yet built)

- **User interest-profile / source list** — domains exist; a real per-user profile and
  curated/ranked source list does not.
- **`fallback.methods` taxonomy mismatch** — the template's fetch-fallback panel hard-codes
  three recovery buckets (`wayback / mirror / altsource`) from the June hand-curated run.
  The investigator's actual recovery ladder has four rungs (`browserUA / reader / wayback /
  mirror`) which don't map cleanly onto those three. Reconciling them is a **look-change
  pass** (§5 two-step rendering rule) — the renderer emits the template's keys and records
  raw counts in `audit.json` until then.
- **Live Market Tape** — a real index/ticker strip for the dashboard; deferred because it
  needs live quotes + a watchlist. **Must not be faked** — no invented numbers, ever.
