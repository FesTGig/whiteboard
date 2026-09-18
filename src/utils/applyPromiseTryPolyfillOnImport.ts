/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Side-effect-only module: importing it runs the polyfill. Exists so
// pdfWorkerEntry.ts can order it ahead of pdf.worker.min.mjs using two
// plain static imports (sibling static imports of the same module fully
// evaluate in the order they're written, before that module's own
// top-level code runs) instead of a dynamic import() - see
// pdfWorkerEntry.ts for why a dynamic import() inside the worker was
// rejected.
import { applyPromiseTryPolyfill } from './promiseTryPolyfill.ts'

applyPromiseTryPolyfill()
