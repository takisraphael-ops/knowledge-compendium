# Knowledge Compendium

A static mind map of study notes. The map reads branch files at runtime, so a new set of notes is a new JSON file plus one line in the catalog. Notes that will be published are encrypted at rest. The browser asks for a passphrase, derives a key with PBKDF2, and decrypts with AES-GCM. Plaintext never leaves the machine.

This deployment publishes the owner's notes **encrypted** in `data/`. Without the passphrase the files are unreadable ciphertext. (The original fictional sample and its `open-sesame` passphrase were removed.)

## Run the sample

From this directory:

```bash
python3 -m http.server 8734
```

Open `http://127.0.0.1:8734`. The page must be served over HTTP. Opening the HTML file directly cannot fetch the catalog. Unlock with your passphrase.

Drag to pan, scroll or pinch to zoom. Click a topic to open it and, when it has children, to expand or collapse that branch. Double-click expands the whole branch. **Expand all** and **Collapse all** sit at the lower left.

## How a catalog is laid out

```
data/index.json              public catalog: KDF salt, iteration count, branch file names
data/<branch>.enc.json       AES-GCM ciphertext of one branch file
sample-data/*.json           plaintext sample (safe to commit)
private/*.json               your real plaintext (gitignored — do not commit)
```

`data/index.json` lists branch files. It does not contain note text. Each branch file is either a `{ "nodes": [ ... ] }` object or a bare array. Every node has:

| Field | Meaning |
| --- | --- |
| `id` | Stable id. The map root is `root`. |
| `title` | Label on the map. |
| `parentId` | Parent id, or `null` for the root. A branch file may parent its top node at `root`, which lives in `tree.json`. |
| `summary` | Short text in the side panel. |
| `text` | Full notes. See the markup below. |
| `docs` | Source-document codes, used by the filter chips. |
| `tags` | Free tags. `placeholder` marks a branch that is only a link so far. |
| `link`, `linkLabel` | Optional external link shown in the panel. |

`tools/encrypt` writes `tree.json` first, then the other files in alphabetical order. Children of a shared parent keep that order.

### Note markup

`text` is rendered only when **More depth** is opened.

- A line `@@ Source name` starts a labelled source block. Use one per document when a topic merges several sources.
- `### Heading` and `#### Heading` become subheadings.
- Lines starting with `- `, `* `, or `• ` become bullets.
- Lines starting with `1. ` become a numbered list.
- A run of `| cell | cell |` rows becomes a table. The first row is the header. A `| --- |` separator row is ignored.
- Other non-empty lines are paragraphs.
- `**bold**`, `` `code` ``, and `http` links are recognised inside a line.

Known source codes and the names shown on chips:

| Code | Name |
| --- | --- |
| CS | Computer Security |
| CT | CompTIA notes |
| GC | Google Cybersecurity Certificate |
| CY | Cyberstudy notebook |
| NM | cybersecurity-nomenclature-additions |
| GG | GCC glossary |
| G1 | GCC Course 1 glossary |
| ME | Added in the compendium |

Any other code is shown as itself. Add a name in `DOC_NAMES` inside `js/model.js` if you want a label.

## Add or update notes

1. Keep the real plaintext **outside git**, in `private/` (already ignored):

```bash
mkdir -p private
# copy your branch files in, for example:
#   private/tree.json
#   private/cybersecurity.json
```

`tree.json` holds the root and any top-level branches. Each subject is its own file, with the same node shape as `sample-data/galley.json`. The file name becomes the branch id (`cybersecurity.json` → branch `cybersecurity`).

2. To add a branch later, drop another plaintext file in that directory and encrypt again. You do not edit the page.

3. Encrypt. The tool prompts twice and does not put the passphrase on the command line. A non-interactive run can use the environment (avoid shell history if that matters to you):

```bash
node tools/encrypt --input private --output data
```

```bash
KC_PASSPHRASE='a long passphrase' node tools/encrypt --input private --output data
```

What that does:

