/**
 * Inline-edit client — runs IN the page, injected by the plugin in dev only.
 *
 * Alt+E toggles edit mode. Elements the compiler marked (`data-ie`) get
 * outlined; click one to edit it in place, Esc to cancel, blur or Cmd+Enter to
 * commit. On commit the location — a byte range, or an array path for text that
 * came out of a `{#each}` — goes to the dev server, which rewrites the source
 * file and lets HMR repaint.
 *
 * Five things here are load-bearing and were all found the hard way:
 *
 * - **Entry happens on `mousedown`, not `click`.** The browser computes caret
 *   position and double-click word selection as the default action of
 *   mousedown. Making the element editable in `click` meant that work had
 *   already happened against a non-editable element, and the subsequent
 *   `focus()` then collapsed the selection — so double-clicking a word
 *   selected the wrong one. Setting the attribute during mousedown (without
 *   preventDefault) lets the browser do all of it natively and correctly.
 *
 * - **`white-space` is pinned while editing.** `contenteditable="plaintext-only"`
 *   makes the UA apply `white-space: pre-wrap`, which is correct for that mode
 *   but means a text node's source indentation (`\n\t\t\t\t`) abruptly renders
 *   as real line breaks. Measured on a real paragraph: a 69px jump the instant you
 *   clicked. We normalise the text to a single line on entry instead of
 *   fighting the UA style, so pre-wrap and normal render identically.
 *
 * - **Whitespace-sensitive elements are refused.** If the page CSS gives an
 *   element a preserving `white-space` (a `<pre>`, a terminal-command block),
 *   its layout IS its content, and the server collapses text on commit — so
 *   editing it would silently destroy formatting. Checked live against
 *   computed style, since the compile-time pass cannot see CSS.
 *
 * - **Text is written through the text node, never `el.textContent`.** Svelte
 *   brackets `{@html}` output with comment anchors it uses for bookkeeping, and
 *   assigning textContent deletes them along with the text.
 *
 * - **Every listener is delegated off `document`.** A successful write triggers
 *   HMR, which destroys and re-creates the component's DOM; per-element
 *   listeners would silently die after the first edit.
 */

// Options are injected by the plugin as a global; the defaults here keep this
// file valid, runnable JavaScript on its own.
const OPTIONS = {
	hotkey: 'KeyE',
	endpoint: '/__inline-edit',
	...(globalThis.__SVELTE_INLINE_EDIT__ ?? {})
};
const ENDPOINT = OPTIONS.endpoint;
// Matched on `event.code`, not `event.key`. On macOS Option+E is the dead key
// for an acute accent, so `key` arrives as '´' (or 'Dead') and never as 'e';
// `code` is physical-key based and unaffected by the modifier or the layout.
const HOTKEY_CODE = OPTIONS.hotkey;

const PRESERVES_WS = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);

let editing = null; // { el, original }
let armed = false;

// ── eligibility ─────────────────────────────────────────────────────────────

/** Collapse a run of whitespace the same way the server will on commit. */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Whitespace-sensitive elements can't survive the server's collapse. */
const isWsSensitive = (el) => PRESERVES_WS.has(getComputedStyle(el).whiteSpace);

/**
 * `{@html …}` content is markup, so an entry could legitimately contain inline
 * tags. Editing such an element as plain text would flatten them out of the
 * source, so refuse anything that rendered a real child ELEMENT.
 *
 * Only elements count. Svelte brackets `{@html}` output with comment anchors
 * (`<!--1gk8ex2-->text<!---->`) as its own bookkeeping, and an earlier version
 * of this check treated those as markup — which silently made every `{@html}`
 * element ineligible, the exact ones worth editing.
 */
const hasChildMarkup = (el) => [...el.childNodes].some((n) => n.nodeType === Node.ELEMENT_NODE);

/**
 * The element's single text node, when it has exactly one. Writing through this
 * rather than `el.textContent` leaves Svelte's comment anchors in place —
 * assigning textContent would delete them and strand the `{@html}` block.
 */
function textNodeOf(el) {
	const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
	return texts.length === 1 ? texts[0] : null;
}

/** Set the visible text without disturbing anything else in the element. */
function setText(el, value) {
	const tn = textNodeOf(el);
	if (tn) tn.nodeValue = value;
	else el.textContent = value;
}

const isRich = (el) => el.hasAttribute('data-ie-rich');

const eligible = (el) =>
	!!el &&
	el.hasAttribute('data-ie') &&
	!isWsSensitive(el) &&
	// A rich element is *expected* to contain markup; that is the whole point.
	(isRich(el) || !hasChildMarkup(el));

