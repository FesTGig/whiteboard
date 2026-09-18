/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import logger from './logger.ts'
import { applyPromiseTryPolyfill } from './promiseTryPolyfill.ts'

/** Longer edge of a rendered page, in pixels. */
export const MAX_PAGE_DIMENSION_PX = 1600

/** JPEG quality (0-1) used when encoding a rendered page. */
export const JPEG_QUALITY = 0.85

/** Hard cap on the number of pages rendered from a single PDF. */
export const MAX_PDF_PAGES = 20

export interface PdfPageImage {
	dataURL: string
	width: number
	height: number
	pageNumber: number
}

export interface PdfToImagesResult {
	pages: PdfPageImage[]
	totalPages: number
}

/** How long to wait for the PDF worker to open the document before giving up. */
export const DOCUMENT_LOAD_TIMEOUT_MS = 20_000

/** How long to wait for the worker to tear down before giving up on cleanup. */
export const WORKER_DESTROY_TIMEOUT_MS = 5_000

/** How long to wait for a single page to render before giving up. */
export const PAGE_RENDER_TIMEOUT_MS = 15_000

/**
 * Rejects with `message` if `promise` hasn't settled within `timeoutMs`.
 * Needed because a pdf.js worker that fails during its own startup (e.g. a
 * script error) never resolves or rejects `getDocument().promise` - it just
 * hangs, leaving the caller with no way to tell the user anything went wrong.
 *
 * @param promise - The promise to race against the timeout.
 * @param timeoutMs - Timeout in milliseconds.
 * @param message - Error message to reject with if the timeout wins.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/**
 * Number of pages to actually render, given the document's total page count.
 * Pure so the 20-page cap can be tested without loading a PDF.
 *
 * @param totalPages - Number of pages in the source document.
 * @param maxPages - Hard cap on pages to render.
 */
export function getPagesToRender(totalPages: number, maxPages: number = MAX_PDF_PAGES): number {
	return Math.min(totalPages, maxPages)
}

/**
 * Scale factor to apply to a page so its longer edge is MAX_PAGE_DIMENSION_PX.
 * Pure so the dimension cap can be tested against real page dimensions without rendering.
 *
 * @param baseWidth - Page width at scale 1 (72 DPI), in points.
 * @param baseHeight - Page height at scale 1 (72 DPI), in points.
 * @param maxDimension - Target size of the longer edge, in pixels.
 */
export function getPageRenderScale(baseWidth: number, baseHeight: number, maxDimension: number = MAX_PAGE_DIMENSION_PX): number {
	return maxDimension / Math.max(baseWidth, baseHeight)
}

/**
 * Renders the pages of a PDF file to JPEG data URLs, sized so each page's
 * longer edge is MAX_PAGE_DIMENSION_PX. Renders at most MAX_PDF_PAGES pages.
 * pdfjs-dist is imported lazily so it never lands in the main bundle.
 *
 * @param file - The PDF file to render.
 * @param onProgress - Called once before rendering starts (pageNumber 0, so callers can detect truncation early) and again after each page is rendered.
 */
export async function pdfToImages(
	file: File,
	onProgress?: (pageNumber: number, pagesToRender: number, totalPages: number) => void,
): Promise<PdfToImagesResult> {
	// pdfjs-dist's main module also uses Promise.try, not just the worker -
	// see applyPromiseTryPolyfill's doc comment for the full rationale. This
	// runs on the main thread, so unlike the worker's copy it can be a
	// plain top-level call - it just has to run before the dynamic import
	// below.
	applyPromiseTryPolyfill()

	const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')

	// Our own worker entry (not pdfjs-dist's workerSrc/GlobalWorkerOptions
	// mechanism) so the Promise.try polyfill can run inside the worker
	// before pdf.worker.min.mjs's own code does - see pdfWorkerEntry.ts.
	const workerPort = new Worker(new URL('../workers/pdfWorkerEntry.ts', import.meta.url), { type: 'module' })

	// A worker that fails to load or start (blocked script, CSP violation,
	// syntax error, ...) never sends pdfjs-dist's "test"/"ready" handshake,
	// so getDocument().promise just hangs - previously surfacing only as a
	// generic timeout with no indication of what actually went wrong. These
	// fire on genuine worker-level failures (not on anything pdfjs-dist
	// itself reports through its own message protocol), so always log them,
	// and race them into the initial load so a real worker failure surfaces
	// immediately instead of waiting out the full timeout.
	const workerFailure = new Promise<never>((_resolve, reject) => {
		workerPort.onerror = (event) => {
			logger.error('[pdfToImages] PDF worker script error', event)
			reject(new Error(`PDF worker failed to start: ${event.message || 'unknown error'}`))
		}
		workerPort.onmessageerror = (event) => {
			logger.error('[pdfToImages] PDF worker message error (could not deserialize)', event)
			reject(new Error('PDF worker sent a message that could not be deserialized.'))
		}
	})
	// Nothing should ever settle this promise by resolving, only logging -
	// silence an "unhandled rejection" style warning if it's never raced.
	workerFailure.catch(() => {})

	const pdfWorker = pdfjsLib.PDFWorker.create({ port: workerPort })

	const data = new Uint8Array(await file.arrayBuffer())
	const loadingTask = pdfjsLib.getDocument({ data, worker: pdfWorker })

	try {
		const pdf = await withTimeout(
			Promise.race([loadingTask.promise, workerFailure]),
			DOCUMENT_LOAD_TIMEOUT_MS,
			'Timed out waiting for the PDF worker to open the document.',
		)
		const totalPages = pdf.numPages
		const pagesToRender = getPagesToRender(totalPages)
		const pages: PdfPageImage[] = []

		onProgress?.(0, pagesToRender, totalPages)

		for (let pageNumber = 1; pageNumber <= pagesToRender; pageNumber++) {
			const page = await pdf.getPage(pageNumber)
			try {
				const baseViewport = page.getViewport({ scale: 1 })
				const scale = getPageRenderScale(baseViewport.width, baseViewport.height)
				const viewport = page.getViewport({ scale })

				const canvas = document.createElement('canvas')
				canvas.width = Math.round(viewport.width)
				canvas.height = Math.round(viewport.height)

				await withTimeout(
					// JPEG has no transparency, so any part of the page the PDF
					// leaves uncovered would otherwise turn black instead of
					// staying page-white.
					page.render({ canvas, viewport, background: '#ffffff' }).promise,
					PAGE_RENDER_TIMEOUT_MS,
					`Timed out rendering page ${pageNumber}.`,
				)

				pages.push({
					dataURL: canvas.toDataURL('image/jpeg', JPEG_QUALITY),
					width: canvas.width,
					height: canvas.height,
					pageNumber,
				})
			} finally {
				page.cleanup()
			}

			onProgress?.(pageNumber, pagesToRender, totalPages)
		}

		return { pages, totalPages }
	} finally {
		// destroy() awaits the same internal setup chain as loadingTask.promise,
		// so a worker stuck in the failure mode above would hang here too -
		// bound it as well, and never let cleanup mask the real result/error.
		try {
			await withTimeout(loadingTask.destroy(), WORKER_DESTROY_TIMEOUT_MS, 'Timed out destroying the PDF worker.')
		} catch (error) {
			logger.warn('[pdfToImages] Failed to cleanly destroy the PDF loading task', error)
		}
	}
}
