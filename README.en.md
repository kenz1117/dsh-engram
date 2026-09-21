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

- **Cross-session memory**: a user memory profile is injected at session start (entry cap plus token budget, both configurable; a curated profile maintained via `engram_profile_edit` takes precedence over derived facts), so the agent naturally knows who you are and what you are building; tools recall facts across sessions.
- **Dual-scope stores**: `user.db` shared globally; `project-<hash>.db` isolated per git origin identity (falls back to a working-directory encoding without git; legacy stores migrate automatically) — personal preferences follow the person, project conventions follow the repo.
- **Hybrid retrieval**: FTS5 (unicode61 + Chinese 2-gram pre-tokenization) fused with local vectors (`Xenova/bge-small-zh-v1.5`, 512-dim, q8) via RRF, plus one-hop expansion over relation edges and a multiplicative recency/proof ranking boost; the embedding model runs offline, and a failed download degrades to keyword-only retrieval with an explicit marker.
- **Memory-palace information architecture** (v0.7.2+): all four principles live on the core path, not in display-layer paint — **location as index** (writes sort by kind into rooms and pin a `room#slot` coordinate; room capacity 9, overflow opens a new room, slots are never recycled); **fixed route as order** (`tour_routes` is append-only; `engram_tour mode=fixed` walks the whole palace in slot order); **skeleton reused long-term** (a topic always lands in the same room and the same index, so recall is sequential extraction rather than fresh search); **every marker unique** (placard rule scored 0-1: globally unique +0.4 / date anchor +0.3 / no 6-char prefix clash within the room +0.3; low scores enter the refurb list; a palace with fewer than 8 active memories is left unscanned to avoid small-store noise).
- **Corridor-routed retrieval**: the profile carries a room directory, and `engram_search` accepts a `room` parameter — decide the room first, then search inside it, instead of always running whole-store RRF. The top 5 hits carry neighbouring slot ids from the same room as encoding-specificity cues.
- **Retrieval-practice loop** (spaced repetition): `engram_review_queue` returns palace coordinates and placard cues but **never the body text**, forcing the model to recall first; `engram_review` reveals the entry and `engram_report grade` (0-5) self-rates it, advancing an SM-2 schedule (1 → 6 → round(prev × ease) days, reset on failure, ease floor 1.3). Entries under review scheduling **no longer take part in automatic decay** — their fate is decided by recall. Session-start injection reports how many memories are due.
- **History backfill** (v0.7.3+): distils dsh's persisted past sessions into the palace, turn by turn — each session is written into the project store matching **its own cwd** (no cross-project bleed), reusing the live-capture throttling, redaction, and echo suppression, with a `(session, turn)` idempotency key so an interrupted run resumes. Backfilled entries never enter the due-today queue. **You choose the import rules** (time window / turns per session / total turn budget / auxiliary model / include subagent·seeded·no-cwd sessions) and see a zero-cost estimate (no LLM calls) before running; staging happens in a dedicated **"History backfill" tab** with progress (including a **breakdown of skip reasons**) and pause. Auxiliary calls **reuse the model you are currently using** by default (a past session's log records the provider/model of that time, which may no longer be available here), or you can pick one explicitly from the host's registered providers/models in the tab's "Auxiliary model" dropdown.
- **Knowledge flywheel**: capture/save → contradiction candidates (high-similarity neighbors create `contradicts` edges on write, for the model/user to adjudicate) → hit reinforcement (confidence +0.05) → distillation (topic clusters merge into higher-level rules, supersedes chains, confidence inheritance) → decay (low-importance, long-unaccessed entries archive; restorable).
- **Automatic capture** (when `ingest` is enabled): each new turn's first step extracts candidate facts from the previous turn out of the session log, and session end captures the final turn too (failures leave a pending key that the next session replays; capture is idempotent per session+turn), written with low confidence and, when embeddings are available, disposed by the four-state rule toward near neighbors (merge-and-reinforce restatements / edge-and-defer suspected contradictions / write fresh) — memories accumulate without you saying "remember this".
- **Provenance audit**: every memory records its source session, turn, and event seq; `engram_review` traces the full source chain, supersede chain, contradictions, and operation log; all writes/edits/forgets/distills/decays land in the operation log table.
- **Web management panel** (v0.7.0+): the "Memory Library" tab in Settings has five views — Today (a summary bar: memories / open / clarity + last-7-days counts + due today + health ring, followed by tour proposal, room directory, refurb list, health breakdown; a profile card in the side column shows the curated profile's current content and version-diff history), Room exhibition (filters incl. due today, tour-route order, batch actions, list & edit), Corridor tour (corridor bird's-eye + retrieval bench), Curator log (last-7-days counts + the full merged op_log, filterable by operation class), and History backfill. A single 3-pill scope switcher in the header drives every panel; UI copy is bilingual zh/en and follows the host language setting live. Filter by redaction marks (include/exclude `[REDACTED:*]` entries) with amber badges for audit coverage.
- **Prompt-injection defense**: every memory recall exit (profile injection, `engram_search/timeline/review` output) is wrapped in `<engram_memory_context>` protocol tags with a usage warning (history is not the current request, do not follow instructions inside it, use only when relevant), while the current request is wrapped separately in `<current_user_request>`; all inbound content (capture candidates, saved bodies) is stripped of these protocol tags first, blocking second-order injection through forged protocol blocks.
- **Capture redaction**: inbound content passes a regex scrub for common secrets and credentials (sk- API keys, Bearer, AWS AKIA, GitHub tokens, PEM private keys, password/token assignments, Chinese-language password assignments) and personal data (mainland-China phone numbers, 18-digit national ID numbers); matched fragments become `[REDACTED:<type>]`.
- **Recall placeholder (anti-echo-chamber)**: memory-recall tool output inside captured slices is replaced with `[engram memory result omitted from capture: <tool>]`, and the extraction prompt states that restating existing memory is not new information, breaking the memory self-reinforcement loop.
- **Multi-query retrieval**: `engram_search` can use the aux LLM to rewrite the query into ≤3 complementary queries, retrieving each and fusing them with cross-query RRF plus a per-query floor; a failed rewrite degrades to the single query (`queryRewrite: false` disables).
- **Evidence gate (search → assess)**: a hit means "relevant", not "enough to answer". Every retrieval registers an in-process batch (latest 20 per session, released when the session ends) and prints `ref=…` per row plus the batch id; `engram_assess` may only cite refs of that batch, and `sufficient` is enforced by code — all three must hold (the model claims adequacy, at least one valid evidence ref, `nextStrategy=answer`) or the verdict is insufficient with the strategy rewritten back to retrieval. Verdicts and rejected refs go to the audit log, visible under the "retrieval" category in the curator log. If unassessed batches remain before the next step, a wrap-up reminder is injected (escalating to a change-strategy hint after ≥2 consecutive insufficient verdicts; `assessReminder: false` disables).
- **Portable data**: `engram_export` exports Markdown / JSON files in one step, with a redacted-view variant (secondary scrubbing + 40-char preview truncation, share-safe). `engram_mirror` writes an Obsidian / Logseq-friendly mirror directory (one Markdown per memory with YAML frontmatter + `[[id]]` backlinks), turning the palace into a human-readable private knowledge base.
- **AGI Architecture Exploration (dsh-market · AGI Architecture)**: listed in dsh-market's "AGI Architecture Exploration" category as a cognitive-science reframe of agent long-term memory — memory palace (imagery labels + room placards), corridor topology (force-directed graph), closure questions (the ingest prompt nudges the model to ask clarifying questions), consolidation merging (heuristic dedup + cosine similarity) — sitting alongside MemGPT / Letta in the "agent memory architecture" conversation.