/** Inline tags a rich element may contain. Must match INLINE_OK on the server. */
const INLINE_OK = new Set([
	'STRONG',
	'EM',
	'B',
	'I',
	'CODE',
	'U',
	'S',
	'SMALL',
	'SUB',
	'SUP',
	'BR',
	'ABBR',
	'KBD',
	'MARK',
	'SPAN'
]);

/** Escape what would change Svelte's parse. Mirrors `escape()` on the server. */
const esc = (s) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\{/g, '&#123;')
		.replace(/\}/g, '&#125;');

/** Attributes that exist only in the DOM and must not be written back. */
const OWN_ATTRS = new Set(['data-ie', 'data-ie-set', 'data-ie-rich', 'data-ie-skip']);

/** Svelte's CSS scoping class — `s-<hash>` in 5.x, `svelte-<hash>` before it. */
const SCOPE_CLASS = /^(?:s|svelte)-[A-Za-z0-9_-]+$/;

/**
 * True when every attribute on this element was injected rather than authored,
 * so dropping them all reproduces the source faithfully.
 *
 * Two separate injectors bite here and both look like real attributes: Svelte
 * adds its CSS scope class to any element the scoped styles target (`.body
 * strong` on this page), and THIS PLUGIN adds `data-ie` to the <strong>, since
 * a <strong> is itself a single-text-node element. The compile-time pass has
 * already guaranteed the source carries no attributes on these children — so
 * anything beyond those two came from the editor, which is what to refuse.
 */
function onlyInjectedAttrs(el) {
	for (const a of el.attributes) {
		if (OWN_ATTRS.has(a.name)) continue;
		const classes = a.value.split(/\s+/).filter(Boolean);
		if (a.name === 'class' && classes.every((c) => SCOPE_CLASS.test(c))) continue;
		return false;
	}
	return true;
}

/**
 * Rebuild Svelte markup from an edited rich element. Throws on anything it does
 * not recognise, which is the point — `contenteditable="true"` will happily
 * insert a <div> or a style attribute on paste or a formatting shortcut, and a
 * loud refusal is far better than silently writing that into the source. The
 * server re-parses whatever comes out of here before it writes.
 */
function serializeRich(node) {
	let out = '';
	for (const n of node.childNodes) {
		if (n.nodeType === Node.TEXT_NODE) out += esc(n.nodeValue);
		else if (n.nodeType === Node.COMMENT_NODE)
			continue; // Svelte's anchors
		else if (n.nodeType === Node.ELEMENT_NODE) {
			const lower = n.tagName.toLowerCase();
			if (!INLINE_OK.has(n.tagName)) throw new Error(`cannot save a <${lower}> in here`);
			if (!onlyInjectedAttrs(n))
				throw new Error(`<${lower}> picked up formatting — undo and retype it`);
			out += lower === 'br' ? '<br />' : `<${lower}>${serializeRich(n)}</${lower}>`;
		}
	}
	return out;
}

/**
 * Tag ineligible elements so CSS can leave them un-outlined. Correctness does
 * not depend on this running — mousedown re-checks live — it only keeps the
 * highlight honest. Re-run after HMR, which drops the attributes with the DOM.
 */
function rescan() {
	let ok = 0;
	for (const el of document.querySelectorAll('[data-ie]')) {
		if (!eligible(el)) el.setAttribute('data-ie-skip', '');
		else {
			el.removeAttribute('data-ie-skip');
			ok++;
		}
	}
	return ok;
}

// ── mode ────────────────────────────────────────────────────────────────────

function setArmed(on) {
	armed = on;
	document.documentElement.classList.toggle('ie-armed', on);
	// Leaving edit mode SAVES what is open rather than discarding it. Esc is the
	// way to throw an edit away, and it should be the only one — dropping work
	// because the mode was toggled is the same silent loss as the hand-off bug.
	if (!on) commit();
	toast(on ? `edit mode on — ${rescan()} editable` : 'edit mode off', 1200);
}

// ── editing ─────────────────────────────────────────────────────────────────

