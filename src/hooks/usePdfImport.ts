/**
 * SPDX-FileCopyrightText: 2026 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileId } from '@nextcloud/excalidraw/dist/types/excalidraw/element/types'
import type { BinaryFileData, DataURL } from '@nextcloud/excalidraw/dist/types/excalidraw/types'

import { showError, showLoading, showSuccess } from '@nextcloud/dialogs'
import { convertToExcalidrawElements, viewportCoordsToSceneCoords } from '@nextcloud/excalidraw'
import { t } from '@nextcloud/l10n'
import { useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useExcalidrawStore } from '../stores/useExcalidrawStore.ts'
import { useWhiteboardConfigStore } from '../stores/useWhiteboardConfigStore.ts'
import { MAX_PDF_PAGES, pdfToImages } from '../utils/pdfToImages.ts'
import { getViewportCenterPoint, moveElementsToViewport } from '../utils/positionElementsAtViewport.ts'

/** Horizontal gap between imported pages, in scene pixels. */
const PAGE_GAP_PX = 40

function generateId(): string {
	return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}

export function usePdfImport() {
	const { excalidrawAPI } = useExcalidrawStore(useShallow((state) => ({
		excalidrawAPI: state.excalidrawAPI,
	})))
	const { isReadOnly } = useWhiteboardConfigStore(useShallow((state) => ({
		isReadOnly: state.isReadOnly,
	})))

	const importPdfFile = useCallback(async (fileName: string, data: ArrayBuffer) => {
		if (!excalidrawAPI || isReadOnly) {
			return
		}

		const toastState: { current: ReturnType<typeof showLoading> | null } = { current: null }

		try {
			const { pages } = await pdfToImages(data, (pageNumber, pagesToRender, totalPages) => {
				toastState.current?.hideToast()
				toastState.current = pageNumber === 0 && totalPages > pagesToRender
					? showLoading(t('whiteboard', 'Importing the first {count} of {total} pages from "{name}" (maximum is {max})…', {
							count: pagesToRender,
							total: totalPages,
							name: fileName,
							max: MAX_PDF_PAGES,
						}), { timeout: -1 })
					: showLoading(t('whiteboard', 'Importing "{name}"… ({current}/{total})', {
							name: fileName,
							current: Math.max(pageNumber, 1),
							total: pagesToRender,
						}), { timeout: -1 })
			})

			toastState.current?.hideToast()

			if (pages.length === 0) {
				showError(t('whiteboard', 'The PDF "{name}" has no pages to import.', { name: fileName }))
				return
			}

			const groupId = generateId()
			const files: BinaryFileData[] = []
			const maxHeight = Math.max(...pages.map((page) => page.height))
			let cursorX = 0

			const imageSpecs = pages.map((page) => {
				const fileId = generateId() as FileId
				files.push({
					mimeType: page.mimeType,
					id: fileId,
					dataURL: page.dataURL as DataURL,
					created: Date.now(),
				})

				const x = cursorX
				const y = (maxHeight - page.height) / 2
				cursorX += page.width + PAGE_GAP_PX

				return {
					type: 'image' as const,
					fileId,
					x,
					y,
					width: page.width,
					height: page.height,
					groupIds: [groupId],
				}
			})

			excalidrawAPI.addFiles(files)

			const newElements = convertToExcalidrawElements(imageSpecs)
			const target = viewportCoordsToSceneCoords(getViewportCenterPoint(), excalidrawAPI.getAppState())
			const centeredElements = moveElementsToViewport(newElements, target)

			const existingElements = excalidrawAPI.getSceneElementsIncludingDeleted().slice()
			excalidrawAPI.updateScene({ elements: [...existingElements, ...centeredElements] })

			showSuccess(t('whiteboard', 'Imported {count} PDF pages from "{name}".', {
				count: pages.length,
				name: fileName,
			}))
		} catch (error) {
			toastState.current?.hideToast()
			showError(t('whiteboard', 'Could not import PDF "{name}": {message}', {
				name: fileName,
				message: error instanceof Error ? error.message : String(error),
			}))
		}
	}, [excalidrawAPI, isReadOnly])

	const importPdfFileRef = useRef(importPdfFile)
	useEffect(() => {
		importPdfFileRef.current = importPdfFile
	}, [importPdfFile])

	// Reads a File picked from a cloud-sync placeholder (e.g. an
	// on-demand/"online-only" Dropbox or OneDrive file that hasn't been
	// downloaded yet) can fail with NotReadableError, and reliably does if
	// too much unrelated async work (importing pdfjs-dist, creating the
	// worker, ...) happens between the drop/pick and the read - so this
	// reads the file immediately, as the very first thing done with it,
	// before any of that.
	const readFileAndImport = useCallback(async (file: File) => {
		let data: ArrayBuffer
		try {
			data = await file.arrayBuffer()
		} catch (error) {
			if (error instanceof DOMException && error.name === 'NotReadableError') {
				showError(t('whiteboard', 'The file could not be read. Make sure it is fully downloaded and still exists.'))
			} else {
				showError(t('whiteboard', 'Could not read "{name}": {message}', {
					name: file.name,
					message: error instanceof Error ? error.message : String(error),
				}))
			}
			return
		}

		await importPdfFileRef.current(file.name, data)
	}, [])

	useEffect(() => {
		// excalidrawAPI is only set after Excalidraw has actually mounted, so
		// this is what makes the effect re-run once .excalidraw-wrapper
		// exists - on the very first render (isLoading, before Excalidraw
		// mounts) the wrapper isn't in the DOM yet and a one-shot effect
		// would silently never attach the listener.
		if (!excalidrawAPI) {
			return
		}

		const wrapper = document.getElementsByClassName('excalidraw-wrapper')[0] as HTMLElement | undefined
		if (!wrapper) {
			return
		}

		const handleDrop = (ev: DragEvent) => {
			const file = ev.dataTransfer?.files?.[0]
			if (!file || file.type !== 'application/pdf') {
				return
			}

			ev.preventDefault()
			ev.stopPropagation()
			void readFileAndImport(file)
		}

		// Capture phase: decide before Excalidraw's own (bubble-phase) drop
		// handler runs, so non-PDF drops are unaffected.
		wrapper.addEventListener('drop', handleDrop, true)
		return () => wrapper.removeEventListener('drop', handleDrop, true)
	}, [excalidrawAPI, readFileAndImport])

	const openImportDialog = useCallback(() => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = 'application/pdf'
		input.style.display = 'none'
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (file) {
				void readFileAndImport(file)
			}
			input.remove()
		})
		document.body.appendChild(input)
		input.click()
	}, [readFileAndImport])

	return { openImportDialog: isReadOnly ? undefined : openImportDialog }
}
