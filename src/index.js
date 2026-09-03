/**
 * vite-plugin-svelte-inline-edit
 *
 * Alt+E in the browser, click a paragraph, type. The edit is written back to
 * the .svelte file it came from. Dev only — `apply: 'serve'` means it is never
 * part of a production build.
 *
 * No agent, no CMS, no desktop app: the compiler records where each piece of
 * text lives, and the dev server splices the file. Edits are instant and
 * deterministic.
 *
 * See ./source.js for the rules about what is editable and how each kind of
 * text is escaped — that is where the subtlety lives.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyMarks,
	collapse,
	decode,
	escape,
	escapeHtmlOnly,
	findArrayLiteral,
	findEditable,
	isParseableMarkup,
	stripTags
} from './source.js';

const CLIENT_ID = 'virtual:svelte-inline-edit/client';
const RESOLVED = '\0' + CLIENT_ID;

const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * @typedef {object} InlineEditOptions
 * @property {RegExp} [include]  which files to instrument. Default `/\.svelte$/`
 * @property {boolean} [format]  run prettier on the file after writing. Default `true`
 * @property {string} [hotkey]   KeyboardEvent.code that toggles edit mode, with Alt. Default `'KeyE'`
 * @property {string} [endpoint] dev-server path for writes. Default `'/__inline-edit'`
 */

