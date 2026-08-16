import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import styles from './Viewer.module.css'

interface Props {
  base64: string
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// pdfjs-dist's shipped types omit the public `destroy()` on PDFDocumentProxy
// even though it exists at runtime; narrow just enough to call it for cleanup.
function destroyDoc(doc: PDFDocumentProxy): void {
  void (doc as unknown as { destroy(): Promise<void> }).destroy()
}

/** Read-only PDF render via pdf.js — one canvas per page, stacked in a
 *  scrollable column. Loaded lazily (dynamic import) so the pdf.js worker
 *  only ships to the bundle when a PDF is actually opened. */
export function PdfViewer({ base64 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    let doc: PDFDocumentProxy | null = null

    async function render(): Promise<void> {
      const pdfjsLib = await import('pdfjs-dist')
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

      const loaded = await pdfjsLib.getDocument({ data: base64ToBytes(base64) }).promise
      if (cancelled) {
        destroyDoc(loaded)
        return
      }
      doc = loaded
      setPageCount(loaded.numPages)

      const host = containerRef.current
      if (!host) return
      host.replaceChildren()
      for (let pageNum = 1; pageNum <= loaded.numPages; pageNum++) {
        if (cancelled) return
        const page = await loaded.getPage(pageNum)
        const viewport = page.getViewport({ scale: 1.25 })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.className = styles.pdfPage
        host.appendChild(canvas)
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
      }
    }

    render().catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      cancelled = true
      if (doc) destroyDoc(doc)
    }
  }, [base64])

  if (error) return <div className={styles.error}>Failed to render PDF: {error}</div>
  return (
    <div className={styles.pdfScroll}>
      <div ref={containerRef} className={styles.pdfPages} />
      {pageCount > 0 && (
        <div className={styles.pdfMeta}>
          {pageCount} page{pageCount === 1 ? '' : 's'}
        </div>
      )}
    </div>
  )
}
