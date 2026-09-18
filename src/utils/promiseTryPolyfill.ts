/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Polyfills Promise.try if the current realm doesn't have it natively.
 * Promise.try shipped in Chrome 128, Firefox 134 and Safari/iOS Safari
 * 18.2 (MDN browser-compat-data), but part of the browser range in the
 * `@nextcloud/browserslist-config` preset is older than that (e.g. Chrome
 * 124-127, Firefox 125-133, Safari/iOS Safari 17.5-18.1). pdfjs-dist uses
 * Promise.try unconditionally in both its main module and its worker, and
 * a worker that fails during its own top-level evaluation never settles
 * getDocument().promise - it just hangs with no visible error. This runs
 * in two separate realms (main thread and worker, which don't share
 * globals), so it has to be called in both - see pdfToImages.ts and
 * pdfWorkerEntry.ts.
 */
export function applyPromiseTryPolyfill(): void {
	if (typeof Promise.try === 'function') {
		return
	}

	Promise.try = function<T, U extends unknown[]>(callbackFn: (...args: U) => T | PromiseLike<T>, ...args: U): Promise<Awaited<T>> {
		return new Promise<Awaited<T>>((resolve) => {
			resolve(callbackFn(...args) as Awaited<T> | PromiseLike<Awaited<T>>)
		})
	}
}
