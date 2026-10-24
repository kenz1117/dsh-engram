# Documents for the author

What a fork changed in `@kenz1117/dsh-engram`: multilingual support, data registries, base
maintenance. Prepared against the author's release **v0.9.3** (commit `1aa2e82`); the lift to the
current upstream version is not done yet, and the documents will be updated when it is.

| Language | Description (open in a browser) | Theses |
|---|---|---|
| Русский | [`ru/palace-description.html`](ru/palace-description.html) | [`ru/theses.md`](ru/theses.md) |
| English | [`en/palace-description.html`](en/palace-description.html) | [`en/theses.md`](en/theses.md) |
| 简体中文 | [`zh/palace-description.html`](zh/palace-description.html) | [`zh/theses.md`](zh/theses.md) |

- `palace-description.html` — one self-contained file: no network, no build step, diagrams are
  inline SVG. Reasons behind each decision, numbers from runs, commit chronology, file list.
- `theses.md` — the same argument shorter, in the form «thesis — argument — what confirms it».
- `figures/` — the same diagrams as separate SVG files, in the language of the folder.

Russian is the original. English and Chinese are translations of it, including the diagram labels.

## Translation note

Diagrams are translated, not redrawn: the labels come from the same translation as the text, so a
figure cannot disagree with the paragraph that references it. If a wording changes in the Russian
original, the en/zh files are regenerated from it, not edited by hand — see `_ops/docs-l10n/` at the
root of the working copy.
