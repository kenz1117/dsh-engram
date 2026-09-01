<div align="center">

# dsh-engram

<p align="center">Cross-session long-term memory for DeepSeek Harness — the agent remembers your preferences, project conventions, and factual history across sessions and projects, and keeps evolving with use (capture → reinforce → distill → decay). Pure TypeScript: no external processes, no Python dependency.</p>

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

## Features

- **Cross-session memory**: a user memory profile is injected at session start (up to 8 entries, configurable), so the agent naturally knows who you are and what you are building; tools recall facts across sessions.
- **Dual-scope stores**: `user.db` shared globally; `project-<cwd>.db` isolated per working directory — personal preferences follow the person, project conventions follow the repo.
- **Hybrid retrieval**: FTS5 (unicode61 + Chinese 2-gram pre-tokenization) fused with local vectors (`Xenova/bge-small-zh-v1.5`, 512-dim, q8) via RRF, plus one-hop expansion over relation edges; the embedding model runs offline, and a failed download degrades to keyword-only retrieval with an explicit marker.
- **Knowledge flywheel**: capture/save → contradiction candidates (high-similarity neighbors create `contradicts` edges on write, for the model/user to adjudicate) → hit reinforcement (confidence +0.05) → distillation (topic clusters merge into higher-level rules, supersedes chains, confidence inheritance) → decay (low-importance, long-unaccessed entries archive; restorable).
- **Automatic capture** (when `ingest` is enabled): each new turn's first step extracts candidate facts from the previous turn out of the session log, written with low confidence and deduplicated by embedding — memories accumulate without you saying "remember this".
- **Provenance audit**: every memory records its source session, turn, and event seq; `engram_review` traces the full source chain, supersede chain, contradictions, and operation log; all writes/edits/forgets/distills/decays land in the operation log table.
- **Web management panel**: a "Memory Library" tab in Settings — stat cards, filter by status/kind/content, inline detail and edit (through the supersede chain), forget/restore, Markdown/JSON export. UI copy is bilingual zh/en and follows the host language setting live.
- **Portable data**: `engram_export` exports Markdown / JSON files in one step.

## Tools (9, narrow parameters)

| Tool | Purpose |
|---|---|
| `engram_save` | Save (automatic contradiction-candidate detection when embeddings are available) |
| `engram_search` | Hybrid semantic + keyword retrieval (hits reinforce confidence) |
| `engram_timeline` | Timeline browsing |
| `engram_update` | Correct an entry (supersedes chain) |
| `engram_forget` | Forget (soft-delete, restorable) |
| `engram_review` | Audit one entry: source chain, supersede chain, contradictions, operation log |
| `engram_stats` | Whole-store statistics and signal ratio |
| `engram_export` | Export Markdown / JSON files (data portability) |
| `engram_distill` | Distill: merge same-topic clusters into higher-level rules (LLM) |

## Configuration

Optional configuration (cordis.yml):

```yaml
- id: dsh-engram
  name: '@kenz1117/dsh-engram'
  config:
    dbDir: '~/.dsh/engram'          # store and model-cache root directory
    injectProfile: true             # inject the user memory profile at session start
    profileTopN: 8                  # injection cap (1-64)
    modelCacheDir: '~/.dsh/engram/models'  # embedding model cache directory
    hfEndpoint: 'https://huggingface.co'   # model download endpoint; set a mirror behind restricted networks
    ingest: 'off'                   # automatic capture: off | light (user messages only, ≤2/turn) | eager (assistant messages too, ≤5/turn)
    # provider and model must be given as a pair: aux-LLM route override for capture/distill (parsed from the session log by default)
    # provider: 'deepseek'
    # model: 'deepseek-v4-flash'
    decayAfterDays: 30              # decay: last access older than this many days
    decayImportanceBelow: 0.3       # decay: and importance below this → archive (restorable)
```

## How It Works

The plugin has a host half (Node) and a browser half (React):

```
Session agent                              Host half (Node)
  │                                          │
  ├─ every turn, first step ◀─────────────── ├─ user memory profile injection (plugin-source user snapshot)
  ├─ engram_save / search / review … ──────▶ ├─ SQLite dual stores (user.db / project-<cwd>.db)
  │                                          ├─ FTS5 keyword track + local vector track, RRF fusion
  ├─ engram_distill ───────────────────────▶ ├─ aux-LLM distillation (cluster merge → supersedes chain)
  │                                          └─ automatic capture: session log → candidate facts (ingest on)
  └─ Settings "Memory Library" tab ◀──────── ─── loopback API /api/engram/* (writes verify loopback Origin)
```

- **Dual-scope stores**: `user.db` shared globally; `project-<cwd>.db` isolated per working directory.
- **Automatic capture** (when `ingest` is on): each new turn's first step extracts candidate facts from the previous turn out of the session log (the read source is the session log; aux-call request auditing goes to the plugin's own operation log — unknown events are never appended to the session log). Candidates are written with low confidence and deduplicated by embedding.
- **Provenance chain**: every memory records its source session, turn, and event seq, fully traceable via `engram_review`; the operation log table records every write/edit/forget/distill/decay.
- **Offline embeddings**: the model downloads once (q8, ~50MB; mirror endpoint configurable), then runs fully offline; on failure the plugin keeps working and retrieval degrades to keyword-only with an explicit marker.
- **UI localization**: the client half registers zh/en dictionaries through the host locale service and follows the host language setting live; data-level enums (status/kind) are mapped only in the display layer and stay English in storage.

## Web Management Panel (Settings → "Memory Library" tab)

On profiles with a webServer (web, etc.), a "Memory Library" tab appears in **Settings** automatically (registered through the `settings.section` slot; the client half is a React component loaded from `lib/client.js` through the host module table): stat cards, filter by status/kind/content, inline detail and edit (through the supersede chain), forget/restore, Markdown/JSON export. Data flows through the loopback API `/api/engram/*` (writes verify the loopback Origin). Profiles without a webServer (headless, etc.) skip the panel; every other capability is unaffected.

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

Each turn's first step appends a plugin-source user snapshot: `User memory profile (dsh-engram, cross-session):` followed by the user-scope memory list (up to 8 by default; `injectProfile: false` disables). Tool results are plain text lines (with `id=`, scope/kind annotations, contradiction-candidate hints, and degradation notes). Automatic capture and distillation each make one aux-LLM call (billed independently of the main conversation path, with purpose attribution).

#### Token effect

Profile injection is a conditional fixed cost (entries × content length); the tool schemas are a standing cost (9 narrow-parameter tools).

#### KV Cache effect

Profile text changes as the memory store changes — changes only land at turn boundaries in new sessions or after memory updates; within a session the prefix stays stable while the injected content is unchanged; tool schemas are constant and never affect the prefix.

## Known Limitations and Deferred Work

- **Last-turn blind spot in automatic capture** — capture is triggered by the next turn's first step, so a session's final turn is never captured; a session-end event hook is future work.
- **No LLM adjudication of contradiction candidates** — writes only report candidates by vector similarity (≥0.88) and create edges; semantic-contradiction confirmation is left to model/user adjudication and distillation.
- **Memories written during embedder degradation have no vectors** — memories written before the model is ready do not participate in the semantic track; after semantics come online run `pnpm backfill` once to backfill existing vectors (after `pnpm build` has warmed the model cache; `HF_ENDPOINT` configurable).

## License

[MIT](LICENSE) © 2026 KenZ (kenz1117)