function begin(el, { focus = false } = {}) {
	const original = el.textContent;
	const rich = isRich(el);

	if (rich) {
		// `true` rather than `plaintext-only`, so typing around a <strong> keeps
		// it. Conveniently this mode leaves white-space at `normal`, so a rich
		// element has no reflow to avoid in the first place.
		editing = { el, original, rich, originalHtml: el.innerHTML };
		el.setAttribute('contenteditable', 'true');
	} else {
		// Normalise to one line BEFORE the element goes editable, so the switch to
		// pre-wrap has no newlines left to expand and the layout cannot jump.
		const flat = collapse(original);
		if (flat !== original) setText(el, flat);
		editing = { el, original, rich };
		el.setAttribute('contenteditable', 'plaintext-only');
	}
	el.classList.add('ie-active');
	// On mousedown entry the browser is about to focus and place the caret
	// itself; calling focus() here would collapse the selection it is building.
	if (focus) el.focus();
}

/**
 * Has the element in edit actually changed? Rich elements compare as markup,
 * since only formatting may have moved; plain ones compare collapsed, so the
 * normalisation done on entry does not read as an edit.
 */
function isDirty() {
	if (!editing) return false;
	const { el, original, rich, originalHtml } = editing;
	return rich ? el.innerHTML !== originalHtml : collapse(el.textContent) !== collapse(original);
}

function cancel() {
	if (!editing) return;
	const { el, original, rich, originalHtml } = editing;
	// A rich element has to go back as markup — restoring its text would flatten
	// the inline tags the user did not touch.
	if (rich) {
		if (el.innerHTML !== originalHtml) el.innerHTML = originalHtml;
	} else if (el.textContent !== original) setText(el, original);
	teardown();
}

function teardown() {
	if (!editing) return;
	const { el } = editing;
	el.removeAttribute('contenteditable');
	el.classList.remove('ie-active');
	el.blur();
	editing = null;
}

async function commit() {
	if (!editing) return;
	const { el, original, rich, originalHtml } = editing;
	const next = el.textContent;
	const range = el.dataset.ie;
	const richRange = el.dataset.ieRich;
	const set = el.dataset.ieSet; // "<array>:<prop>:<mode>" for array-backed text
	const file = el.__svelte_meta?.loc?.file;
	const restore = () => (rich ? (el.innerHTML = originalHtml) : setText(el, original));
	teardown();

	// `original` still holds the source's own whitespace; compare collapsed so
	// the normalisation done on entry does not read as an edit. For a rich
	// element compare the markup too, since only formatting may have moved.
	const unchanged = rich ? el.innerHTML === originalHtml : collapse(next) === collapse(original);
	if (unchanged) {
		if (!rich && el.textContent !== original) setText(el, original); // undo normalise
		return;
	}
	if (!file || (!range && !set && !richRange))
		return fail(el, original, 'lost the source location', restore);

	// Three shapes: a byte range for plain markup text, that range plus rebuilt
	// markup for prose with inline tags, or an array path for text out of a
	// {#each} — there the server finds the entry by matching oldText, so no
	// index needs to travel.
	let payload;
	if (set) {
		const parts = set.split(':');
		payload = { file, set: `${parts[0]}:${parts[1]}`, mode: parts[2] };
	} else if (richRange) {
		const [start, end] = richRange.split(':').map(Number);
		try {
			payload = { file, start, end, rich: serializeRich(el) };
		} catch (err) {
			return fail(el, original, err.message, restore);
		}
	} else {
		const [start, end] = range.split(':').map(Number);
		payload = { file, start, end };
	}
	el.classList.add('ie-pending');

	try {
		const res = await fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...payload, oldText: original, newText: next })
		});
		const body = await res.json();
		el.classList.remove('ie-pending');
		if (!res.ok || !body.ok) return fail(el, original, body.error || `HTTP ${res.status}`, restore);
		// Deliberately do NOT touch the DOM on success: HMR is about to replace
		// this subtree with the compiled result of what we just wrote, and that
		// is the only version worth trusting. Re-tag once it lands.
		toast('saved → ' + body.file.split('/').pop(), 1600);
		setTimeout(rescan, 500);
	} catch (err) {
		el.classList.remove('ie-pending');
		fail(el, original, err.message, restore);
	}
}

function fail(el, original, msg, restore) {
	// A rich element must be put back as markup, not as text — `restore` is
	// supplied by the caller, which knows which kind it was.
	if (restore) restore();
	else setText(el, original);
	el.classList.add('ie-failed');
	setTimeout(() => el.classList.remove('ie-failed'), 1500);
	toast('not saved: ' + msg, 4000, true);
}

// ── events (all delegated) ──────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
	if (e.altKey && e.code === HOTKEY_CODE) {
		e.preventDefault();
		return setArmed(!armed);
	}
	if (!editing) return;
	if (e.key === 'Escape') {
		e.preventDefault();
		cancel();
	} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		commit();
	} else if (e.key === 'Enter') {
		// A single static text node cannot hold a line break, so swallow it
		// rather than letting the editor insert a \n we would only strip.
		e.preventDefault();
	}
});

