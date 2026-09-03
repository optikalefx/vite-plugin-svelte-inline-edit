import type { Plugin } from 'vite';

export interface InlineEditOptions {
	/**
	 * Which files to instrument. Default `/\.svelte$/`.
	 *
	 * Widening this is rarely useful: the plugin parses each match with the
	 * Svelte compiler, and anything that is not Svelte will simply fail to parse
	 * and be skipped.
	 */
	include?: RegExp;

	/**
	 * Run prettier on the file after writing, so a spliced line is re-wrapped to
	 * your own printWidth. Default `true`. Silently skipped if prettier is not
	 * installed — formatting never costs you the edit.
	 */
	format?: boolean;

	/**
	 * `KeyboardEvent.code` that toggles edit mode, used with Alt. Default `'KeyE'`.
	 *
	 * Matched on `code` rather than `key` because on macOS Alt+E is the dead key
	 * for an acute accent, so `key` never arrives as `'e'`.
	 */
	hotkey?: string;

	/** Dev-server path the client posts writes to. Default `'/__inline-edit'`. */
	endpoint?: string;
}

/**
 * Edit text in the browser and have it written back to your `.svelte` source.
 *
 * Dev only — the plugin sets `apply: 'serve'`, so nothing it does reaches a
 * production build.
 */
export declare function inlineEdit(options?: InlineEditOptions): Plugin;

export default inlineEdit;
