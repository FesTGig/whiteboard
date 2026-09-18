/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { applyPromiseTryPolyfill } from '../utils/promiseTryPolyfill.ts'

// Must run before pdf.worker.min.mjs's own top-level code - see
// applyPromiseTryPolyfill's doc comment for why. That's also why the
// worker script below is a dynamic import rather than a static one:
// static imports are evaluated before the importing module's own
// top-level code, which would run the real worker script first and
// defeat the polyfill.
applyPromiseTryPolyfill()

// Not awaited: the dynamic import() call itself already only starts
// evaluating pdf.worker.min.mjs after the synchronous polyfill call above
// has completed, which is the only ordering guarantee needed here. Not
// awaiting also avoids top-level await, which the build target (part of
// Nextcloud's supported browser range predates ES2022) doesn't support.
// @ts-expect-error - side-effect-only script (sets up its own message
// handler on `self`), pdfjs-dist ships no type declarations for it.
void import('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
