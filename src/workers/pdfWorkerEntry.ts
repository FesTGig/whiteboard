/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Both plain static imports, deliberately not a dynamic import() of
// pdf.worker.min.mjs: this worker's CSP is inherited from the page, and
// while worker-src 'self' (added by AddContentSecurityPolicyListener)
// covers *loading this worker script itself*, a dynamic import() of a
// further script from inside that worker falls under script-src-elem
// instead, which requires 'strict-dynamic'/nonce trust that a bare
// runtime import() inside a worker has no way to carry. Static imports
// don't have this problem: they're part of the same build-time module
// graph, so Rollup bundles pdf.worker.min.mjs straight into this file -
// same shape as the already-working syncWorker.ts, which has no runtime
// imports of its own either.
//
// Sibling static imports of the same module evaluate in the order
// they're written, each one fully before the next starts - so this
// import ordering is what guarantees the polyfill runs before
// pdf.worker.min.mjs's own top-level code does. See
// applyPromiseTryPolyfillOnImport.ts and promiseTryPolyfill.ts for why
// that matters.
import '../utils/applyPromiseTryPolyfillOnImport.ts'
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
