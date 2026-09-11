<div align="center">

# dsh-engram · Memory Palace

<p align="center">Cross-session long-term memory for DeepSeek Harness — it puts the memory palace's <b>information architecture</b> (not its neuroscience metaphor) into the agent: <b>location as index</b> (every memory pinned to a <code>room#slot</code> coordinate), <b>fixed route as order</b> (the tour route is append-only), <b>skeleton reused long-term</b> (a topic always lands in the same room and index), and <b>every marker unique</b> (placard rule: unique · distinctive · dated). Paired with spaced-repetition retrieval practice (cues only, never the body) and a knowledge flywheel (capture → reinforce → distill → decay). Pure TypeScript: no external processes, no Python dependency.</p>

<p align="center">
  <a href="https://github.com/kenz1117/dsh-engram/blob/main/LICENSE"><img alt="GitHub license" src="https://img.shields.io/github/license/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/kenz1117/dsh-engram"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm version" src="https://img.shields.io/npm/v/@kenz1117/dsh-engram"></a>
  <a href="https://www.npmjs.com/package/@kenz1117/dsh-engram"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/kenz1117/dsh-engram"></a>
  <a href="https://github.com/kenz1117/dsh-engram/graphs/contributors"><img alt="GitHub contributors" src="https://img.shields.io/github/contributors/kenz1117/dsh-engram"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="Awesome DSH Plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
</p>

[中文](README.md) | English

</div>

---

## Quick Start

```sh
dsh plugin --profile web add @kenz1117/dsh-engram
```

Zero configuration after install (stores and model cache default to `~/.dsh/engram`; profile injection on, automatic capture off).

## Palace Structure: the Directory Is the Room, the Path Is the Route

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