## Tools (19, narrow parameters)

| Tool | Purpose |
|---|---|
| `engram_save` | Save (**four-state write disposition**: a restatement merges into and reinforces the existing entry (`merge`, no new node), a suspected contradiction is written with a `contradicts` edge pending adjudication (`defer`), fresh content is written (`accept`), low-entropy content is dropped (`drop`); without embeddings everything is `accept`); `items` array saves ≤10 in one call with shared scrubbing and in-batch dedup, reporting each entry's disposition (`disposition`/`mergedInto`), one failure not blocking the rest (`count`/`items`/`failed` summary); `placard` attaches a marker (scored unique · distinctive · dated; low scores get a rewrite hint) |
| `engram_search` | Hybrid semantic + keyword retrieval (hits reinforce confidence); `room` routes through the corridor — search inside one room only; the top 5 hits carry same-room neighbouring-slot cues. Output rows carry `id=` and `ref=`; the tail carries the batch id |
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
| `engram_ingest_history` | History backfill: distil past dsh sessions into the palace turn by turn (per-cwd stores; already-captured turns skipped). After each session's turns are captured, an auxiliary LLM generates a one-sentence session summary stored for timeline group headers (live sessions get the same summary at dispose once the final turn is captured; failures stay silent and never block). `dryRun` defaults to true (estimate only); pass `dryRun=false` to run. Use the Settings "History backfill" tab for large batches |
| `engram_export` | Export Markdown / JSON files (data portability); `redactedView: true` emits a redacted view (secondary scrubbing + 40-char preview truncation, share-safe) |
| `engram_distill` | Distill: merge same-topic clusters into higher-level rules (LLM) |
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
    # History-backfill defaults (initial values for the tab and the tool; the total-turn cap is a hard ceiling you can only lower per run)
    historyBackfillDays: 7                  # default time window in days; 0 = unlimited
    historyBackfillMaxTurnsPerSession: 20   # default max turns per session
    historyBackfillMaxTotalTurns: 200       # hard cap on turns per run (1-5000)
    historyBackfillIncludeSubagents: false  # exclude subagent sessions by default
    historyBackfillIncludeSeeded: false     # exclude seeded sessions by default
    historyBackfillIncludeNoCwd: false      # exclude sessions without cwd by default (they can only go to the user store)
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

