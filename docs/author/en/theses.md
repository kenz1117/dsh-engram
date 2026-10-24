# Theses for the author — what we did and why

> **Written against 0.9.3; the rebase is done.** The theses were written and verified on the
> author’s release `v0.9.3` (commit `1aa2e82`). On 23 October 2026 the branch was lifted onto his
> current version — `v0.9.8`, pull request [#36](https://github.com/kenz1117/dsh-engram/pull/36).
> What changed: Jev is assembled from the DSH provider and model (his version of that part is newer),
> and the request body is read by his `http-body` module (byte limit, 413/400), which now also covers
> our routes. The arguments below were not rolled back: how it is done changed, not what.

Why this file: the arguments for describing our work to the author are collected **as we go**, not
reconstructed at the end. What the author needs is not a changelog but the reason behind each change — otherwise
it is unclear why working code should be broken. By the time of the letter the reason is forgotten, so we write at once.

Entry format: **thesis — argument — what confirms it**. If there is no confirmation, that is stated as such.

Separation of documents: the plan — *what we are doing*; `decisions.md` — *what we chose*; this file —
*why the author needs it*. The Russian original stays Russian; the en and zh versions are its translations, made once, when we sit down to write the letter.

## 1. The model label in the database (meta): the label only, and nothing else

**Thesis.** Into the database's `meta` we put exactly one field — the model label, for example `ru-minilm-l12`.
Neither the dimension nor the write time is there.

**Argument.** This is not a formality. Without a label in the database itself there is nothing to check the rule “language
does not switch the model on a populated database” against: the language lives in the binding (`bindings`), while the model is
a property of the data, and what a particular database is populated with can only be determined from that database itself.
The reverse side of the same argument: the database must not hold data that takes no part in the work.
We do not store the dimension because it is already present in the vectors themselves and follows from the catalog by label —
a copy in `meta` would give a second source of truth that could diverge from the first. The write
time is an artefact of a one-off conversion; no rule is checked against it.

**What confirms it.** The code as written and the live database. The label is written by `writeMeta` into `meta.model_label`
when the database is opened (`stampLabelOnOpen`, `src/index.ts`) and by the repair button; the rule for choosing the label is
the same for both paths, `labelToStamp` in `src/registry/base-state.ts`. Verified on the live database on 19.10
(resolved label `ru-minilm-l12`, source `override`, problems empty) and on 23.10 on `user.db`:
`meta` holds `schema_version = 13` and `model_label = ru-minilm-l12`. The check “on a populated database
a language change does not change the model” is closed by the axes test.

**Consequence (clarified 19.10):** the label is needed precisely so that this stays one-off — a named
database model settles the question “what is this database populated with” for good. We do not design a persistent
state of “our model in one database, the Chinese one in another”: after the one-off rollout over the palace all
databases carry one model, and a divergence remains an accident that the existing dimension check
on write catches.

## 2. The completeness reference is English, not Chinese

**Thesis.** In the dictionary checks the English set becomes the reference.

**Argument.** The current check (`check-messages.mjs`) takes Chinese as its reference, which the user does not know.
English fits by design: it is declared the model of completeness, `MessageKey` is built from it,
and what is exported to the external dictionary is the English side of the pair “Chinese = English”
that the author keeps in the code. Chinese as a reference is a separate conversation with the author, it is deferred;
our translation file cannot break the author's build.

**What confirms it.** The run of 19.10: “no critical divergences” — all three languages match
pairwise, so switching the reference today yields not a single new finding.

## 3. The left column of the dictionary holds the English text from the code, not the key identifier

**Thesis.** The pair in the dictionary is `Answer {count} of {total} ⇥ (ru) Answer {count} of {total}`, not
`tool.review.answer ⇥ (ru) Answer …`.

**Argument.** The identifier is a dangling point of failure: the author will restructure ids in the code, and the dictionary
becomes unusable; besides, an id alone does not show which text answers to it. The price is accepted
deliberately: the same English text in different places gets one translation.

**What confirms it.** The decision was recorded on 19.10 (`decisions.md`).

## 4. An incomplete dictionary is safe

**Thesis.** A missing line, an extra line, a truncated or stale file breaks nothing.

**Argument.** Loading goes over the array of keys taken from the code and is applied line by line: what
is absent from the file stays English, what is absent from the array is silently skipped. Operation is guaranteed
under any incompleteness of the translation, and the translation can be fixed after installation without rebuilding the plugin.

**What confirms it.** The mechanics of `table[key] ?? EN[key]` in `messages.ts`.

## 5. A row with diverging placeholders is not applied

**Thesis.** If `{id}` is lost or renamed in the translation, the row is not taken — the English one stays.

**Argument.** A lost `{id}` will silently remove the value from the message, a renamed one will show
`{count}` to the user right in the text. For the author this is a defect with return code 1, so such
a row cannot be applied.

**What confirms it.** A check at file load that compares the placeholders of the left and right columns.

## 6. Model and languages are data (the registry), not code

**Thesis.** The model table (`registry/models.json`) and the “language → model” table
(`registry/bindings.json`) are shipped as data; the user layer is `<dbDir>/registry/bindings.json`.

**Argument.** Acceptance criterion: the difference between the author's build and ours must be expressed only
in settings. If installing our model requires editing code, the work is not done. The model label is a
short alias without a language (`ru-<model>`), because one model can serve several languages; the
language lives in the binding.

**What confirms it.** `registry/models.json`, `registry/bindings.json`, `bindingLabel()` in
`src/registry/models.ts`; a live check on 19.10 (label `ru-minilm-l12`, source `override`).

## 7. The code sets the label when the base is opened, while recompute is only a human decision

**Thesis.** The label appears in the base by itself, on opening — but only where it is not a guess
about the contents but a statement of fact: the base is empty, or its data already sits on the model we
write with. Where the data is on a foreign model or in a mismatched order, there is no label until a human
action: such a base remains visible as “no label”. Recompute of vectors never starts by itself.

**Argument.** At first we decided the opposite — “the label appears only via the ‘Confirm’ button,
one confirmation for all bases”. Live work showed the price: only the repair signed it, and every new
base lived without a label until the first click, while the card all that time honestly called it “the
base requires repair”. That is, the normal appearance of a freshly created base looked like a breakdown,
and the person went off to “fix” what was not broken. The risk for which confirmation was introduced —
the guess by vector length may be wrong if the catalog holds two models of the same dimensionality — does
not apply to the signature on opening: it is set by the `judgeBase` rule, not by a guess, and only in
safe cases. Where the guess did not match the target model, there is no signature at all. There is still
no separate “confirmed” field: the trace is the label itself, so “confirmed” is visible from the base and
requires no extra field.

**What confirms it.** The `labelToStamp` rule (`src/registry/base-state.ts`) and its test; the live
`user.db`: `meta` holds `schema_version = 13` and `model_label = ru-minilm-l12`. The reverse side is the
base `project-4bef9fa22f59c5bb943b37cd.db` (`1C-energo-eve`): it has no label, state `no-label`, action
`write-label`; the signature is not applied blindly.

## 8. Our build forces no one to recompute vectors

**Thesis.** We add a model label to the base and the rule “one base — one model”. Recompute of
vectors is not a consequence of our work but a separate personal decision of the user.

**Argument.** The model follows the language of the Memory Palace: the Chinese locale still gets the
Chinese model, the Russian one gets ours. A divergence requiring recompute arises only where the user
has already created it himself: the contents of the base from one model, the language choice from
another (the plugin's former default was the Chinese model, which is why this is possible for a user with
a non-Chinese locale and a base Chinese in content). Our change does not create such a divergence.

**What confirms it.** `resolveLanguage` (`src/i18n/language.ts`: host locale, fallback `en`) and
`registry/bindings.json` (`zh → bge-small-zh-v1.5`, `* → paraphrase-multilingual-MiniLM-L12-v2`).

**Evidence.** The converter `_ops/convert-embeddings.mjs` (offline from the cache, in batches of 16,
checkpoint by id) has already gone through the live palace: the census of 19.10 — 384 for 111/425/47/10/2
records with three vectors of 512 remaining. That is, the recompute path is not “yet to be made”, it
exists and has been verified on the live base.

## 9. The list of tables with vectors must be one, not two hardcodes

**Thesis.** The list of tables that have an `embedding` column must be read from the base schema
(or live in one declared place that both the plugin and external tools read), and not be hardcoded
separately in each of them.

**Argument.** There are two such tables now — `nodes` and `observations` — and both are hardwired into the code twice,
in different tools, independently of each other. While there are two tables and `observations` is empty,
the discrepancy is not visible. But if a third table with vectors appears, both
places will silently miss it: the recalculation tool will not recalculate it, and the plugin will not include its vectors in the voting on
dimension — that is, the new vectors end up outside both recalculation and verification. This is learned not as an
error but as silent degradation of semantic search, that is, exactly the class of failure for the sake of
which we put the model tag at all: in hindsight it is not diagnosable.

**What confirms it.** The census of 20.10 (read-only, `_ops/census-tables.mjs`) across six databases:
in all of them `schema_version` = 13 (the only row in `meta`), 19 tables, the set of tables is identical,
the `embedding` column in exactly two — `nodes` and `observations`; `observations` is empty in all six.
Code at the time of the census: `_ops/convert-embeddings.mjs` knew exactly one table, `nodes`, by a line of
SQL, with no iteration (since then the converter has been moved onto the schema registry — see thesis 10);
`repo/src/store/sqlite.ts:521–525` — the dimension is computed by `UNION ALL` of exactly two tables;
`repo/src/store/sqlite.ts:441` and the migration with key `'11'` — the `observations` table is created when
the database is opened, which is why it exists even where there was not a single observation.

**What we have already done.** Iteration over the declaration, not over names in the code: our converter walks
`registry/schema.json` to the end (thesis 10). The question to the author is therefore not "should we write
detection by schema", but a different one: **what selection criterion will he introduce if he wants to skip
service tables?** Today the selection is incidental — the vector table is the one with an `embedding` column
of type `BLOB`; if an explicit criterion appears, our side will give way to it.

## 10. A description of the data schema — something to rely on instead of guesswork

**Thesis.** The plugin needs a schema registry **as data**: a list of tables carrying the `embedding` column,
and for each of them — the column with the text from which the vector is computed, and a condition on the rows that participate.
Both our tools and the plugin itself must read this declaration rather than know tables by names
hardwired into the code. Both read it: the external converter and the plugin (`loadVectorSchema` in `src/index.ts`).

**Argument.** The author has no schema description: there is a version constant, a one-line DDL, a map of migrations
with SQL strings, row interfaces and prepared statements scattered about — and one test that lists
table names by hand. Because of this, the knowledge of "which tables carry vectors" had to be hardwired twice,
in two independent tools, and both times by hand — for the tables that existed at the moment
of the edit. There is already experience: when the second vector table appeared (`observations`), neither the dimension
census nor the reindexing tool followed it. If the author adds a third, the same thing will repeat,
and it will be learned not as an error but as silent degradation of search.

**What confirms it.** `repo/src/store/sqlite.ts:34` (`SCHEMA_VERSION = 13`), `:400–453` (DDL),
`:63–116` (MIGRATIONS), `:495` (`PRAGMA table_info` — already used, but only for
idempotency of `ALTER` during migration), `repo/tests/store.spec.ts:461–486` (table names
are listed by hand). There are only two files in `src/store/` — `interface.ts` and `sqlite.ts`.

**Important: the registry is a second source of truth.** It will rot in exactly the same way those two hardcodes rotted,
unless it has a check. The proposal is therefore not "describe the schema in full" but "declare **only
what cannot be derived**, and close it with a test against the live schema": for the current schema version every
table with an `embedding` column must have a declaration, otherwise the test fails. Then our class of
failure becomes a CI gate in his repository, that is, a check at build time rather than a guess at
runtime. This is the only thing we ask for beyond maintaining the file itself.

**What has been done — a prototype.** The file `registry/schema.json` sits next to `models.json` and
`bindings.json`, in the same form the author already uses (`formatVersion` plus a dictionary by
keys), and it goes into the publication along with them (`package.json` → `files` contains `registry/`).
It is filled from the actual `PRAGMA` of the two vector tables — `nodes` (23 fields) and `observations`
(10 fields), not from memory:

```json
{
  "formatVersion": 1,
  "schemaVersion": 13,
  "tables": {
    "nodes": {
      "role": "user",
      "properties": { "vector": { "text": "content", "where": "status = 'active'" } },
      "fields": { "id": "TEXT", "content": "TEXT", "status": "TEXT", "embedding": "BLOB", "…": "…" }
    },
    "observations": {
      "role": "user",
      "properties": { "vector": { "text": "belief", "where": null } },
      "fields": { "id": "TEXT", "belief": "TEXT", "status": "TEXT", "embedding": "BLOB", "…": "…" }
    },
    "nodes_fts": { "role": "service" },
    "nodes_fts_content": { "role": "service" },
    "nodes_fts_docsize": { "role": "service" }
  }
}
```

The first level is the table and its properties, the second is the table's fields with types. The handler walks
the structure sequentially to the end: how many records it contains, three or fifteen, does not matter to it.

**Table classification (`role`).** Every table carries a `role` attribute, by which the schema walker decides whether to process it or skip it: `user` — the table carries user vectors and takes part in the conversion; `service` — service data, not sent into processing. The service tables (in the example, the FTS shadows `nodes_fts*`) are listed in the file on purpose: they are a visible example of the walker **skipping what is marked without analysing the contents**. It does not read what lies in a service table — it sees `role: service` and moves on. `observations` meanwhile stays `role: user`, even though there is nothing to convert in it right now (in all databases it is empty): this is a separate possible situation — “the table is processable but empty” — and it is handled routinely.

**What is declared and what is derived.** Only the non-derivable is declared: two properties of a vector table — `text` (which field the text comes from) and `where` (which rows participate; `null` — all), plus the `role` classification (`user` / `service`). Everything else is read from the database itself: which tables exist, which fields they have, which of them have an `embedding`. The vector field is therefore derived, not declared: it is the only field of type `BLOB` in a table row. The `role` classification is an explicit attribute that the walker reads first: it skips `service` without looking inside.

**How this was verified on our side.** The converter `_ops/convert-embeddings.mjs` has been switched to the registry: it walks the declaration, takes the dimensionality from `models.json` (`dimensions × 4`) instead of the constant `1536`, prints a mismatch between the declaration and `PRAGMA` as the line “skipping — no fields: …”, and skips a database newer than the declared version, naming both versions. A run over six live databases is clean; on the snapshot `_ops/fixtures/before-convert-2026-10-19` the same 10 broken records are reproduced, that is, the check runs over a copy and does not touch the live database.

**Maintaining the file is the author's business.** We filled it with what we know today, and it is a prototype: only the author knows how many tables of which kinds will appear tomorrow. The request is therefore more modest than “write a registry”: accept the form and maintain the file.

**While there is no declaration for a version, we do not guess — we refuse.** The author already has a monotonic `SCHEMA_VERSION`, and the plugin refuses to open a database newer than itself (`store.schemaVersionTooNew`, `sqlite.ts:466`). The declaration is tied to the schema version by the same key: on meeting a database whose version did not match the file's `schemaVersion` — stop and name both versions rather than work blind. Our converter opens the database **bypassing the plugin**, so it performs this check itself, and the check is already in place there.

## 11. Repair apart from recompute: count up what is missing without changing the model

**Thesis.** Records without a vector are treated by a separate action (`repair`): the missing model labels are set and vectors are counted up for the rows that lack them. Neither the palace language nor the model changes in the process.

**The argument.** The state “some records have no vector” is not the same as “the database is on a different model”, and treating it with a recompute of the whole database means rewriting correct vectors for the sake of a few empty spots. The cost of an error is asymmetric: a redundant recompute is model time and one more chance to be interrupted halfway, while uncounted rows are a silent loss of search over those records. So the state has its own action, and the button in the card names it honestly. A practical check: on the live `user.db`, six records were left without a vector after consolidating observations; this shows as “needs repair”, not as “needs conversion”.

**What confirms it.** The `judgeBase` rule (state `missing-vectors` → action `repair`), the `base-label` and `base-convert` routes without a request body: what to do follows from the state of the databases, not from what the browser sent. In the log such cases show up as the line `vectors-missing`.

## 12. Dictionary reconciliation: two numbers that match prove nothing

**Thesis.** The dictionary screen shows four numbers — keys in the program, rows in the file, untranslated, without a key — and the findings are clickable. The “Create” button lays out a file with all the program's keys and empty right-hand parts, not an empty stub.

**Argument.** The number of keys and the number of rows can be brought one to one and still lose the meaning: a key
renamed, the translation left in the old place, and the new row goes out in English. That is why what stands next to
the numbers is precisely the findings: “without translation” — these rows have nothing to show, “without key” — the translation
exists, but the program no longer needs it. A row without a key cannot be silently thrown out: the very first
save would erase a translation that the program has nothing to hook onto yet. A skeleton with keys
is needed for the same reason: an empty file is indistinguishable from “nothing has been set up”,
while a file with keys immediately shows the amount of work.

**What confirms it.** `DictionaryStats` in `src/i18n/dictionary-edit.ts` (computed on every
open, not by a button), the dictionary tests: “Create” writes a file with keys; an empty cell removes
the edit instead of writing an empty string.

## 13. A Jev check failure must name its kind, not say “not specified”

**Thesis.** A failed connection check has a word for it: `HTTP`, `network`, `timeout`, `protocol`.
The full error text belongs in the tooltip, not in the line.

**Argument.** “Not specified” does not say what to fix: the key, the address, the network or the timeout. Four kinds
of failure require four different actions, and a person looking at an identical label starts
picking at random. A line with the parameters (address, model, timeout, where the key came from) answers
the question “where the check went and with what” without pressing a button: a toast lives for seconds, while the analysis comes later.

**What confirms it.** `POST /api/engram/jev-test` returns `kind` together with `elapsedMs`,
`probability`, `status`, `endpoint`, `model`, `timeoutMs`; the panel translates `kind` into a word,
and keeps the full text in the tooltip. A live check on 22.10: `{ok: true, elapsedMs: 970, probability: 0.66}`.

## 14. The trace of a failure must survive a restart

**Thesis.** A failed Jev decision and observations left without a vector are written to the operations log
(`jev-fallback`, `vectors-missing`) and read in the panel in Russian.

**Argument.** Process memory holds a ring buffer of observations, but it dies with a restart:
a day later “the memory was written by the clean rules” and “Jev was silent” are indistinguishable in the log. The same
with vectors: the cause disappears, the consequence remains — “the database requires repair”, and the person does not know
where it came from. The log answers “why” without becoming a second store: the text of a memory
is not written into it, only the kind, the question, the cause and the duration. A log error has no right
to break the writing of a memory, so it is silenced where it is written.

**What confirms it.** `auditJevFallback` in `src/write-disposition.ts` (failure on `band`
and `contradiction`), `store.audit('vectors-missing', ...)` in `src/tools/create.ts` after the merge
completes; the panel displays both lines as words (`opJevFallback`, `opVectorsMissing`).
An analysis of a live log is in chapter 11 of the description.

## What else should go in here (not formulated)

- The argument itself, “why changing the language must not switch the model on a populated database” — so far
  only the conclusion has been formulated, not the reason.
- Why the dimension of the database is taken from the majority of vectors rather than from the first/random row.
- The panel's external dictionary (`i18n/panel.<language>.txt`) — why it exists and why in the same format as
  the server one.