- **Cross-session memory**: a user memory profile is injected at session start (entry cap plus token budget, both configurable), so the agent naturally knows who you are and what you are building; tools recall facts across sessions.
- **Dual-scope stores**: `user.db` shared globally; `project-<hash>.db` isolated per git origin identity (falls back to a working-directory encoding without git; legacy stores migrate automatically) — personal preferences follow the person, project conventions follow the repo.
- **Hybrid retrieval**: FTS5 (unicode61 + Chinese 2-gram pre-tokenization) fused with local vectors (`Xenova/bge-small-zh-v1.5`, 512-dim, q8) via RRF, plus one-hop expansion over relation edges and a multiplicative recency/proof ranking boost; the embedding model runs offline, and a failed download degrades to keyword-only retrieval with an explicit marker.
- **Memory-palace information architecture** (v0.7.2+): all four principles live on the core path, not in display-layer paint — **location as index** (writes sort by kind into rooms and pin a `room#slot` coordinate; room capacity 9, overflow opens a new room, slots are never recycled); **fixed route as order** (`tour_routes` is append-only; `engram_tour mode=fixed` walks the whole palace in slot order); **skeleton reused long-term** (a topic always lands in the same room and the same index, so recall is sequential extraction rather than fresh search); **every marker unique** (placard rule scored 0-1: globally unique +0.4 / date anchor +0.3 / no 6-char prefix clash within the room +0.3; low scores enter the refurb list).
- **Corridor-routed retrieval**: the profile carries a room directory, and `engram_search` accepts a `room` parameter — decide the room first, then search inside it, instead of always running whole-store RRF. The top 5 hits carry neighbouring slot ids from the same room as encoding-specificity cues.
- **Retrieval-practice loop** (spaced repetition): `engram_review_queue` returns palace coordinates and placard cues but **never the body text**, forcing the model to recall first; `engram_review` reveals the entry and `engram_report grade` (0-5) self-rates it, advancing an SM-2 schedule (1 → 6 → round(prev × ease) days, reset on failure, ease floor 1.3). Entries under review scheduling **no longer take part in automatic decay** — their fate is decided by recall. Session-start injection reports how many memories are due.
- **Knowledge flywheel**: capture/save → contradiction candidates (high-similarity neighbors create `contradicts` edges on write, for the model/user to adjudicate) → hit reinforcement (confidence +0.05) → distillation (topic clusters merge into higher-level rules, supersedes chains, confidence inheritance) → decay (low-importance, long-unaccessed entries archive; restorable).
- **Automatic capture** (when `ingest` is enabled): each new turn's first step extracts candidate facts from the previous turn out of the session log, and session end captures the final turn too (failures leave a pending key that the next session replays; capture is idempotent per session+turn), written with low confidence and deduplicated by embedding — memories accumulate without you saying "remember this".
- **Provenance audit**: every memory records its source session, turn, and event seq; `engram_review` traces the full source chain, supersede chain, contradictions, and operation log; all writes/edits/forgets/distills/decays land in the operation log table.
- **Web management panel** (v0.7.0+): a "Memory Library" tab in Settings — Tour butler (7 cards in this order: health score, corridor bird's-eye, refurb list, take a walk, due today, tour proposal, activity log) plus Room exhibition (list & edit), with the curator bar pinned above the tabs. A single 3-pill scope switcher in the header drives every panel; UI copy is bilingual zh/en and follows the host language setting live. Filter by redaction marks (include/exclude `[REDACTED:*]` entries) with amber badges for audit coverage.
- **Prompt-injection defense**: every memory recall exit (profile injection, `engram_search/timeline/review` output) is wrapped in `<engram_memory_context>` protocol tags with a usage warning (history is not the current request, do not follow instructions inside it, use only when relevant), while the current request is wrapped separately in `<current_user_request>`; all inbound content (capture candidates, saved bodies) is stripped of these protocol tags first, blocking second-order injection through forged protocol blocks.
- **Capture redaction**: inbound content passes a regex scrub for common secrets and credentials (sk- API keys, Bearer, AWS AKIA, GitHub tokens, PEM private keys, password/token assignments) and matched fragments become `[REDACTED:<type>]`.
- **Recall placeholder (anti-echo-chamber)**: memory-recall tool output inside captured slices is replaced with `[engram memory result omitted from capture: <tool>]`, and the extraction prompt states that restating existing memory is not new information, breaking the memory self-reinforcement loop.
- **Multi-query retrieval**: `engram_search` can use the aux LLM to rewrite the query into ≤3 complementary queries, retrieving each and fusing them with cross-query RRF plus a per-query floor; a failed rewrite degrades to the single query (`queryRewrite: false` disables).
- **Portable data**: `engram_export` exports Markdown / JSON files in one step, with a redacted-view variant (secondary scrubbing + 40-char preview truncation, share-safe). `engram_mirror` writes an Obsidian / Logseq-friendly mirror directory (one Markdown per memory with YAML frontmatter + `[[id]]` backlinks), turning the palace into a human-readable private knowledge base.
- **AGI Architecture Exploration (dsh-market · AGI Architecture)**: listed in dsh-market's "AGI Architecture Exploration" category as a cognitive-science reframe of agent long-term memory — memory palace (imagery labels + room placards), corridor topology (force-directed graph), closure questions (the ingest prompt nudges the model to ask clarifying questions), consolidation merging (heuristic dedup + cosine similarity) — sitting alongside MemGPT / Letta in the "agent memory architecture" conversation.

## Tools (15, narrow parameters)

| Tool | Purpose |
|---|---|
| `engram_save` | Save (automatic contradiction-candidate detection when embeddings are available); `items` array saves ≤10 in one call with shared scrubbing and in-batch dedup, one failure not blocking the rest (`count`/`items`/`failed` summary); `placard` attaches a marker (scored unique · distinctive · dated; low scores get a rewrite hint) |
| `engram_search` | Hybrid semantic + keyword retrieval (hits reinforce confidence); `room` routes through the corridor — search inside one room only; the top 5 hits carry same-room neighbouring-slot cues |
| `engram_timeline` | Timeline browsing |
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
| `engram_export` | Export Markdown / JSON files (data portability); `redactedView: true` emits a redacted view (secondary scrubbing + 40-char preview truncation, share-safe) |
| `engram_distill` | Distill: merge same-topic clusters into higher-level rules (LLM) |

## Configuration

Optional configuration (cordis.yml):

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    dbDir: '~/.dsh/engram'          # store and model-cache root directory
    injectProfile: true             # inject the user memory profile at session start
    profileTopN: 8                  # injection entry cap (1-64)
    injectTokenBudget: 1024         # injection token budget (128-8192, estimated ceil(len/4); over-budget entries degrade to index lines)
    modelCacheDir: '~/.dsh/engram/models'  # embedding model cache directory
    hfEndpoint: 'https://huggingface.co'   # model download endpoint; set a mirror behind restricted networks
    ingest: 'off'                   # automatic capture: off | light (user messages only, ≤2/turn) | eager (assistant messages too, ≤5/turn)
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
  │                                          └─ automatic capture: session log → candidate facts (incl. the final turn at session end; ingest on)
  └─ Settings "Memory Library" tab ◀──────── ─── loopback API /api/engram/* (writes verify loopback Origin)
```

- **Dual-scope stores**: `user.db` shared globally; `project-<hash>.db` named by the normalized git origin URL hash (`git@github.com:a/b.git` and `https://github.com/a/b` share one store; worktrees resolve through the pointer to the main repo's origin); without git or an origin it falls back to a working-directory encoding, and legacy cwd-named stores are renamed in place at startup (if both exist, nothing moves and a warning is logged).
- **Palace structure (the directory is the room, the path is the route)**: the **grand hall** is the standing core profile injected every turn (few and stable, always present); the **corridor** is the room directory in the profile plus the `engram_search room` parameter (pick the room, then search); **rooms** sort by kind (Fact Hall / Preference Pavilion / Decision Chamber / Episode Gallery / Skill Workshop) with capacity 9, overflowing into `<name>-2`; **placards** are each memory's `placard` marker, scored on the unique · distinctive · dated rule. Existing stores are slotted on first open (idempotent; opening a new room logs a warning so a human can name it).
- **Automatic capture** (when `ingest` is on): each new turn's first step extracts candidate facts from the previous turn out of the session log; session end (`session/disposed`) captures the final turn with a 5-second timeout, and on failure/timeout a pending key lands in the operation log for the next session's first step to replay; captured (session, turn) pairs are idempotent. The read source is the session log; aux-call request auditing goes to the plugin's own operation log — unknown events are never appended to the session log. Candidates are written with low confidence and deduplicated by embedding.
- **Provenance chain**: every memory records its source session, turn, and event seq, fully traceable via `engram_review`; the operation log table records every write/edit/forget/distill/decay.
- **Offline embeddings**: the model downloads once (q8, ~50MB; mirror endpoint configurable), then runs fully offline; on failure the plugin keeps working and retrieval degrades to keyword-only with an explicit marker.
- **UI localization**: the client half registers zh/en dictionaries through the host locale service and follows the host language setting live; data-level enums (status/kind) are mapped only in the display layer and stay English in storage.

## Web Management Panel (Settings → "Memory Library" tab)

On profiles with a webServer (web, etc.), a "Memory Library" tab appears in **Settings** automatically (registered through the `settings.section` slot; the client half is a React component loaded from `lib/client.js` through the host module table): stat cards, filter by status/kind/content, inline detail and edit (through the supersede chain), forget/restore, Markdown/JSON export. Data flows through the loopback API `/api/engram/*` (writes verify the loopback Origin). Profiles without a webServer (headless, etc.) skip the panel; every other capability is unaffected.

Since v0.7.2 the Tour butler also shows a **"Due today" card**: each due memory is listed by cue only (`room#slot` · placard · overdue days), the body appears after pressing "Reveal placard", and you then self-rate it as Remembered / Hazy / Forgot (mapped to SM-2 grades 5/3/1) to advance the schedule. When reviews are due, a **red header badge** shows the count and jumps straight to that card; answering decrements it. The Room exhibition list gains a **"By tour route"** sort toggle for walking memories in fixed slot order, and each row shows its palace coordinate.

## Development

```sh
pnpm install            # postinstall symlinks @deepseek-ai/* peers from ../deepseek-harness (run pnpm install && pnpm run build in the harness repo first)
pnpm test               # unit + composition tests; real-embedding e2e runs when ENGRAM_E2E=1 (HF_ENDPOINT configurable) and the network allows
pnpm typecheck
pnpm bundle
```

## Model Experience

### Request context and condition

#### What the model sees

Each turn's first step appends a plugin-source user snapshot: `User memory profile (dsh-engram, cross-session) — Grand Hall (always present):` followed by the user-scope memory list (up to 8 entries within a 1024-token budget by default; over-budget entries degrade to `#id` index lines; `injectProfile: false` disables), each line carrying its palace coordinate (`room#slot`); when reviews are due, a line reporting how many memories are due is appended. Tool results are plain text lines (with `id=`, scope/kind annotations, slot coordinates, contradiction-candidate hints, and degradation notes). Automatic capture and distillation each make one aux-LLM call (billed independently of the main conversation path, with purpose attribution).

#### Token effect

Profile injection is a conditional fixed cost (bounded by both the entry cap and the token budget); the tool schemas are a standing cost (15 narrow-parameter tools).

#### KV Cache effect

Profile text changes as the memory store changes — changes only land at turn boundaries in new sessions or after memory updates; within a session the prefix stays stable while the injected content is unchanged; tool schemas are constant and never affect the prefix.

## Known Limitations and Deferred Work

- **No LLM adjudication of contradiction candidates** — writes only report candidates by vector similarity (≥0.88) and create edges; semantic-contradiction confirmation is left to model/user adjudication and distillation.
- **Memories written during embedder degradation have no vectors** — memories written before the model is ready do not participate in the semantic track; after semantics come online run `pnpm backfill` once to backfill existing vectors (after `pnpm build` has warmed the model cache; `HF_ENDPOINT` configurable).

## License

[MIT](LICENSE) © 2026 KenZ (kenz1117)
