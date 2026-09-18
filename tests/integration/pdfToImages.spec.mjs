/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { getPageRenderScale, getPagesToRender, MAX_PAGE_DIMENSION_PX, MAX_PDF_PAGES, withTimeout } from '../../src/utils/pdfToImages.ts'

// Hand-built minimal PDF, two 300x150pt pages, no fonts/content streams needed.
const fixturePath = fileURLToPath(new URL('./fixtures/two-page.pdf', import.meta.url))

describe('getPagesToRender', () => {
	it('renders every page when the document is under the cap', () => {
		expect(getPagesToRender(2)).toBe(2)
	})

	it('caps at MAX_PDF_PAGES when the document has more pages', () => {
		expect(getPagesToRender(45)).toBe(MAX_PDF_PAGES)
	})

	it('respects a custom cap', () => {
		expect(getPagesToRender(10, 5)).toBe(5)
	})
})

describe('getPageRenderScale', () => {
	it('scales a landscape page so its width becomes MAX_PAGE_DIMENSION_PX', () => {
		expect(getPageRenderScale(300, 150)).toBeCloseTo(MAX_PAGE_DIMENSION_PX / 300)
	})

	it('scales a portrait page so its height becomes MAX_PAGE_DIMENSION_PX', () => {
		expect(getPageRenderScale(150, 300)).toBeCloseTo(MAX_PAGE_DIMENSION_PX / 300)
	})

	it('respects a custom max dimension', () => {
		expect(getPageRenderScale(100, 200, 1000)).toBeCloseTo(5)
	})
})

describe('getPageRenderScale against a real PDF', () => {
	it('produces a longer edge of exactly MAX_PAGE_DIMENSION_PX for every page of the fixture', async () => {
		const data = new Uint8Array(readFileSync(fixturePath))
		const loadingTask = pdfjsLib.getDocument({ data })

		try {
			const pdf = await loadingTask.promise
			expect(pdf.numPages).toBe(2)

			for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
				const page = await pdf.getPage(pageNumber)
				const baseViewport = page.getViewport({ scale: 1 })
				const scale = getPageRenderScale(baseViewport.width, baseViewport.height)
				const longerEdge = Math.max(baseViewport.width, baseViewport.height) * scale

				expect(longerEdge).toBeCloseTo(MAX_PAGE_DIMENSION_PX)

				page.cleanup()
			}
		} finally {
			await loadingTask.destroy()
		}
	})
})

describe('withTimeout', () => {
	it('resolves with the value when the promise settles before the timeout', async () => {
		await expect(withTimeout(Promise.resolve('done'), 50, 'timed out')).resolves.toBe('done')
	})

	it('rejects with the original error when the promise rejects before the timeout', async () => {
		await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'timed out')).rejects.toThrow('boom')
	})

	it('rejects with the timeout message when the promise never settles', async () => {
		const neverSettles = new Promise(() => {})
		await expect(withTimeout(neverSettles, 10, 'timed out')).rejects.toThrow('timed out')
	})
})
