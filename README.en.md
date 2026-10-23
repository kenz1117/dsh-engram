<div align="center">

<img src="docs/screenshots/hero.jpg" width="100%" alt="dsh-engram · Memory Palace — a cross-session long-term memory plugin for DeepSeek Harness">

# dsh-engram · Memory Palace

<p align="center"><b>Local-first long-term memory for your coding agent.</b><br>
Cross-session long-term memory on plain local SQLite: <b>no external service, no API key, no Docker</b> — one command and it works.<br>
22 narrow-parameter tools · hybrid retrieval (FTS5 + local vectors, RRF) · an evidence gate · full provenance audit · SM-2 spaced-repetition review · a zh / en / ru panel.</p>

<p align="center">
  <a href="https://github.com/kenz1117/dsh-engram/blob/main/LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/actions/workflows/checks.yml"><img alt="CI" src="https://github.com/kenz1117/dsh-engram/actions/workflows/checks.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm version" src="https://img.shields.io/npm/v/@kenz1117/dsh-engram"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/kenz1117/dsh-engram"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

[中文](README.md) | English

</div>

<details>
<summary><b>Contents</b></summary>

- [Quick Start](#quick-start)
- [Why this one](#why-this-one)
- [How a memory flows](#how-a-memory-flows)
- [Screenshots](#screenshots)
- [Palace Structure: the Directory Is the Room, the Path Is the Route](#palace-structure-the-directory-is-the-room-the-path-is-the-route)
- [Features](#features)
- [Tools (22, narrow parameters)](#tools-22-narrow-parameters)
- [Configuration](#configuration)
- [How It Works](#how-it-works)
- [Web Management Panel](#web-management-panel)
- [Development](#development)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Roadmap](#roadmap)
- [Acknowledgements](#acknowledgements)
- [License](#license)

</details>

---

## Quick Start

```sh
dsh plugin --profile web add @kenz1117/dsh-engram
```

Zero configuration after install (stores and model cache default to `~/.dsh/engram`; profile injection on, automatic capture off).

**Let your agent install it** — paste this into any agent:

```text
Run this command to install dsh-engram, a cross-session long-term memory plugin for DeepSeek Harness:
  dsh plugin --profile web add @kenz1117/dsh-engram
Then confirm the "Memory Palace" entry appears in the plugin center sidebar, and open a new session to
run engram_stats and confirm 22 engram_* tools are registered.
```

## Why this one

Plenty of memory plugins exist, but most want you to stand up infrastructure first. Three mainstream shapes, side by side (compared against each project's public README and npm dependency declarations):

| | **dsh-engram** | Server-based (Postgres/pgvector/Milvus/Python service) | File-based (plain Markdown memory) |
|---|---|---|---|
| Setup cost | One npm command, **works immediately** | Docker + database + vector store + migrations | One npm command |
| External dependencies | **None**: embeddings run offline and degrade to keyword-only with an explicit marker | Required, usually plus an LLM API key | None |
| Agent-facing tools | **22 narrow-parameter tools** across the whole lifecycle — save, search, fact chains, timelines, audit, export, distill, beliefs, review | Usually 1–3 (search only) | Usually 0–1 |
| Evidence gate | **Yes**: `engram_assess` is enforced in code — "claims sufficient" + at least one valid ref from this batch + `nextStrategy=answer` | Generally none | Generally none |
| Audit | Session/turn/seq provenance, supersede chains, contradiction edges, full `op_log` | Usually logs only | None |
| Review | **SM-2 spaced repetition**: coordinates and placard cues only, never the body — recall first, reveal later | None | None |
| Injection safety | Protocol tags block prompt injection, redaction on write, capture placeholders break self-reinforcement loops | None | None |
| Portability | Markdown / JSON export + Obsidian/Logseq-friendly mirror | Varies | It is already files |
| UI languages | zh / en / ru | Varies | Usually one |

In one line: **we make memory a local library you install once, not a service you operate.**

## How a memory flows

```
  session log --+
               +--> capture / save --> four dispositions: accept · merge · defer · drop
  agent call+
                                            |
                                            SQLite dual store: user.db (follows you) + project-<hash>.db (follows the repo)
                                            |
      +----------------------+----------------------+----------------------+
      v                          v                        v
      FTS5 keyword lane          local vector lane (RRF)  one-hop relation edges
      +----------------------+----------------------+----------------------+
                                            v
                                            engram_search --> hits carry id= / ref= and a batch id
                                            v
                                            engram_assess (evidence gate): not enough -> keep searching
                                            v
                                            profile injection <-- beliefs · facts · entities <-- distill · decay · SM-2
```

## Screenshots

**Today** — the palace dashboard: KPI hero, activity heatmap, tour proposal, room directory.

<p align="center"><img src="docs/screenshots/today.png" width="820" alt="Today view: KPI hero, activity heatmap, room directory"></p>

**Full-width refurb list** — every suggestion shows its full reasoning and the complete memory text, read and act in place (demote / distill-merge), no popup detours.

<p align="center"><img src="docs/screenshots/refurb-fullwidth.png" width="820" alt="Refurb list: full-width, complete texts, in-place actions"></p>

**Library** — the full memory store with filters, sorting and inline placard expansion.

<p align="center"><img src="docs/screenshots/library.png" width="820" alt="Library view: filters, sorting, inline details"></p>

## Palace Structure: the Directory Is the Room, the Path Is the Route

A cross-session long-term memory plugin for DeepSeek Harness — it puts the memory palace's <b>information architecture</b> (not its neuroscience metaphor) into the agent: <b>location as index</b> (every memory pinned to a <code>room#slot</code> coordinate), <b>fixed route as order</b> (the tour route is append-only), <b>skeleton reused long-term</b> (a topic always lands in the same room and index), and <b>every marker unique</b> (placard rule: unique · distinctive · dated). Paired with spaced-repetition retrieval practice (cues only, never the body) and a knowledge flywheel (capture → reinforce → distill → decay).

What actually works in a memory palace is its **information architecture**, not the biology — machines can use the former, while an AI has neither the latter nor any need for it. Stripped down, there are only four things:

```
Grand hall · core memory   few and stable, always present      the profile injected every turn (entry cap + token budget)
  │
Corridor · route index     pick the room first, never scan the whole store   room directory + engram_search room=
  │
  ├─ Fact Hall              fact        what the user said
  ├─ Preference Pavilion    preference  tastes and preferences
  ├─ Decision Chamber       decision    decisions and agreements
  ├─ Episode Gallery        episode     experiences and timeline
  └─ Skill Workshop         skill       methods and techniques        capacity 9 per room, overflow opens "<name>-2"
  │
Placard · marker rule      unique · distinctive · dated      scored on write; low scores enter the refurb list
```

| Palace principle | What it is in the plugin | Code |
|---|---|---|
| Location as index | Slotted on write to `room#slot`; capacity 9 (7±2), overflow opens a new room, slots are never recycled | [src/palace/slots.ts](src/palace/slots.ts) |
| Fixed route as order | `tour_routes` is append-only; `engram_tour mode=fixed` walks the whole palace in slot order | [src/store/sqlite.ts](src/store/sqlite.ts) |
| Skeleton reused long-term | A topic always lands in the same room and index, so recall is sequential extraction rather than fresh search | [src/palace/slots.ts](src/palace/slots.ts) |
| Every marker unique | Placard scored 0-1: globally unique +0.4 / date anchor +0.3 / no 6-char prefix clash within the room +0.3 | [src/imagery/score.ts](src/imagery/score.ts) |
| Review discipline | SM-2 spaced repetition; retrieval practice returns cues and placards but **never the body text** | [src/review/sm2.ts](src/review/sm2.ts) |

Sensory and emotional dimensions (smell, temperature, emotional weight) are deliberately not scored: they are patches for the human brain's innate limits, and an AI has neither the limits nor the need.

## Features

- **Cross-session memory**: a user memory profile is injected at session start (entry cap plus token budget, both configurable; a curated profile maintained via `engram_profile_edit` takes precedence over derived facts), so the agent naturally knows who you are and what you are building; tools recall facts across sessions.
- **Dual-scope stores**: `user.db` shared globally; `project-<hash>.db` isolated per git origin identity (falls back to a working-directory encoding without git; legacy stores migrate automatically) — personal preferences follow the person, project conventions follow the repo.
- **Hybrid retrieval**: FTS5 (unicode61 + Chinese 2-gram pre-tokenization) fused with local vectors (by default `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, 384-dim, q8; model and pooling are configurable — see below) via RRF, plus one-hop expansion over relation edges and a multiplicative recency/proof ranking boost; the embedding model runs offline, and a failed download degrades to keyword-only retrieval with an explicit marker.
- **Memory-palace information architecture** (v0.7.2+): all four principles live on the core path, not in display-layer paint — **location as index** (writes sort by kind into rooms and pin a `room#slot` coordinate; room capacity 9, overflow opens a new room, slots are never recycled); **fixed route as order** (`tour_routes` is append-only; `engram_tour mode=fixed` walks the whole palace in slot order); **skeleton reused long-term** (a topic always lands in the same room and the same index, so recall is sequential extraction rather than fresh search); **every marker unique** (placard rule scored 0-1: globally unique +0.4 / date anchor +0.3 / no 6-char prefix clash within the room +0.3; low scores enter the refurb list; a palace with fewer than 8 active memories is left unscanned to avoid small-store noise).
- **Corridor-routed retrieval**: the profile carries a room directory, and `engram_search` accepts a `room` parameter — decide the room first, then search inside it, instead of always running whole-store RRF. The top 5 hits carry neighbouring slot ids from the same room as encoding-specificity cues.
- **Retrieval-practice loop** (spaced repetition): `engram_review_queue` returns palace coordinates and placard cues but **never the body text**, forcing the model to recall first; `engram_review` reveals the entry and `engram_report grade` (0-5) self-rates it, advancing an SM-2 schedule (1 → 6 → round(prev × ease) days, reset on failure, ease floor 1.3). Entries under review scheduling **no longer take part in automatic decay** — their fate is decided by recall. Session-start injection reports how many memories are due.
- **History backfill** (v0.7.3+): distils dsh's persisted past sessions into the palace, turn by turn — each session is written into the project store matching **its own cwd** (no cross-project bleed), reusing the live-capture throttling, redaction, and echo suppression, with a `(session, turn)` idempotency key so an interrupted run resumes. Backfilled entries never enter the due-today queue. **You choose the import rules** (time window / turns per session / total turn budget / auxiliary model / include subagent·seeded·no-cwd sessions) and see a zero-cost estimate (no LLM calls) before running; staging happens in a dedicated **"Backfill" tab** with progress (including a **breakdown of skip reasons**) and pause. Auxiliary calls **reuse the model you are currently using** by default (a past session's log records the provider/model of that time, which may no longer be available here), or you can pick one explicitly from the host's registered providers/models in the tab's "Auxiliary model" dropdown.
- **Knowledge flywheel**: capture/save → contradiction candidates (high-similarity neighbors create `contradicts` edges on write, for the model/user to adjudicate) → hit reinforcement (confidence +0.05) → distillation (topic clusters merge into higher-level rules, supersedes chains, confidence inheritance) → decay (low-importance, long-unaccessed entries archive; restorable).
- **Automatic belief consolidation** (v0.7.14+, off by default; yml `reflect: suggest|auto`): after a session ends, raw memories that have not yet served as evidence for any belief are consolidated by an auxiliary LLM into one-sentence **observations**. Unlike distillation, the raw memories are all kept — the observation is an **additional abstraction layer**: each belief carries its evidence-id list plus a proof count, and same-topic beliefs merge automatically by vector proximity (cosine ≥0.9), so one belief is **continuously refined** instead of duplicated. When new evidence lands near an existing belief (≥0.86) the belief turns `stale`, and the next consolidation feeds its raw evidence back to the model for a freshness review with four outcomes — `form` (new), `refine`, `still` (holds), `refute` (kept with its evidence chain for audit). In `auto` mode consolidation runs in the background after the session (5s timeout; failures never affect the conversation); in `suggest` mode it only enqueues a pending-consolidation task that the `engram_reflect` tool drains (the tool can also be invoked manually in any mode). The top 3 active beliefs by proof count are injected with the profile packet; stale/refuted beliefs are never injected. Schema upgraded to v12 (the observations table; incremental migration, zero data movement).
- **Jev System-One adjudication** (v0.7.12+, off by default, the `jev` block in yml): the DEFER fuzzy-band three-way ruling (merge / accept / defer) and contradiction-edge confirmation can be delegated to an external Jev model; when Jev is unavailable (network failure / timeout / no provider or model resolved) it silently falls back to the pure-rule four-way behavior, **never blocking writes**. Every adjudication leaves a side observation (verdict, whether Jev took part, elapsed time, fallback reason; up to 50 in-process, cleared on restart), so the panel's "Jev" view answers "why was this one deferred" at a glance. Five yml fields — the switch / provider / model / endpoint / timeout — can be overridden from the panel (stored at `<dbDir>/jev-config.json`, 0600 file inside a 0700 directory) and take effect on save without a restart; the endpoint defaults to `{baseURL}/systemone`; a "Test connection" button verifies it with the current input (unsaved values are tested as typed, never written to the override file); the token is never a plugin setting — it is resolved at call time from the named provider's credential store, so there is no second copy to mask, sync or rotate. The three thresholds stay yml-only advanced settings, shown read-only.
- **Entity lexicon** (v0.7.10+): the auxiliary LLM output of automatic capture and `engram_save` also extracts entity mentions (people/projects/tools/concepts, with optional aliases), resolved by normalized name against existing entities' names/aliases — a hit reuses the entity and refreshes its "last mentioned" stamp, a miss creates one; memories and entities link many-to-many, stored in the same store as the source memory. `engram_search` rows carry entity tags of the hits; entity-resolution failures silently skip the links and never block the memory write itself. The panel's "Entities" view filters by kind, searches names/aliases, and opens one entity to see every memory it pulls in.
- **Automatic capture** (when `ingest` is enabled): each new turn's first step extracts candidate facts from the previous turn out of the session log, and session end captures the final turn too (failures leave a pending key that the next session replays; capture is idempotent per session+turn), written with low confidence and, when embeddings are available, disposed by the four-state rule toward near neighbors (merge-and-reinforce restatements / edge-and-defer suspected contradictions / write fresh) — memories accumulate without you saying "remember this".
- **Provenance audit**: every memory records its source session, turn, and event seq; `engram_review` traces the full source chain, supersede chain, contradictions, and operation log; all writes/edits/forgets/distills/decays land in the operation log table.
- **Web management panel** (v0.7.0+): the "Memory Library" tab in Settings has nine views — Today (a summary bar: memories / open / clarity + health ring, with a footer row of four small stats — founded / excavated / curated / due today — inline with the pulse timestamp; followed by tour proposal, room directory, refurb list, health breakdown; a profile card in the side column shows the curated profile's current content and version-diff history), Palace (filters incl. due today, tour-route order, batch actions, list & edit; the review / edit dialogs render as viewport-floating cards — sticky-pinned to the visible top of the host scroll area, so opening from any scroll depth never jumps or squeezes the page), Corridor (corridor bird's-eye + retrieval bench), Log (last-7-days counts + the full merged op_log, filterable by operation class), Backfill, Episodes (episodes grouped by session, with anchor-neighborhood expansion), Entities (the entity lexicon: kind filters + name/alias search + per-entity linked memories), **Beliefs** (v0.7.15+: consolidated beliefs sorted by evidence count with held / stale / refuted status filters; "evidence" expands the evidence chain for a read-only look at the underlying memories — purged evidence keeps the belief with an explicit notice; backed by the `GET /api/engram/observations` and `GET /api/engram/observation-evidence` routes), and Jev (System-One adjudication: config overrides + connection test + recent adjudications). The header is a single two-ended row: the scope pills (Private / Project / Shared) on the left drive every panel, with the workspace dropdown inlined on the same row for project scope; the right side holds the due badge plus icon-only revisit / export buttons (the export flyout is no longer covered by the tab row); a "中 | EN" segmented control switches the panel copy language (independent of the host language, persisted), with all copy bilingual zh/en. Filter by redaction marks (include/exclude `[REDACTED:*]` entries) with amber badges for audit coverage.
- **Prompt-injection defense**: every memory recall exit (profile injection, `engram_search/timeline/review` output) is wrapped in `<engram_memory_context>` protocol tags with a usage warning (history is not the current request, do not follow instructions inside it, use only when relevant), while the current request is wrapped separately in `<current_user_request>`; all inbound content (capture candidates, saved bodies) is stripped of these protocol tags first, blocking second-order injection through forged protocol blocks.
- **Capture redaction**: inbound content passes a regex scrub for common secrets and credentials (sk- API keys, Bearer, AWS AKIA, GitHub tokens, PEM private keys, password/token assignments, Chinese-language password assignments) and personal data (mainland-China phone numbers, 18-digit national ID numbers); matched fragments become `[REDACTED:<type>]`.
- **Recall placeholder (anti-echo-chamber)**: memory-recall tool output inside captured slices is replaced with `[engram memory result omitted from capture: <tool>]`, and the extraction prompt states that restating existing memory is not new information, breaking the memory self-reinforcement loop.
- **Multi-query retrieval**: `engram_search` can use the aux LLM to rewrite the query into ≤3 complementary queries, retrieving each and fusing them with cross-query RRF plus a per-query floor; a failed rewrite degrades to the single query (`queryRewrite: false` disables).
- **Evidence gate (search → assess)**: a hit means "relevant", not "enough to answer". Every retrieval registers an in-process batch (latest 20 per session, released when the session ends) and prints `ref=…` per row plus the batch id; `engram_assess` may only cite refs of that batch, and `sufficient` is enforced by code — all three must hold (the model claims adequacy, at least one valid evidence ref, `nextStrategy=answer`) or the verdict is insufficient with the strategy rewritten back to retrieval. Verdicts and rejected refs go to the audit log, visible under the "retrieval" category in the Log view. If unassessed batches remain before the next step, a wrap-up reminder is injected (escalating to a change-strategy hint after ≥2 consecutive insufficient verdicts; `assessReminder: false` disables).
- **Portable data**: `engram_export` exports Markdown / JSON files in one step, with a redacted-view variant (secondary scrubbing + 40-char preview truncation, share-safe). `engram_mirror` writes an Obsidian / Logseq-friendly mirror directory (one Markdown per memory with YAML frontmatter + `[[id]]` backlinks), turning the palace into a human-readable private knowledge base.
- **AGI Architecture Exploration (dsh-market · AGI Architecture)**: listed in dsh-market's "AGI Architecture Exploration" category as a cognitive-science reframe of agent long-term memory — memory palace (imagery labels + room placards), corridor topology (force-directed graph), closure questions (the ingest prompt nudges the model to ask clarifying questions), consolidation merging (heuristic dedup + cosine similarity) — sitting alongside MemGPT / Letta in the "agent memory architecture" conversation.

## Tools (22, narrow parameters)

| Tool | Purpose |
|---|---|
| `engram_save` | Save (**four-state write disposition**: a restatement merges into and reinforces the existing entry (`merge`, no new node), a suspected contradiction is written with a `contradicts` edge pending adjudication (`defer`), fresh content is written (`accept`), low-entropy content is dropped (`drop`); without embeddings everything is `accept`); `items` array saves ≤10 in one call with shared scrubbing and in-batch dedup, reporting each entry's disposition (`disposition`/`mergedInto`), one failure not blocking the rest (`count`/`items`/`failed` summary); `placard` attaches a marker (scored unique · distinctive · dated; low scores get a rewrite hint); `entities` carries entity mentions (resolved and linked into the entity lexicon with the memory) |
| `engram_search` | Hybrid semantic + keyword retrieval (hits reinforce confidence); `room` routes through the corridor — search inside one room only; the top 5 hits carry same-room neighbouring-slot cues, and hit rows carry linked-entity tags; `asOf` does point-in-time lookback — only entity facts valid at that moment count, and hit rows carry point-in-time facts of linked entities at the row tail. Output rows carry `id=` and `ref=`; the tail carries the batch id |
| `engram_facts` | Entity fact-chain read/write. Write mode takes a `facts` array (≤50 entries, each `entity`/`entityId` + `content`); `replaces` supersedes an old fact (soft-invalidated, history chain kept); bad entries land in `failed` without interrupting the rest. Query mode takes `entity` (by name; no entity is created on miss, ambiguity lists candidates, near misses suggest alternatives) or `entityId` (exact); `includeInvalid` returns the full chain including invalidated facts, `asOf` filters to facts valid at that point in time |
| `engram_assess` | Evidence gate: before answering, judge whether the retrieved content suffices. Submit `batchId` + ≤8 `evidenceRefs` (only `ref=` values from that batch's output) + `missing` + `nextStrategy`; the code requires all three for `sufficient` (claimed adequate, at least one valid in-batch evidence ref, `nextStrategy=answer`), otherwise it rules insufficient and rewrites the strategy back to retrieval; refs from other batches are rejected and listed, and the verdict is written to the audit log |
| `engram_timeline` | Timeline browsing: creation-time descending by default; `order: 'tour'` follows the fixed tour route's slot order instead (output carries palace coordinates, entries off-route sorted last) so the agent can re-walk the route |
| `engram_episode_timeline` | Dedicated timeline for episodic memories: browse experiences by date range and source session, grouped by session (newest group first, entries chronological within; `sessionId` drills into one session; group headers carry the one-sentence session summary generated during capture or at session end). With `around` set to a memory id, it switches to temporal-neighborhood expansion — listing episodes within ± a window (`windowMinutes`, default 60) of the anchor's creation time, answering "what else happened around then" |
| `engram_update` | Correct an entry (supersedes chain); can re-attach a `placard` marker too |
| `engram_forget` | Forget (soft-delete, restorable) |
| `engram_report` | Report an outcome (preferred for skill-kind entries): success +0.05 / failure -0.1, and persistently useless memories decay away naturally. With `grade` (0-5) it advances the SM-2 review schedule instead, acting as the self-rating entry point of retrieval practice |
| `engram_review_queue` | Due-today queue: palace coordinates (`room#slot`), placard, and overdue days but **no body text** — recall first, reveal, then self-rate |
| `engram_review` | Audit one entry: source chain, supersede chain, contradictions, operation log |
| `engram_stats` | Whole-store statistics and signal ratio; carries the room directory (slots occupied per room plus the latest placard) |
| `engram_examine` | Progressive disclosure: fetch full placards by id in batches (≤16 recommended; retrieve ids first) |
| `engram_neighbors` | Corridor walk: from one room, follow 1-3 hops of relation edges and return a neighbour summary |
| `engram_tour` | Tour routing: `mode=fixed` walks the whole palace in fixed slot order (constant route, sequential extraction); `mode=thematic` plans 3-7 stops around a theme |
| `engram_audit_forgotten` | Closed-wing archaeology: list recent closed entries with their epitaphs to review whether past forgetting was sound |
| `engram_ingest_history` | History backfill: distil past dsh sessions into the palace turn by turn (per-cwd stores; already-captured turns skipped). After each session's turns are captured, an auxiliary LLM generates a one-sentence session summary stored for timeline group headers (live sessions get the same summary at dispose once the final turn is captured; failures stay silent and never block). `dryRun` defaults to true (estimate only); pass `dryRun=false` to run. Use the Settings "Backfill" tab for large batches |
| `engram_export` | Export Markdown / JSON files (data portability); `redactedView: true` emits a redacted view (secondary scrubbing + 40-char preview truncation, share-safe) |
| `engram_distill` | Distill: merge same-topic clusters into higher-level rules (LLM) |
| `engram_reflect` | Belief consolidation: abstract unconsolidated raw memories into proof-backed higher-level beliefs (four actions form/refine/still/refute; automatic vector-near-neighbor merging; raw memories stay active). Also drains the pending-consolidation queue created by reflect=suggest |
| `engram_profile_edit` | Edit the curated profile block: `view` shows the current content and version history; `edit` writes a new version (optimistic lock via `expectedVersion`, conflicts fail loud); `rollback` restores a historical version (appended as a new version; history is never rewritten). The curated profile is injected ahead of the derived profile; every edit lands in the operation log, and the profile card on the panel's Today view shows version diffs |

## Configuration

Optional configuration (cordis.yml):

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    dbDir: '~/.dsh/engram'          # store and model-cache root directory
    injectProfile: true             # inject the user memory profile at session start
    profileTopN: 8                  # injection entry cap (1-64)
    injectTokenBudget: 1024         # injection token budget (128-8192; CJK text counted at 1.5 tokens/char, other text at 4 chars/token; entries that still don't fit degrade to index lines)
    injectItemBudgetStart: 160      # graduated budget: body chars for the first entry (40-2000, decayed per entry; truncate first before degrading)
    injectItemBudgetDecay: 0.9      # graduated budget: per-entry decay factor (0.5-1)
    injectItemBudgetFloor: 24       # graduated budget: per-entry body char floor (8-200, must not exceed start)
    assessReminder: true            # evidence-gate nudge: inject an engram_assess reminder before the next step when unassessed search batches exist
    modelCacheDir: '~/.dsh/engram/models'  # embedding model cache directory
    hfEndpoint: 'https://huggingface.co'   # model download endpoint; set a mirror behind restricted networks
    # Embedder: omitting this whole block means local + the default model; `kind` picks the local model or a remote endpoint
    embedder:
      kind: 'local'                   # local (transformers.js, offline inference) | remote (OpenAI-compatible /embeddings)
      localModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'  # 384-dim; the previous default Xenova/bge-small-zh-v1.5 is 512-dim
      localPooling: 'mean'            # mean (most sentence-embedding models) | cls (bge-m3 and the XLM-R family)
      # kind: 'remote'
      # model: 'text-embedding-3-small'      # remote: model name, passed through to the server
      # baseUrl: 'https://api.example.com/v1' # remote: root address including the version
      # apiKeyEnv: 'EMBEDDING_API_KEY'        # remote: read the key from this environment variable (wins over a literal apiKey)
      # batchSize: 32                         # remote: items per batch
      # timeoutMs: 30000                      # remote: per-request timeout in ms
    # Changing the model means re-embedding: a dimension that does not match the store is refused on write and on comparison (EMBEDDER_DIMENSION_MISMATCH) rather than truncated into a plausible-looking similarity
    ingest: 'off'                   # automatic capture: off | light (user messages only, ≤2/turn) | eager (assistant messages too, ≤5/turn)
    reflect: 'off'                  # automatic belief consolidation: off | suggest (only enqueue on session end; drain via engram_reflect) | auto (consolidate in the background after the session); engram_reflect stays manually callable in every mode
    # provider and model must be given as a pair: aux-LLM route override for capture/distill (parsed from the session log by default)
    # provider: 'deepseek'
    # model: 'deepseek-v4-flash'
    decayAfterDays: 30              # decay: last access older than this many days (also the recency-boost decay window)
    decayImportanceBelow: 0.3       # decay: and importance below this → archive (restorable)
    rankRecencyWeight: 0.2          # retrieval recency boost weight (0-2, 0 disables)
    rankProofWeight: 0.1            # retrieval hit-count boost weight (0-2, 0 disables)
    queryRewrite: true              # engram_search rewrites ≤3 queries via the aux LLM and fuses them with RRF (degrades to a single query on failure)
    autoSlot: true                  # write-time auto-sloting (sort by kind into rooms, pin `room#slot`, register on the tour route)
    reviewScheduling: true          # write-time enrolment in review scheduling (first due in 1 day; off = new entries never enter the SM-2 queue)
    # History-backfill defaults (initial values for the tab and the tool; the total-turn cap is a hard ceiling you can only lower per run)
    historyBackfillDays: 7                  # default time window in days; 0 = unlimited
    historyBackfillMaxTurnsPerSession: 20   # default max turns per session
    historyBackfillMaxTotalTurns: 200       # hard cap on turns per run (1-5000)
    historyBackfillIncludeSubagents: false  # exclude subagent sessions by default
    historyBackfillIncludeSeeded: false     # exclude seeded sessions by default
    historyBackfillIncludeNoCwd: false      # exclude sessions without cwd by default (they can only go to the user store)
    # Jev System-One adjudication (off by default; provider and model come from DSH and the plugin stores no key; failures silently degrade to the pure-rule four-way behavior)
    # DEFER fuzzy-band three-way ruling: probability ≥ deferMergeAbove → same memory (merge), ≤ deferAcceptBelow → different (accept), in between stays defer;
    # before a defer lands, contradiction edges are confirmed by Jev first (an edge is created only at probability ≥ contradictMinProbability).
    jev:
      enabled: false                        # switch
      # provider: ''                        # DSH provider Jev is taken from (its baseURL and credential store are used); empty = the provider this session already runs on
      # model: 'jev-latest'                 # adjudication model name; empty = that provider's first Jev model
      # endpoint: ''                        # full System One endpoint (POST /v1/systemone); empty = derived from the provider as {baseURL}/systemone
      # timeoutMs: 3000                     # per-request timeout in ms (1000-60000)
      # deferMergeAbove: 0.85               # fuzzy-band probability ≥ this → same memory (merge)
      # deferAcceptBelow: 0.15              # fuzzy-band probability ≤ this → different (accept)
      # contradictMinProbability: 0.8       # contradiction confirmation probability ≥ this → create the contradicts edge
    # The five fields above (enabled/provider/model/endpoint/timeoutMs) can be overridden from the panel's "Jev" tab (stored at <dbDir>/jev-config.json, field-level override, effective immediately on save); the three thresholds are configurable only here. The token is not a plugin setting: it is resolved at call time from the named provider's credential store, so the plugin holds no secret to mask, sync or rotate. A legacy apiKey/baseUrl left in this block or in the override is ignored, with a one-time warning naming the field and telling you where the key moved
```

## How It Works

The plugin has a host half (Node) and a browser half (React):

```
Session agent                              Host half (Node)
  │                                          │
  ├─ every turn, first step ◀─────────────── ├─ user memory profile injection (plugin-source user snapshot)
  ├─ engram_save / search / review … ──────▶ ├─ SQLite dual stores (user.db / project-<origin hash>.db)
  │                                          ├─ FTS5 keyword track + local vector track, RRF fusion + ranking boost
  ├─ engram_distill ───────────────────────▶ ├─ aux-LLM distillation (cluster merge → supersedes chain)
  ├─ session end (reflect enabled) ────────▶ ├─ belief consolidation (unconsolidated evidence → observations: near-neighbor merge / stale review)
  │                                          └─ automatic capture: session log → candidate facts (incl. the final turn at session end; ingest on)
  └─ Settings "Memory Library" tab ◀──────── ─── loopback API /api/engram/* (writes verify loopback Origin)
```

- **Dual-scope stores**: `user.db` shared globally; `project-<hash>.db` named by the normalized git origin URL hash (`git@github.com:a/b.git` and `https://github.com/a/b` share one store; worktrees resolve through the pointer to the main repo's origin); without git or an origin it falls back to a working-directory encoding, and legacy cwd-named stores are renamed in place at startup (if both exist, nothing moves and a warning is logged).
- **Palace structure (the directory is the room, the path is the route)**: the **grand hall** is the standing core profile injected every turn (few and stable, always present); the **corridor** is the room directory in the profile plus the `engram_search room` parameter (pick the room, then search); **rooms** sort by kind (Fact Hall / Preference Pavilion / Decision Chamber / Episode Gallery / Skill Workshop) with capacity 9, overflowing into `<name>-2`; **placards** are each memory's `placard` marker, scored on the unique · distinctive · dated rule. Existing stores are slotted on first open (idempotent; opening a new room logs a warning so a human can name it).
- **Automatic capture** (when `ingest` is on): each new turn's first step extracts candidate facts from the previous turn out of the session log; session end (`session/disposed`) captures the final turn with a 5-second timeout, and on failure/timeout a pending key lands in the operation log for the next session's first step to replay; captured (session, turn) pairs are idempotent. The read source is the session log; aux-call request auditing goes to the plugin's own operation log — unknown events are never appended to the session log. Candidates are written with low confidence and deduplicated by embedding.
- **Provenance chain**: every memory records its source session, turn, and event seq, fully traceable via `engram_review`; the operation log table records every write/edit/forget/distill/decay.
- **Offline embeddings**: the model downloads once (q8, ~50MB; mirror endpoint configurable), then runs fully offline; on failure the plugin keeps working and retrieval degrades to keyword-only with an explicit marker. **The dimension is a hard constraint**: when the stored vectors and the current model disagree, writes and similarity comparisons are both refused with `EMBEDDER_DIMENSION_MISMATCH` (naming both dimensions) instead of being truncated into a plausible-looking similarity.
- **UI localization**: the client half registers zh/en dictionaries through the host locale service and follows the host language setting live; data-level enums (status/kind) are mapped only in the display layer and stay English in storage.

## Web Management Panel

After installation, a **Memory Palace** entry appears in the host sidebar (a standalone panel app since v0.8, no longer a settings tab), with 9 views covering everything a memory library needs day to day:

| View | What it shows |
|---|---|
| **Today** | KPI hero (memories / open / clarity / due today, each with a sparkline) + 6-month activity heatmap + tour proposal + **full-width refurb list** + room directory + resident profile |
| **Library** | The full memory store: filter by room / status / text, time & tour-route sorting, inline placard expansion, edit-via-supersession, batch forget / restore |
| **Corridor** | The memory graph: floorplan (architectural metaphor) / force-directed modes, plus a retrieval workbench with 1–3 hop roaming |
| **Spiral** | A spiral-layout overview, older towards the centre |
| **Episodes** | The episode timeline: grouped by session with LLM summaries, anchor-based proximity expansion |
| **Entities** | The people / projects / tools / concepts dictionary with per-entity memory links |
| **Beliefs** | Distilled higher-level patterns with six-step evidence strength |
| **Log** | The merged op_log audit trail, filterable by operation class |
| **Ops** | History backfill (estimate → run → resume), Jev adjudication setup and the recent-verdicts feed |

The UI language follows the panel switcher (中文 / English / Русский), and server-generated reason strings follow it too. All data flows over the loopback API `/api/engram/*` (write actions are gated by loopback origin plus the three-layer write guard). When the panel bundle and the backend process are different versions, a banner reminds you to restart the app. Headless profiles without a webServer mount nothing; everything else keeps working. The per-release panel notes from the v0.7 era live in [docs/panel-history-v0.7.md](docs/panel-history-v0.7.md).

## Development

```sh
pnpm install            # prepare symlinks @deepseek-ai/* peers from ../deepseek-harness (run pnpm install && pnpm run build in the harness repo first); runs pnpm bundle automatically when lib/ is missing
pnpm test               # unit + composition tests; real-embedding e2e runs when ENGRAM_E2E=1 (HF_ENDPOINT configurable) and the network allows
pnpm typecheck
pnpm bundle
```

### Checks before a PR

```sh
node scripts/check-messages.mjs   # every key the code asks for is declared, nothing is orphaned, zh/en/ru aligned
node scripts/check-patterns.mjs   # secret redaction and chit-chat rejection behave on every declared language
pnpm typecheck
pnpm test
```

The first two run on a bare checkout, and CI (`.github/workflows/checks.yml`) runs exactly those two, plus `pnpm install --frozen-lockfile --ignore-scripts`. `typecheck`, `test` and `bundle` cannot run there: the `@deepseek-ai/*` peers are not on npm (see `.npmrc`), so they resolve only inside a `deepseek-harness` workspace. Run all four locally before opening a PR — a dictionary mistake fails loudly on your machine, but a locale-dependent assertion (one that asserts Chinese text while `language: 'auto'` resolves to the developer's own locale) fails only on someone else's.

Two notes on install and build scripts:

- **GitHub source quick-install** (`dsh plugin add github:kenz1117/dsh-engram`) fetches sources; `prepare` runs `pnpm bundle` on the spot when `lib/` is missing. If that build fails, read the bundle section of the prepare log — not the host's misleading "no entry point".
- **Native build permission**: the native packages pulled in transitively by `@huggingface/transformers` (`onnxruntime-node`, `sharp`, `protobufjs`) need pnpm's permission to run their build scripts. pnpm 11 ignores the in-package `pnpm.onlyBuiltDependencies` field; the permission must live on the **consumer** side (profile / workspace) — pnpm 11 uses `allowBuilds` in `pnpm-workspace.yaml`, pnpm 10 uses `onlyBuiltDependencies` in the same file. Without it pnpm skips those builds and reports the skips as errors, leaving the embedder unusable; grant the permission and reinstall.

## Model Experience

### Request context and condition

#### What the model sees

Each turn's first step appends a plugin-source user snapshot: `User memory profile (dsh-engram, cross-session) — Grand Hall (always present):` followed by the user-scope memory list (up to 8 entries within a 1024-token budget by default; over-budget entries degrade to `#id` index lines; `injectProfile: false` disables), each line carrying its palace coordinate (`room#slot`); when reviews are due, a line reporting how many memories are due is appended. Tool results are plain text lines (with `id=`, scope/kind annotations, slot coordinates, contradiction-candidate hints, and degradation notes). Automatic capture and distillation each make one aux-LLM call (billed independently of the main conversation path, with purpose attribution).

#### Token effect

Profile injection is a conditional fixed cost (bounded by both the entry cap and the token budget); the tool schemas are a standing cost (22 narrow-parameter tools).

#### KV Cache effect

Profile text changes as the memory store changes — changes only land at turn boundaries in new sessions or after memory updates; within a session the prefix stays stable while the injected content is unchanged; tool schemas are constant and never affect the prefix.

## Known Limitations and Deferred Work

- **Contradiction checks are LLM-free by default** — writes report candidates by vector similarity (≥0.88) and create edges; semantic-contradiction confirmation is left to model/user adjudication and distillation. Optional Jev adjudication (the panel's "Jev" tab or the yml `jev` block) routes the fuzzy band and contradiction edges to an external judge, falling back to this default whenever Jev is unavailable.
- **Memories written during embedder degradation have no vectors** — memories written before the model is ready do not participate in the semantic track; after semantics come online run `pnpm backfill` once to backfill existing vectors (after `pnpm build` has warmed the model cache; `HF_ENDPOINT` configurable). **The same holds when you change the model**: once `embedder.localModel` changes (or you switch between local and remote), the stored vectors no longer match the new model's dimension and writes are refused — either switch the model back, or re-embed everything with the new one: `pnpm backfill -- --force --model <id>` (optionally `--pooling mean|cls`; point `--cache-dir` at an existing model cache to skip a download). The script scans every store under `<dbDir>` (`user.db`, `shared.db`, `project-<hash>.db`); without `--force`, a model whose dimension differs from the stored vectors makes it fail before writing anything, so a mixed-dimension store can never be produced. Remote embedders (`kind: remote`) are out of scope — the script runs local transformers.js inference and cannot reproduce a remote endpoint's vectors.

## Roadmap

The palace IA (position-as-index / fixed routes / retrieval practice) is the indexing and audit skeleton; it evolves toward AI-native memory tiers and a temporal fact graph in three phases. Actual releases increment by 0.0.1; the phase labels are planning codenames only:

- **Phase 1 · Flywheel closure** (done, v0.7.8): four-state write disposition (ACCEPT new / MERGE reinforce-in-place / DROP low-entropy / DEFER contradiction-pending — `engram_save` and capture return it per item); graduated decaying injection budget (160 chars for the first entry, ×0.9 per subsequent entry, floor 24, all configurable); redaction extended to Chinese passwords, national ID numbers, and phone numbers; evidence-gate wrap-up reminder (inject a reminder when a turn ends with unassessed search batches).
- **Phase 2 · Memory tiers**: editable profile (**done, v0.7.9**: `engram_profile_edit` tool with version-chain rollback and panel diff audit, following Letta's core-memory model); a dedicated timeline index for episode memories (**done, v0.7.9**: `engram_episode_timeline` tool with date ranges, per-session grouping, temporal-neighborhood expansion, and a dedicated episode index; the panel "Episodes" view plus capture-time and live-session summary group headers landed in the same batch); automated belief consolidation (**done, v0.7.14**: the observations table (schema v12) with evidence chains and proof counts; triggered on session end via `reflect: suggest|auto`; near-neighbor merging continuously refines one belief; stale freshness review with the four actions form/refine/still/refute; active beliefs are injected with the profile; manual `engram_distill` stays available); configurable room capacity and placard scoring (defaults unchanged).
- **Phase 3 · Temporal fact graph**: entity table with write-time extraction and resolution (**done, v0.7.10**: the entities + node_entities tables; capture/save auxiliary output carries entity mentions resolved on write; `engram_search` hits carry entity tags; panel "Entities" view + entity loopback routes); fact-level triples carrying `valid_at` / `invalid_at` windows with soft-invalidated conflicts (**done, v0.7.11**: the facts table (entity + time window + `replaced_by` + source memory), capture auxiliary output carries facts matched into the table by normalized entity name, `replaces` declares the soft-invalidation chain, `engram_search` gains `asOf` point-in-time lookback, the `engram_facts` tool reads and writes fact chains, and the panel entity page shows fact-chain details); automatic supports / refines / related edge creation; a LoCoMo-zh evaluation subset in CI as a retrieval-quality regression gate (deterministic Recall@k / MRR metrics).

## Acknowledgements

Thanks to the community contributors who made this project better:

- **[@dsv180](https://github.com/dsv180)** — the most prolific community contributor. [PR #13](https://github.com/kenz1117/dsh-engram/pull/13): bilingual host message catalog (zh/en) plus the language-pattern acceptance script (the skeleton of `check-patterns`). [PR #22](https://github.com/kenz1117/dsh-engram/pull/22): CI gates that make the two peer-free checks actually run on a hosted runner. [PR #23](https://github.com/kenz1117/dsh-engram/pull/23): made every peer optional via `peerDependenciesMeta` — fixing the packaging incident that left releases 0.8.0–0.8.14 uninstallable in clean profiles. [PR #20](https://github.com/kenz1117/dsh-engram/pull/20) (Jev credentials move up into the host; the plugin stores no keys) and [PR #21](https://github.com/kenz1117/dsh-engram/pull/21) (the embedder becomes a deployment property with a hard dimension guard) are under review. Every PR arrives with bilingual write-ups, itemised verification evidence and an honest limits list — a model of collaboration.
- **[@FeiLZX3Km](https://github.com/FeiLZX3Km)** — [Issue #19](https://github.com/kenz1117/dsh-engram/issues/19): three rounds of high-quality UI feedback (sidebar icon back to monochrome, full-width refurb list, popup readability), each with their own code investigation; the v0.8.15 / v0.9.1 interface fixes trace directly to it.
- - **[@lujfsd](https://github.com/lujfsd)** — [PR #2](https://github.com/kenz1117/dsh-engram/pull/2): adapting to the new dsh `sessionPersistence` read-handle API (`load()` was removed upstream), per-candidate scope on capture (the extraction output now carries `scope`), the project palace following the active workspace (`GET /api/engram/workspaces` plus the panel workspace picker), and renaming the no-git store key from "first 12 chars of cwd" to a full cwd sha256 (fixing collisions between sibling directories) — with 17 new tests and two design documents.
- **[@f0909172434](https://github.com/f0909172434)** — [PR #4](https://github.com/kenz1117/dsh-engram/pull/4): governance for ambiguous legacy database ownership — the eager rename now writes a JSON tombstone sidecar (`<old db>.migrated-to`, created exclusively with 0o600, recording `migratedTo` / `claimedByCwd` / `claimedAt`), and a later workspace hitting the same legacy name receives a warning naming the prior claim; a new `legacyMigration` config (`eager` migrates automatically by default / `conservative` leaves old databases untouched with a warning), with migration outcomes refined into `renamed` / `kept-both` / `deferred` / `already-migrated`. Ships with tests.

## License

[MIT](LICENSE) © 2026 KenZ (kenz1117)

### Legacy project database migration

`legacyMigration: eager` (default) keeps the automatic rename when only the old
filename exists. A private JSON sidecar, `<old filename>.migrated-to`, records
`migratedTo`, `claimedByCwd`, and `claimedAt` (ISO timestamp). A later workspace
with the same truncated old filename receives a warning naming the prior claim.
The record describes a file migration, **not proof of per-memory ownership**.
Same-origin worktrees continue to share the same new database.

Set `legacyMigration: conservative` in the plugin's `cordis.yml` config **before
upgrading/opening old data** to leave the old database untouched. Engram warns
with the old and proposed filenames and opens a new, initially empty project
store, so the session can continue. If old and new files coexist, neither is
moved or merged, regardless of policy. This mode cannot undo an earlier migration.

Before manually resolving ownership, stop all hosts using the directory and back
up databases and their SQLite sidecars. Review/export the relevant memories with
`engram_review` / `engram_export`. The new store may already contain fresh data:
**do not blindly move the old file over it**. Audit both stores and reassign data
manually; no automatic classification, split, merge, or deletion is performed.

The pointer includes a local workspace path; treat it as private metadata.
Malformed/unreadable pointers stop migration rather than silently losing the
claim history. Restoring an old file beside a pointer requires manual review.
Rename and pointer creation are separate filesystem operations, not a transaction
or cross-process lock. A pointer-write failure is reported with both filenames;
the database has already moved and is not automatically rolled back. After a
crash between the operations, inspect both paths before retrying. Existing
migrations performed before this feature have no retroactive pointer.