- PBKDF2-SHA-256, 600,000 iterations, 16-byte salt, AES-256-GCM, 12-byte IV per file.
- The branch id is bound as additional authenticated data, so one file cannot be swapped onto another's name.
- The same Web Crypto calls run in Node and in the browser.
- Re-running reuses the salt and iteration count already in `data/index.json`, so an unlock remembered in the browser keeps working. `--fresh-salt` rotates the salt and forces every file to be rewritten.
- Each file is decrypted in memory before it is written. Plaintext is not copied into `data/`.
- Stale `*.enc.json` files in the output directory are removed.

Check the round trip, the renderer, layout, and merge tool:

```bash
node tools/selftest.mjs
```

If `private/tree.json` and `private/cybersecurity.json` are present, the self-test also lays out that corpus and renders its notes. It prints counts only.

## Editing on the site

Edits are an overlay in this browser. They do not change the encrypted files until you merge them yourself.

- **Edit** changes the title, summary, notes, sources, and tags.
- **Add subtopic** creates a topic under the one you are reading.
- **Move** picks a new parent. A topic cannot be moved under itself.
- **Delete** removes that topic and its subtopics from the map.

The overlay is encrypted with the same key and stored in `localStorage`. **Export edits** downloads `compendium-edits-YYYY-MM-DD.json` and copies it. That file is plaintext on purpose, so you can merge it. It contains whatever note text you changed. **Import edits** replaces the overlay on this device. **Discard edits** deletes it.

**Remember the unlock on this device** stores the derived key, not the passphrase, in `localStorage`. Anyone who can read that browser profile can decrypt the notes. Leave it off on a shared computer. **Lock** hides the map until the passphrase (or the saved key) is used again. **Forget this device** deletes the saved key.

## Merge edits back into the master files

After exporting:

```bash
python3 tools/merge_edits compendium-edits-2026-11-20.json private/ --dry-run
python3 tools/merge_edits compendium-edits-2026-11-20.json private/
```

A single file works too: `python3 tools/merge_edits edits.json private/cybersecurity.json`.

The tool inserts added topics into the branch file that contains the parent, applies `changed` fields, and deletes ids (including descendants of a deleted parent). Then encrypt again and, once you have reloaded the new ciphertext, discard the local overlay so those edits are not applied twice.

```bash
node tools/encrypt --input private --output data
```

Commit only `data/` (ciphertext and the catalog). Do not commit `private/` or the exported edits if they contain real notes.

## Deploy to GitHub Pages

The site is static. There is no build step.

```bash
node tools/encrypt --input private --output data
git add data/index.json data/*.enc.json
git commit -m "Update encrypted notes"
git push origin main
```

In the GitHub repository: **Settings → Pages → Build and deployment → Deploy from a branch**. Choose `main` and `/ (root)`, then save. The site is served at `https://<user>.github.io/<repo>/`. Paths are relative, so a project site works without a base-url setting. `.nojekyll` is included so GitHub Pages serves the files as they are.

The catalog and ciphertext are public. Security is the passphrase. PBKDF2 with 600,000 iterations makes a casual guess expensive and does not rescue a short or reused passphrase. Use a long one. The page sends `noindex`, and nothing in the app uploads the passphrase or the decrypted notes.

Serve the same folder with any static host. `python3 -m http.server` is enough to preview.

## Map behaviour

- Only open branches are drawn. Collapsed topics are one pill with a child count. Full note text is turned into HTML the first time **More depth** is opened.
- Search (two characters or more) opens every branch that leads to a match, highlights those topics, and dims the rest. The arrows step through matches.
- The source menu hides topics that are not that document and have no descendant from it. Ancestors stay so the path is still there.
- The heavier top-level branches are balanced to the left and right of the root and stay on that side when you expand them.

## Project layout

| Path | Role |
| --- | --- |
| `index.html`, `css/app.css`, `js/` | The site. `js/crypto.js` is shared with the encrypt tool. |
| `tools/encrypt` | Encrypt a directory of plaintext branch files. |
| `tools/merge_edits` | Fold an exported edit file into the plaintext masters. |
| `tools/selftest.mjs` | Round-trip, render, layout, and merge checks. |
| `sample-data/` | Fictional plaintext behind the committed `data/` catalog. |