/** @param {InlineEditOptions} [options] */
export function inlineEdit(options = {}) {
	const {
		include = /\.svelte$/,
		format = true,
		hotkey = 'KeyE',
		endpoint = '/__inline-edit'
	} = options;

	let root = process.cwd();

	return {
		name: 'vite-plugin-svelte-inline-edit',
		apply: 'serve',
		enforce: 'pre', // must run before the Svelte compiler sees the file

		configResolved(config) {
			root = config.root;
		},

		resolveId(id) {
			return id === CLIENT_ID ? RESOLVED : null;
		},

		async load(id) {
			if (id !== RESOLVED) return null;
			// Options reach the client as a global it merges over its defaults, so
			// client.js stays valid, readable JavaScript on its own.
			const banner = `globalThis.__SVELTE_INLINE_EDIT__ = ${JSON.stringify({ hotkey, endpoint })};\n`;
			return banner + (await readFile(clientPath, 'utf8'));
		},

		transform(code, id) {
			// Getting the client onto the page: append a dynamic import to Vite's
			// own HMR client rather than using `transformIndexHtml`. SvelteKit
			// generates its dev HTML itself and does not route it through that hook,
			// so an injected tag never appears at all. The Vite client is always
			// present in dev and evaluated exactly once, making the import both
			// reliable and idempotent. Same mechanism vite-plugin-svelte-inspector
			// uses.
			if (/vite[\\/]dist[\\/]client[\\/]client\.mjs(?:\?|$)/.test(id)) {
				return { code: `${code}\nimport(${JSON.stringify(CLIENT_ID)});`, map: null };
			}

			const file = id.split('?')[0];
			if (!include.test(file) || file.includes('node_modules')) return null;

			let marks;
			try {
				marks = findEditable(code, file);
			} catch {
				return null; // mid-edit syntax error; let the real compiler report it
			}
			if (!marks.length) return null;
			return { code: applyMarks(code, marks), map: null };
		},

		configureServer(server) {
			// The virtual client module has no declared dependency on client.js, so
			// Vite has no reason to invalidate it when that file changes — you edit
			// the client, reload, and silently keep running the old copy.
			server.watcher.add(clientPath);
			server.watcher.on('change', (changed) => {
				if (resolve(changed) !== resolve(clientPath)) return;
				const mod = server.moduleGraph.getModuleById(RESOLVED);
				if (mod) server.moduleGraph.invalidateModule(mod);
				server.ws.send({ type: 'full-reload' });
			});

			server.middlewares.use(endpoint, async (req, res) => {
				const send = (status, body) => {
					res.statusCode = status;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify(body));
				};
				if (req.method !== 'POST') return send(405, { ok: false, error: 'POST only' });

				try {
					const chunks = [];
					for await (const c of req) chunks.push(c);
					const { file, start, end, set, mode, rich, oldText, newText } = JSON.parse(
						Buffer.concat(chunks).toString('utf8')
					);

					// Path guard: must resolve inside the project and be a .svelte file.
					const abs = resolve(root, file);
					const rel = relative(root, abs);
					if (rel.startsWith('..') || isAbsolute(rel) || !abs.endsWith('.svelte'))
						return send(400, { ok: false, error: 'path outside project' });

					const source = await readFile(abs, 'utf8');
					const flat = collapse(newText);
					const rangeOk =
						Number.isInteger(start) && Number.isInteger(end) && end <= source.length && start < end;
					let updated;

					if (set) {
						// ── array-backed: find the string literal by its content ──
						let lit;
						try {
							lit = findArrayLiteral(source, abs, set, oldText, mode);
						} catch (e) {
							return send(409, { ok: false, error: e.message });
						}
						// A JS string literal, not markup. JSON.stringify handles quoting
						// and every escape; prettier then converts it to the project's
						// quote style. In html mode the string reaches the page as markup
						// so it still needs entities; in text mode Svelte escapes on
						// render, and pre-escaping would show entities to the reader.
						const payload = mode === 'html' ? escapeHtmlOnly(flat) : flat;
						updated = source.slice(0, lit.start) + JSON.stringify(payload) + source.slice(lit.end);
					} else if (rich) {
						// ── prose with inline markup: replace the whole inner range ──
						if (!rangeOk) return send(409, { ok: false, error: 'stale offsets — reload the page' });
						const raw = source.slice(start, end);

						if (collapse(decode(stripTags(raw))) !== collapse(oldText))
							return send(409, { ok: false, error: 'source changed underneath — reload the page' });

						// `rich` is markup the client rebuilt from the DOM. Never trust it
						// blind: parse it first, so a serialisation bug fails loudly here
						// instead of writing a file that will not compile.
						const parsed = isParseableMarkup(rich, abs);
						if (parsed !== true)
							return send(422, { ok: false, error: `rebuilt markup is invalid: ${parsed}` });

						const [, lead] = raw.match(/^(\s*)/);
						const [, tail] = raw.match(/(\s*)$/);
						updated = source.slice(0, start) + lead + rich.trim() + tail + source.slice(end);
					} else {
						// ── plain markup: splice the recorded byte range ──
						if (!rangeOk) return send(409, { ok: false, error: 'stale offsets — reload the page' });
						const raw = source.slice(start, end);

						// The text being replaced must still be the text the browser was
						// showing. Compare collapsed and decoded — neither whitespace nor
						// entities survive the round trip.
						if (collapse(decode(raw)) !== collapse(oldText))
							return send(409, { ok: false, error: 'source changed underneath — reload the page' });

						// Keep the source's own indentation; prettier re-wraps the line.
						const [, lead] = raw.match(/^(\s*)/);
						const [, tail] = raw.match(/(\s*)$/);
						updated = source.slice(0, start) + lead + escape(flat) + tail + source.slice(end);
					}

					if (format) {
						try {
							const prettier = await import('prettier');
							const cfg = await prettier.resolveConfig(abs);
							updated = await prettier.format(updated, { ...cfg, filepath: abs });
						} catch {
							/* formatting is a nicety; a failure must not lose the edit */
						}
					}

					await writeFile(abs, updated, 'utf8');
					server.config.logger.info(
						`  inline-edit  ${rel}  ${hash(source)} → ${hash(updated)}  "${flat.slice(0, 60)}"`
					);
					return send(200, { ok: true, file: rel });
				} catch (err) {
					return send(500, { ok: false, error: err.message });
				}
			});
		}
	};
}

export default inlineEdit;
