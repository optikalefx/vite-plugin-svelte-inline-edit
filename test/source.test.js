/**
 * These cover the functions where a mistake writes a broken source file: what
 * gets marked editable, how each kind of text is escaped, and — most
 * importantly — what gets REFUSED. Nearly every case here corresponds to a bug
 * that actually shipped during development.
 */

import { describe, expect, it } from 'vitest';
import {
	applyMarks,
	collapse,
	decode,
	escape,
	escapeHtmlOnly,
	findArrayLiteral,
	findEditable,
	isParseableMarkup,
	isRichProse,
	shownText,
	stripTags
} from '../src/source.js';

const FILE = 'Test.svelte';
const marks = (src) => findEditable(src, FILE);
const attrs = (src) => marks(src).map((m) => m.attr.trim());
/** The source text a mark points at, so offsets are checked not just counted. */
const marked = (src) =>
	marks(src)
		.map((m) => m.attr.match(/data-ie(?:-rich)?="(\d+):(\d+)"/))
		.filter(Boolean)
		.map(([, a, b]) => src.slice(+a, +b));

describe('escaping', () => {
	it('escapes braces, which would otherwise open a Svelte expression', () => {
		expect(escape('a {b} c')).toBe('a &#123;b&#125; c');
	});

	it('escapes & before the rules that introduce more &', () => {
		expect(escape('a & <b>')).toBe('a &amp; &lt;b&gt;');
	});

	it('leaves braces alone for {@html} strings — they are literal in JS', () => {
		expect(escapeHtmlOnly('a {b} & <c>')).toBe('a {b} &amp; &lt;c&gt;');
	});

	it('round-trips through decode', () => {
		const s = 'Tom & Jerry <3 {x}';
		expect(decode(escape(s))).toBe(s);
	});

	it('collapses whitespace the way the DOM does', () => {
		expect(collapse('  a \n\t\t b  ')).toBe('a b');
	});

	it('strips tags to nothing, not to a space', () => {
		// `</strong>,` must read as `mm,` — a space here broke every rich
		// paragraph with punctuation after a tag.
		expect(collapse(stripTags('at <strong>70mm</strong>, and'))).toBe('at 70mm, and');
	});
});

describe('shownText — what the guard compares against textContent', () => {
	it('decodes named entities outside the plugin’s own list', () => {
		// `&middot;` used to be refused forever as "source changed underneath".
		expect(shownText('A board game &middot; Kickstarter coming')).toBe(
			'A board game · Kickstarter coming'
		);
		expect(shownText('&copy; 2026 &harr; &times;')).toBe('© 2026 ↔ ×');
	});

	it('decodes decimal and hex references', () => {
		expect(shownText('it&#8217;s &#x2014; done')).toBe('it’s — done');
	});

	it('decodes inside rich prose and strips tags to nothing', () => {
		expect(shownText('a &middot; <strong>b&#x2019;s</strong>, c<br>d')).toBe('a · b’s, cd');
	});

	it('keeps braces literal', () => {
		expect(shownText('a {b} &#123;c&#125;')).toBe('a {b} {c}');
	});

	it('round-trips through escape', () => {
		const s = 'Tom & Jerry <3 {x} · ©';
		expect(shownText(escape(s))).toBe(s);
	});

	it('falls back rather than throwing on markup Svelte will not parse', () => {
		expect(shownText('a < b &amp; c')).toBe('a < b & c');
	});
});

describe('findEditable — plain markup', () => {
	it('marks an element whose only child is static text', () => {
		expect(marked('<p>Hello there</p>')).toEqual(['Hello there']);
	});

	it('records the range including the source indentation', () => {
		const src = '<p>\n\t\tHello\n\t</p>';
		expect(marked(src)).toEqual(['\n\t\tHello\n\t']);
	});

	it('ignores whitespace-only text', () => {
		expect(marks('<p>   </p>')).toHaveLength(0);
	});

	it('skips elements whose text is not caret-addressable', () => {
		expect(marks('<textarea>x</textarea><title>y</title>')).toHaveLength(0);
	});

	it('does not mark an element containing an expression', () => {
		expect(marks('<p>{value}</p>')).toHaveLength(0);
	});

	it('applies marks without corrupting later offsets', () => {
		const src = '<p>one</p><p>two</p><p>three</p>';
		const out = applyMarks(src, marks(src));
		// Every stamped range must still point at its own text in the ORIGINAL.
		for (const m of out.matchAll(/data-ie="(\d+):(\d+)"/g)) {
			expect(['one', 'two', 'three']).toContain(src.slice(+m[1], +m[2]));
		}
	});
});

describe('findEditable — array-backed text', () => {
	const src = `<script>
	const items = ['a', 'b'];
	const rows = [{ title: 'T', body: 'B' }];
</script>
{#each items as item}<li>{item}</li>{/each}
{#each rows as r}<h3>{r.title}</h3><p>{@html r.body}</p>{/each}`;

	it('resolves a bare identifier to the array, with an empty property', () => {
		expect(attrs(src)).toContain('data-ie="" data-ie-set="items::text"');
	});

	it('resolves a member expression to array and property', () => {
		expect(attrs(src)).toContain('data-ie="" data-ie-set="rows:title:text"');
	});

	it('records html mode for {@html}, which escapes differently', () => {
		expect(attrs(src)).toContain('data-ie="" data-ie-set="rows:body:html"');
	});

	it('refuses an each over a non-identifier — there is no literal to splice', () => {
		const s = `{#each data.items as i}<li>{i}</li>{/each}`;
		expect(marks(s)).toHaveLength(0);
	});

	it('binds to the innermost matching each block', () => {
		const s = `{#each outer as x}{#each inner as x}<li>{x}</li>{/each}{/each}`;
		expect(attrs(s)).toContain('data-ie="" data-ie-set="inner::text"');
	});
});