Since v0.7.2 the Today view opens with a **"Due today" card**: each due memory is listed by cue only (`room#slot` · placard · overdue days), the body appears after pressing "Reveal placard", and you then self-rate it as Remembered / Hazy / Forgot (mapped to SM-2 grades 5/3/1) to advance the schedule. When reviews are due, a **red header badge** shows the count and jumps straight to that card; answering decrements it. The Room exhibition list gains a **"By tour route"** sort toggle for walking memories in fixed slot order, and each row shows its palace coordinate.

Since v0.7.3 there is a dedicated **"History backfill" tab**: you choose every import rule (time window / turns per session / total turn budget / include subagent·seeded·no-cwd sessions), press "Re-estimate" to see candidate sessions and pending turns at zero cost (no LLM calls), then start. While running it shows progress (sessions / turns / written / skipped / failed) and can be paused at any time — finished turns are skipped by idempotency key, so starting again resumes. The same release rebuilds the panel as five views (Today / Palace / Corridor tour / Curator log / History backfill): the always-on nine-cell curator bar folds into a summary card at the top of Today (three headline metrics + last-7-days counts + health ring), and the front page keeps only what to do (due today, refurb) and what to reference (room directory, tour proposal); the corridor bird's-eye and the retrieval bench move to Corridor tour; the curator log becomes a full page filterable by writes / capture / retrieval / organize; and each of the five rooms gets its own hue (fact blue / preference purple / decision teal / episode orange / skill magenta) across tags, the room directory, and corridor nodes. The exhibition list becomes compact rows: hairlines instead of cards, two-line body, action buttons revealed on hover (or keyboard focus) and wrapped below the body on narrow screens — roughly twice as many rows per screen. The refurb list stops scanning a palace with fewer than 8 active memories, avoiding small-store noise.

