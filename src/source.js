/**
 * Everything that reads or rewrites Svelte source, with no Vite and no fs.
 *
 * Split out from the plugin so it can be unit tested directly — these are the
 * functions where a mistake writes a broken file, and every rule in here was
 * arrived at by breaking something first.
 *
 * ## The central problem
 *
 * At runtime these two are indistinguishable — both are one element rendering
 * one text node:
 *
 *     <p>Static prose</p>              ← written in the markup
 *     <figcaption>{shot.caption}</figcaption>  ← text lives in a JS array
 *
 * The browser cannot tell them apart, and they need completely different
 * writes. So the decision is made here, at compile time, where the answer
 * actually exists, and stamped onto the element as an attribute.
 */

import { parse } from 'svelte/compiler';

/** Collapse a whitespace run, the way the DOM and the writer both do. */
export const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Decode the entities this plugin might have written, so a guard can compare
 * what the browser showed against what the file holds.
 */
export const decode = (s) =>
	s
		.replace(/&rsquo;/g, '’')
		.replace(/&lsquo;/g, '‘')
		.replace(/&ldquo;/g, '“')
		.replace(/&rdquo;/g, '”')
		.replace(/&mdash;/g, '—')
		.replace(/&ndash;/g, '–')
		.replace(/&hellip;/g, '…')
		.replace(/&nbsp;/g, ' ')
		.replace(/&#123;/g, '{')
		.replace(/&#125;/g, '}')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');

/**
 * Escape what would change Svelte's parse of MARKUP. Order matters: `&` first,
 * or the ampersands introduced by the later rules get double-escaped.
 *
 * Braces are in the list because an unescaped `{` opens a Svelte expression —
 * typing one into a paragraph would otherwise break the build.
 */
export const escape = (s) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\{/g, '&#123;')
		.replace(/\}/g, '&#125;');

/**
 * For a string that lives in JS but reaches the page as markup via `{@html …}`.
 * Braces are deliberately NOT escaped: inside a JS string literal they are just
 * characters, and once inserted as HTML they stay literal — only the three
 * markup-significant characters matter.
 */
export const escapeHtmlOnly = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Elements whose text is not something you can put a caret into. */
export const SKIP_ELEMENTS = new Set(['textarea', 'title', 'script', 'style', 'option']);

/**
 * Inline formatting tags a prose element may contain and still be editable as a
 * whole. Deliberately narrow, and paired with a no-attributes rule.
 *
 * That rule is what makes this safe rather than merely convenient. An
 * `<a href … onclick={…}>` cannot be rebuilt from the DOM — the handler is a
 * source expression the browser never sees — and a styled `<span class>` would
 * lose its class. Rather than half-restore them, any element containing an
 * attributed child is not offered for editing at all.
 */
export const INLINE_OK = new Set([
	'strong',
	'em',
	'b',
	'i',
	'code',
	'u',
	's',
	'small',
	'sub',
	'sup',
	'br',
	'abbr',
	'kbd',
	'mark',
	'span'
]);

/**
 * Is this child list prose with inline markup in it, or a layout container?
 *
 * A `<div>` full of `<div>`s trivially satisfies "has text and has elements",
 * because the whitespace between block children is Text nodes. So the
 * discriminator has to be which tags the children are, not that they exist.
 */
export function isRichProse(kids) {
	if (kids.length < 2) return false;
	let hasText = false;
	let hasInline = false;
	for (const k of kids) {
		if (k.type === 'Text') {
			if (collapse(k.raw ?? k.data ?? '').length > 0) hasText = true;
		} else if (k.type === 'RegularElement') {
			if (!INLINE_OK.has(k.name) || k.attributes.length > 0) return false;
			hasInline = true;
		} else {
			// Expressions, components, blocks and comments all carry source the DOM
			// does not remember. Refuse the element rather than lose them.
			return false;
		}
	}
	return hasText && hasInline;
}

/**
 * Find every editable element and return the attribute to stamp on each.
 *
 *   MARKUP  <p>Static prose</p>
 *           → data-ie="start:end" — a byte range in this file
 *
 *   ARRAY   {#each doing as d} … <p>{@html d.text}</p> … {/each}
 *           → data-ie-set="doing:text:html" — array, property, render mode
 *
 *   RICH    <p>text <strong>bold</strong> text</p>
 *           → data-ie-rich="start:end" — the whole inner range
 *
 * The ARRAY form deliberately carries no index. The index is a runtime fact the
 * compiler cannot see, and threading it out of an each block would mean
 * rewriting the block. It is not needed: the text being replaced identifies the
 * entry, so `findArrayLiteral` locates it by matching. That makes the write
 * self-verifying and it fails safe — duplicate text is refused, not guessed at.
 *
 * @returns {{insertAt:number, attr:string}[]} insertAt is just past the tag name
 */
export function findEditable(code, filename) {
	const ast = parse(code, { filename, modern: true });
	const found = [];
	const eachStack = [];

	/** Resolve `d.text` or `item` against the enclosing each blocks. */
	const resolveSet = (expr) => {
		const forName = (name) => {
			// Innermost matching block wins, so nested eaches behave.
			for (let i = eachStack.length - 1; i >= 0; i--) {
				const b = eachStack[i];
				if (b.context?.type === 'Identifier' && b.context.name === name) return b;
			}
			return null;
		};

		let name, prop;
		if (expr.type === 'Identifier') {
			name = expr.name;
			prop = ''; // array of plain strings: {#each hunt as item}
		} else if (
			expr.type === 'MemberExpression' &&
			!expr.computed &&
			expr.object.type === 'Identifier' &&
			expr.property.type === 'Identifier'
		) {
			name = expr.object.name;
			prop = expr.property.name;
		} else return null;

		const block = forName(name);
		// Only a bare identifier array can be found in the script; `data.items` or
		// a call expression has no literal to splice.
		if (!block || block.expression?.type !== 'Identifier') return null;
		return `${block.expression.name}:${prop}`;
	};

	const visit = (node) => {
		if (!node || typeof node !== 'object') return;
		const pushed = node.type === 'EachBlock';
		if (pushed) eachStack.push(node);

		if (node.type === 'RegularElement' && !SKIP_ELEMENTS.has(node.name)) {
			const kids = node.fragment?.nodes ?? [];
			const only = kids.length === 1 ? kids[0] : null;
			const insertAt = node.start + 1 + node.name.length;

			if (only?.type === 'Text' && collapse(only.raw ?? only.data ?? '').length > 0) {
				found.push({ insertAt, attr: ` data-ie="${only.start}:${only.end}"` });
			} else if (only?.type === 'ExpressionTag' || only?.type === 'HtmlTag') {
				const set = resolveSet(only.expression);
				// `{@html …}` content is markup, `{…}` content is plain text; they
				// need different escaping on write, so record which one it is.
				if (set) {
					const mode = only.type === 'HtmlTag' ? 'html' : 'text';
					found.push({ insertAt, attr: ` data-ie="" data-ie-set="${set}:${mode}"` });
				}
			} else if (isRichProse(kids)) {
				found.push({
					insertAt,
					attr: ` data-ie="" data-ie-rich="${kids[0].start}:${kids[kids.length - 1].end}"`
				});
			}
		}

		// Walk children generically so this keeps working across AST shape
		// changes — each/if/snippet blocks included.
		for (const key of Object.keys(node)) {
			if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue;
			const v = node[key];
			if (Array.isArray(v)) v.forEach(visit);
			else if (v && typeof v === 'object') visit(v);
		}

		if (pushed) eachStack.pop();
	};

	visit(ast.fragment);
	return found;
}

/**
 * Apply the marks from `findEditable` to the source.
 *
 * Applied in DESCENDING offset order, because every insertion shifts the
 * offsets of everything after it — going forwards silently corrupts each
 * subsequent attribute.
 */
export function applyMarks(code, marks) {
	let out = code;
	for (const m of [...marks].sort((a, b) => b.insertAt - a.insertAt)) {
		out = out.slice(0, m.insertAt) + m.attr + out.slice(m.insertAt);
	}
	return out;
}

/**
 * Locate the string literal behind e.g. `doing:text` that currently holds
 * `oldText`.
 *
 * @returns {{start:number, end:number}} byte range of the literal node
 * @throws  with a message meant to be shown to the user
 */
export function findArrayLiteral(code, filename, setSpec, oldText, mode) {
	const [arrayName, prop] = setSpec.split(':');
	const ast = parse(code, { filename, modern: true });

	let init = null;
	for (const program of [ast.instance?.content, ast.module?.content]) {
		for (const stmt of program?.body ?? []) {
			if (stmt.type !== 'VariableDeclaration') continue;
			for (const d of stmt.declarations) {
				if (d.id?.type === 'Identifier' && d.id.name === arrayName) init = d.init;
			}
		}
	}
	if (!init) throw new Error(`no declaration named "${arrayName}"`);
	if (init.type !== 'ArrayExpression')
		throw new Error(`"${arrayName}" is not a literal array — edit it in the file`);

	/** Only a plain string is spliceable; a template with holes is not. */
	const asString = (n) => {
		if (!n) return null;
		if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
		if (n.type === 'TemplateLiteral' && n.expressions.length === 0)
			return n.quasis.map((q) => q.value.cooked).join('');
		return null;
	};

	const candidates = [];
	for (const el of init.elements) {
		let valueNode = null;
		if (prop === '') {
			valueNode = el;
		} else if (el?.type === 'ObjectExpression') {
			const p = el.properties.find(
				(p) => p.type === 'Property' && (p.key?.name === prop || p.key?.value === prop)
			);
			valueNode = p?.value ?? null;
		}
		const str = asString(valueNode);
		if (str === null) continue;
		// Entities decode on the way to the DOM for markup and for `{@html}`, but
		// a plain `{expression}` renders its string verbatim — so decode only in
		// html mode or the comparison silently fails.
		const shown = mode === 'html' ? decode(str) : str;
		if (collapse(shown) === collapse(oldText))
			candidates.push({ start: valueNode.start, end: valueNode.end });
	}

	if (candidates.length === 0)
		throw new Error(`that text is not in "${arrayName}" any more — reload the page`);
	if (candidates.length > 1)
		throw new Error(
			`"${arrayName}" holds that exact text ${candidates.length}× — edit it in the file`
		);
	return candidates[0];
}

/**
 * Strip tags from a source slice to get what the browser would have shown.
 *
 * Stripped to NOTHING, not to a space: `textContent` concatenates text nodes
 * with nothing between them, so `</strong>,` reads as `mm,` in the DOM. An
 * earlier version substituted a space, and the guard built on it then rejected
 * every rich paragraph with punctuation after a tag.
 */
export const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/**
 * Does this markup parse as Svelte? A backstop against writing a file that will
 * not compile, run on markup the client rebuilt from the DOM.
 *
 * Know what it does NOT catch, or you will lean on it too hard:
 *
 *   - an unclosed tag (`a <strong>b`) — the parser auto-closes it
 *   - a balanced brace pair (`a {b} c`) — that is a valid expression tag
 *
 * The second is why escaping braces in `escape()` is load-bearing rather than
 * defensive: an unescaped `{b}` sails through here and lands in the file as a
 * live expression referencing a variable that does not exist.
 */
export function isParseableMarkup(markup, filename) {
	try {
		parse(`<div>${markup}</div>`, { filename, modern: true });
		return true;
	} catch (e) {
		return e.message ?? 'unparseable';
	}
}
