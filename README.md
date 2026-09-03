# vite-plugin-svelte-inline-edit

Edit text in the browser. It gets written back to your `.svelte` source.

No agent, no CMS, no desktop app. The Svelte compiler records where each string
lives, and the dev server splices the file. Edits are instant, deterministic,
free, and work offline.

Dev only — `apply: 'serve'` means none of this reaches a production build.

```bash
npm i -D vite-plugin-svelte-inline-edit
```

```js
// vite.config.js
import { sveltekit } from '@sveltejs/kit/vite';
import { inlineEdit } from 'vite-plugin-svelte-inline-edit';

export default {
	plugins: [inlineEdit(), sveltekit()]
};
```

Run your dev server, press **Alt+E** (⌥E on macOS). Editable text gets a dashed
outline. Click it, type, then blur or press **⌘/Ctrl+Enter** to save. **Esc**
discards.

---

## Why this exists

The Svelte ecosystem already has the read-only half — `vite-plugin-svelte-inspector`
jumps you to source, and `svelte-trace` stamps source locations for other tools
to build on. Nobody built the write-back half. The tools that do write back are
either React-only desktop apps (Onlook), route the edit through an LLM
(stagewise), or edit CMS content rather than your files (Sanity, Netlify Visual
Editor).

## What it can edit

Three shapes, decided at compile time — because at runtime these are
indistinguishable, and they need completely different writes:

```svelte
<script>
	const cards = [{ title: 'Drive it', body: 'Three vehicles…' }];
</script>

<p>Plain prose.</p>                       <!-- ① byte range in the file   -->
<p>Prose with <strong>emphasis</strong>.</p>  <!-- ② whole inner range     -->

{#each cards as c}
	<h3>{c.title}</h3>                    <!-- ③ array + property         -->
	<p>{@html c.body}</p>                 <!--   ditto, in html mode      -->
{/each}
```

**③ is the interesting one.** Text out of an `{#each}` is what blocks every
other tool in this space, and it is usually where most of the copy actually
lives — on the page this was built for, 60 of 110 editable nodes. The mark
carries the array and property but **no index**: the index is a runtime fact the
compiler cannot see, and threading it out of the each block would mean rewriting
the block. Instead the server finds the entry by matching the text being
replaced. That makes the write self-verifying, and it fails safe — if two
entries hold identical text it refuses rather than guessing.

## What it refuses, and why

Refusals are the whole game. An element that is not safely editable simply is
not outlined.

| refused                                                                   | because                                                     |
| ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `<pre>`, or anything with a preserving `white-space`                      | its layout _is_ its content, and writes collapse whitespace |
| prose containing `<a href>` or any attributed inline tag                  | the DOM cannot tell you an `onclick={…}` handler existed    |
| text from `data.items`, a function call, or a template literal with holes | there is no literal in the file to splice                   |
| two array entries with identical text                                     | ambiguous — it will not guess which one you meant           |
| anything mixing markup and an `{expression}`                              | the expression is source the DOM does not remember          |

## Options

```js
inlineEdit({
	include: /\.svelte$/, // which files to instrument
	format: true, // run prettier on the file after writing
	hotkey: 'KeyE', // KeyboardEvent.code, used with Alt
	endpoint: '/__inline-edit' // dev-server path for writes
});
```

## Limitations

Stated plainly, because they are real:

- **Svelte 5 only.** It uses the modern AST and `__svelte_meta`.
- **No mdsvex / `.md` support.** Offsets would have to map back through the
  markdown→Svelte conversion, and mdsvex emits no sourcemap. This is harder than
  the `.svelte` case, not easier.
- **Entities get normalised.** Editing text that used `&rsquo;` rewrites it to a
  literal `'`. The DOM only ever showed the decoded character, so there is
  nothing to round-trip from.
- **Whitespace is collapsed** to one line and re-wrapped by prettier. Your
  paragraph's line breaks in source are not preserved as-is.
- **Nothing is versioned.** It writes to your working tree. Use git.

## How it works

1. **`transform`** parses each `.svelte` file and stamps `data-ie` /
   `data-ie-set` / `data-ie-rich` onto elements it can safely edit. Marks are
   applied in descending offset order, since every insertion shifts what follows.
2. **The client** is injected by appending a dynamic import to Vite's own HMR
   client. `transformIndexHtml` does _not_ work here — SvelteKit generates its
   dev HTML itself and never routes it through that hook. (Same mechanism
   `vite-plugin-svelte-inspector` uses.)
3. **On commit** the location goes to a dev-server middleware, which re-reads the
   file, verifies the text being replaced still matches what the browser showed,
   splices, re-parses, formats, and writes. HMR repaints.

A few things that are load-bearing and non-obvious, all found by breaking them:

- Entry happens on **`mousedown`**, not `click` — caret placement and
  double-click word selection are the _default action_ of mousedown, so the
  element has to be editable before it runs.
- `contenteditable="plaintext-only"` makes the UA apply `white-space: pre-wrap`,
  so a text node's source indentation suddenly renders as real line breaks — a
  69px layout jump. The text is normalised to one line on entry instead.
- Svelte brackets `{@html}` output with comment anchors, so text is written
  through the text node rather than `textContent`, which would delete them.
- Svelte's CSS scope class and this plugin's own `data-ie` both appear as DOM
  attributes on elements whose source has none. Both are recognised as injected.

## Development

```bash
npm test
```

38 tests over the source-rewriting rules — what gets marked, how each kind of
text is escaped, and what gets refused. Nearly every case corresponds to a bug
that shipped during development.

## Licence

MIT