// Entry point. Capture phase so we beat any page handler, but NO preventDefault
// — the browser's default mousedown action is exactly the caret placement and
// word selection we want, and it must run against an already-editable element.
document.addEventListener(
	'mousedown',
	(e) => {
		if (!armed || e.button !== 0) return;
		const el = e.target.closest('[data-ie]');
		if (!el || el === editing?.el) return; // let native selection continue
		if (!eligible(el)) return;

		// Hand off from whatever was being edited. This has to happen here rather
		// than in `focusout`: `begin` below reassigns `editing`, and by the time
		// the browser blurs the old element its focusout guard no longer matches,
		// so the old edit was silently dropped and left mid-edit.
		if (editing) {
			const dirty = isDirty();
			commit();
			// A real edit means a file write and an HMR repaint that will replace
			// this node underneath the caret. Stop here and let the page settle —
			// entering an element that is about to be destroyed strands the user
			// typing into a detached node. Clicking again after the save works.
			if (dirty) return;
		}
		begin(el);
	},
	true
);

// Separate from entry: stop the click reaching the page while armed, since
// several editable elements live inside links and cards that would navigate.
document.addEventListener(
	'click',
	(e) => {
		if (!armed) return;
		if (e.target.closest('[data-ie]')) {
			e.preventDefault();
			e.stopPropagation();
		}
	},
	true
);

// `contenteditable="true"` pastes rich HTML by default — fonts, colours, whole
// <div> trees from another page. The serializer would refuse all of it, which is
// safe but useless; forcing plain text makes paste actually work.
document.addEventListener('paste', (e) => {
	if (!editing) return;
	e.preventDefault();
	const text = collapse(e.clipboardData?.getData('text/plain') ?? '');
	if (text) document.execCommand('insertText', false, text);
});

document.addEventListener('focusout', (e) => {
	if (editing && e.target === editing.el) commit();
});

// ── chrome ──────────────────────────────────────────────────────────────────

let toastEl;
function toast(msg, ms = 2000, bad = false) {
	if (!toastEl) {
		toastEl = document.createElement('div');
		toastEl.className = 'ie-toast';
		document.body.appendChild(toastEl);
	}
	toastEl.textContent = msg;
	toastEl.classList.toggle('ie-toast-bad', bad);
	toastEl.classList.add('ie-toast-show');
	clearTimeout(toast._t);
	toast._t = setTimeout(() => toastEl.classList.remove('ie-toast-show'), ms);
}

const style = document.createElement('style');
style.textContent = `
  /* Deliberately faint: this outlines a lot of the page at once, so the resting
     state has to stay readable. Hover is where it firms up. */
  .ie-armed [data-ie]:not([data-ie-skip]) {
    outline: 1px dashed rgba(96,165,250,.5);
    outline-offset: 2px;
    cursor: text;
  }
  .ie-armed [data-ie]:not([data-ie-skip]):hover {
    outline: 1px solid rgba(96,165,250,.8);
    background: rgba(96,165,250,.06);
  }
  [data-ie].ie-active {
    outline: 2px solid #60a5fa !important;
    background: rgba(96,165,250,.12) !important;
  }
  [data-ie].ie-pending { opacity: .55; }
  [data-ie].ie-failed  { outline: 2px solid #f87171 !important; background: rgba(248,113,113,.14) !important; }
  .ie-toast {
    position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 12px);
    z-index: 2147483647; pointer-events: none;
    background: #1e293b; color: #e2e8f0; border: 1px solid rgba(255,255,255,.14);
    border-radius: 8px; padding: .5rem .9rem;
    font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
    opacity: 0; transition: opacity .18s ease, transform .18s ease;
    max-width: 70vw; text-align: center;
  }
  .ie-toast-show { opacity: 1; transform: translate(-50%, 0); }
  .ie-toast-bad  { background: #7f1d1d; border-color: rgba(248,113,113,.5); }
`;
document.head.appendChild(style);

const total = document.querySelectorAll('[data-ie]').length;
console.info(
	`%c inline-edit %c Alt+${HOTKEY_CODE.replace(/^Key/, '')} to toggle — ${rescan()}/${total} editable text nodes on this page`,
	'background:#60a5fa;color:#0b1020;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px',
	'background:#1e293b;color:#e2e8f0;border-radius:0 3px 3px 0;padding:2px 6px'
);