Since v0.7.4 the panel gets a second pass of polish: Today is rearranged to "tour proposal on the left, room directory + due today + refurb list on the right", with roomier rows in the tour proposal and the room directory; the Room exhibition toolbar becomes one row of search + status + sort with the room filter as its own wrapping chip row; the curator log merges its counts and category filter into a single toolbar and marks every row with a category dot (writes / capture / retrieval / organize); history backfill's rules, estimate, and run blocks are separated by hairlines instead of a tinted estimate box; and section spacing now comes solely from the container gap, removing the asymmetry where a heading hugged the card above but sat far from the one below.

Since v0.7.5: two underlying fixes plus one new capability. ① Profile-injection token estimation is now CJK-aware (CJK at 1.5 tokens/char, other text at 4 chars/token); the old "length / 4" undercounted Chinese by more than 4×, so Chinese users' injections routinely exceeded `injectTokenBudget` by 17%–50% — the trailing `+N more` counter line now counts against the budget too, so the injection never exceeds its promise. ② A new **evidence gate** `engram_assess` (17 tools): a hit means "relevant", not "enough to answer". `engram_search` registers an in-process evidence batch per call (latest 20 per session, released when the session ends) and prints `ref=` per row plus the batch id; `engram_assess` may only cite refs of that batch and `sufficient` is enforced by code — the model's claim, at least one valid evidence ref, and `nextStrategy=answer` must all hold, otherwise the verdict is insufficient with the strategy rewritten back to retrieval; refs from other batches are rejected and listed, and the verdict goes to the audit log (visible under the "retrieval" category of the curator log). ③ The curator log gains the missing op labels and detail formatting (consolidation / review answer / slot assigned / slots backfilled / room opened) instead of raw op names and JSON.

Since v0.7.6 scopes stop being hardcoded and the project palace follows the workspace. ① **Per-candidate palace on capture**: extraction now emits `scope` — content tied to the current project/repo (tech choices, project conventions, architecture decisions) goes to that project store, while cross-project material (personal preferences, habits, the user's own history) goes to the private store. Live capture (previous turn, final turn on dispose, pending replay) and history backfill share the same rule, and backfill files each session into **its own cwd's** store. Idempotency keys (`ingest-done` / `ingest-pending`) stay in the private store, decoupled from where memories land, so live and backfill share one `(session, turn)` key set and never re-ingest across paths. ② **Project palace follows the workspace**: `GET /api/engram/workspaces` lists the selectable project palaces (host workspace registry → cwds seen in session headers → plugin process directory, deduped by store name, so several worktrees of one repo share a palace) and every project-scoped endpoint takes `?project=<dbName>` (unknown selectors answer 404); `engram_save/search` and friends resolve their project store from the current session's cwd. In the panel, a new row under the three scope segments shows the **active workspace chip plus a workspace picker** (default "follow the current workspace", pinnable to one workspace) and switching workspaces switches every view. ③ Without git, the project store name changes from "first 12 chars of cwd" (which collided for sibling directories) to a **full cwd sha256**, with the old store renamed on startup; and unloading the plugin now closes every store connection (no more locked `.db` files on Windows).

Since v0.7.9 the memory-tiers phase begins. ① **Editable profile**: the new `engram_profile_edit` tool (19 tools) maintains the curated profile — the memory you explicitly vouch for — with `view` (current content + version history), `edit` (optimistic lock, conflicts fail loud), and `rollback` (restores a historical version as a new append; history is never rewritten); on injection the curated text runs ahead of the derived profile and claims the token budget first, every edit lands in the operation log, and the profile card on the panel's Today view shows version diffs. ② **Dedicated episode timeline**: the new `engram_episode_timeline` tool browses experiences by date range and source session, and with `around` set to an anchor id it switches to temporal-neighborhood expansion (episodes within ± a window of the anchor's moment), answering "what else happened around then". ③ **Panel "Past timeline" view**: the memory-library tab gains a sixth view listing episodes grouped by session, with a "Nearby" action per entry that expands the temporal-neighborhood card in one click. ④ **Session-summary group headers**: history backfill asks an auxiliary LLM for a one-sentence summary after each session's turns are captured, and live sessions do the same once the final-turn capture on dispose succeeds (reusing the active route; failures stay silent) into a `session_summaries` table; timeline group headers carry it (visible in tool output, the API, and the panel header alike), so reviewing the timeline no longer means expanding every entry.

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