describe('findEditable — prose with inline markup', () => {
	it('marks a paragraph containing a <strong>, covering the whole inner range', () => {
		const src = '<p>a <strong>b</strong> c</p>';
		expect(attrs(src).some((a) => a.includes('data-ie-rich'))).toBe(true);
		expect(marked(src)).toContain('a <strong>b</strong> c');
	});

	it('marks the <strong> itself too, so you can edit just that word', () => {
		expect(marked('<p>a <strong>b</strong> c</p>')).toContain('b');
	});

	it('does NOT treat a layout container as prose', () => {
		// The whitespace between block children is Text, so "has text and has
		// elements" is true here — the tag names are what disqualify it.
		const src = '<div>\n\t<div>a</div>\n\t<div>b</div>\n</div>';
		expect(attrs(src).some((a) => a.includes('data-ie-rich'))).toBe(false);
	});

	it('refuses prose containing an attributed inline element', () => {
		// An <a href> cannot be rebuilt from the DOM without losing attributes.
		const src = '<p>see <a href="/x">this</a> now</p>';
		expect(attrs(src).some((a) => a.includes('data-ie-rich'))).toBe(false);
	});

	it('refuses prose mixing text, markup and an expression', () => {
		const src = '<p>a <strong>b</strong> {c}</p>';
		expect(attrs(src).some((a) => a.includes('data-ie-rich'))).toBe(false);
	});

	it('isRichProse needs both text and an inline tag', () => {
		expect(isRichProse([{ type: 'Text', raw: 'only text' }])).toBe(false);
	});
});

describe('findArrayLiteral', () => {
	const src = `<script>
	const hunt = ['a red fox', 'a black bear', 'a red fox'];
	const doing = [
		{ title: 'One', text: 'The water&rsquo;s slope.' },
		{ title: 'Two', text: 'Second entry.' },
		{ title: 'Three', text: 'Fly &middot; <em>land</em>' }
	];
	const dynamic = someFn();
	const withTpl = [{ text: \`interpolated \${x}\` }];
</script>`;
	const at = (spec, old, mode) => {
		const { start, end } = findArrayLiteral(src, FILE, spec, old, mode);
		return src.slice(start, end);
	};

	it('finds a unique object property', () => {
		expect(at('doing:text', 'Second entry.', 'text')).toBe("'Second entry.'");
	});

	it('finds an entry in an array of plain strings', () => {
		expect(at('hunt:', 'a black bear', 'text')).toBe("'a black bear'");
	});

	it('decodes entities in html mode', () => {
		expect(at('doing:text', 'The water’s slope.', 'html')).toBe("'The water&rsquo;s slope.'");
	});

	it('decodes any entity, and ignores tags, in html mode', () => {
		expect(at('doing:text', 'Fly · land', 'html')).toBe("'Fly &middot; <em>land</em>'");
	});

	it('does NOT decode in text mode — {expr} renders its string verbatim', () => {
		expect(() => at('doing:text', 'The water’s slope.', 'text')).toThrow(/not in "doing"/);
	});

	it('REFUSES duplicate text rather than guessing which entry you meant', () => {
		expect(() => at('hunt:', 'a red fox', 'text')).toThrow(/2×/);
	});

	it('refuses a non-literal array', () => {
		expect(() => at('dynamic:', 'x', 'text')).toThrow(/not a literal array/);
	});

	it('refuses an unknown declaration', () => {
		expect(() => at('nope:', 'x', 'text')).toThrow(/no declaration named/);
	});

	it('skips template literals containing expressions', () => {
		expect(() => at('withTpl:text', 'interpolated 1', 'text')).toThrow(/not in "withTpl"/);
	});
});

describe('isParseableMarkup — the pre-write backstop, and its real limits', () => {
	it('accepts rebuilt inline markup', () => {
		expect(isParseableMarkup('a <strong>b</strong> c', FILE)).toBe(true);
	});

	it('rejects a mismatched closing tag', () => {
		expect(isParseableMarkup('a <strong>b</em>', FILE)).not.toBe(true);
	});

	it('rejects a stray closing tag', () => {
		expect(isParseableMarkup('a </strong> b', FILE)).not.toBe(true);
	});

	it('rejects a raw <', () => {
		expect(isParseableMarkup('a < b', FILE)).not.toBe(true);
	});

	it('rejects an unterminated brace', () => {
		expect(isParseableMarkup('a {unclosed', FILE)).not.toBe(true);
	});

	// The two below document what this guard does NOT catch, so nobody mistakes
	// it for full validation. Neither is reachable from `serializeRich`, which
	// escapes every text node and emits only balanced tags — but if that ever
	// regresses, the parse check will not save you.
	it('does NOT catch an unclosed tag — the parser auto-closes it', () => {
		expect(isParseableMarkup('a <strong>b', FILE)).toBe(true);
	});

	it('does NOT catch a balanced brace pair — it is a valid expression tag', () => {
		// So escaping braces is load-bearing, not belt-and-braces: an unescaped
		// `{b}` would sail through this guard and be written as a live expression.
		expect(isParseableMarkup('a {b} c', FILE)).toBe(true);
	});
});
