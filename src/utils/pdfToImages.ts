/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import logger from './logger.ts'

/** Longer edge of a rendered page, in pixels. */
export const MAX_PAGE_DIMENSION_PX = 2000

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
 * Pure so the 2000px cap can be tested against real page dimensions without rendering.
 *
 * @param baseWidth - Page width at scale 1 (72 DPI), in points.
 * @param baseHeight - Page height at scale 1 (72 DPI), in points.
 * @param maxDimension - Target size of the longer edge, in pixels.
 */
export function getPageRenderScale(baseWidth: number, baseHeight: number, maxDimension: number = MAX_PAGE_DIMENSION_PX): number {
	return maxDimension / Math.max(baseWidth, baseHeight)
}

/**
 * Renders the pages of a PDF file to PNG data URLs, sized so each page's
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
	// Pinned: pdfjs-dist >=4.9.155 (incl. all of 5.x/6.x, both the legacy and
	// non-legacy builds) uses Promise.try in the worker's message handler,
	// which is newer than part of Nextcloud's supported browser range (e.g.
	// Firefox <132, Safari <18.4) and crashes the worker on load with no
	// visible error. 4.9.124 is the last version before that. The legacy
	// build is still used on top of that pin for its wider DOM API coverage.
	const [pdfjsLib, workerModule] = await Promise.all([
		import('pdfjs-dist/legacy/build/pdf.mjs'),
		import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
	])
	pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default

	const data = new Uint8Array(await file.arrayBuffer())
	const loadingTask = pdfjsLib.getDocument({ data })

	try {
		const pdf = await withTimeout(
			loadingTask.promise,
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
				const canvasContext = canvas.getContext('2d')
				if (!canvasContext) {
					throw new Error(`Could not get a 2D canvas context for page ${pageNumber}.`)
				}

				await withTimeout(
					page.render({ canvasContext, viewport }).promise,
					PAGE_RENDER_TIMEOUT_MS,
					`Timed out rendering page ${pageNumber}.`,
				)

				pages.push({
					dataURL: canvas.toDataURL('image/png'),
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