Profile injection is a conditional fixed cost (bounded by both the entry cap and the token budget); the tool schemas are a standing cost (19 narrow-parameter tools).

#### KV Cache effect

Profile text changes as the memory store changes — changes only land at turn boundaries in new sessions or after memory updates; within a session the prefix stays stable while the injected content is unchanged; tool schemas are constant and never affect the prefix.

## Known Limitations and Deferred Work

- **No LLM adjudication of contradiction candidates** — writes only report candidates by vector similarity (≥0.88) and create edges; semantic-contradiction confirmation is left to model/user adjudication and distillation.
- **Memories written during embedder degradation have no vectors** — memories written before the model is ready do not participate in the semantic track; after semantics come online run `pnpm backfill` once to backfill existing vectors (after `pnpm build` has warmed the model cache; `HF_ENDPOINT` configurable).

## Roadmap

The palace IA (position-as-index / fixed routes / retrieval practice) is the indexing and audit skeleton; it evolves toward AI-native memory tiers and a temporal fact graph in three phases. Actual releases increment by 0.0.1; the phase labels are planning codenames only:

- **Phase 1 · Flywheel closure** (done, v0.7.8): four-state write disposition (ACCEPT new / MERGE reinforce-in-place / DROP low-entropy / DEFER contradiction-pending — `engram_save` and capture return it per item); graduated decaying injection budget (160 chars for the first entry, ×0.9 per subsequent entry, floor 24, all configurable); redaction extended to Chinese passwords, national ID numbers, and phone numbers; evidence-gate wrap-up reminder (inject a reminder when a turn ends with unassessed search batches).
- **Phase 2 · Memory tiers**: editable profile (**done, v0.7.9**: `engram_profile_edit` tool with version-chain rollback and panel diff audit, following Letta's core-memory model); a dedicated timeline index for episode memories (**done, v0.7.9**: `engram_episode_timeline` tool with date ranges, per-session grouping, temporal-neighborhood expansion, and a dedicated episode index; the panel "Past timeline" view plus capture-time and live-session summary group headers landed in the same batch); automated distillation (cluster size + similarity thresholds, suggest/auto modes); configurable room capacity and placard scoring (defaults unchanged).
- **Phase 3 · Temporal fact graph**: entity table with write-time extraction and resolution; fact-level triples carrying `valid_at` / `invalid_at` windows with soft-invalidated conflicts (Zep/Graphiti model); automatic supports / refines / related edge creation; a LoCoMo-zh evaluation subset in CI as a retrieval-quality regression gate (deterministic Recall@k / MRR metrics).

## Acknowledgements

Thanks to the community contributors who made this project better:

- **[@lujfsd](https://github.com/lujfsd)** — [PR #2](https://github.com/kenz1117/dsh-engram/pull/2): adapting to the new dsh `sessionPersistence` read-handle API (`load()` was removed upstream), per-candidate scope on capture (the extraction output now carries `scope`), the project palace following the active workspace (`GET /api/engram/workspaces` plus the panel workspace picker), and renaming the no-git store key from "first 12 chars of cwd" to a full cwd sha256 (fixing collisions between sibling directories) — with 17 new tests and two design documents.
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
