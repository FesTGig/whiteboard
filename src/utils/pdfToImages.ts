/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

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
	const [pdfjsLib, workerModule] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
	])
	pdfjsLib.GlobalWorkerOptions.workerSrc = workerModule.default

	const data = new Uint8Array(await file.arrayBuffer())
	const loadingTask = pdfjsLib.getDocument({ data })

	try {
		const pdf = await loadingTask.promise
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

				await page.render({ canvas, viewport }).promise

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
		await loadingTask.destroy()
	}
}
