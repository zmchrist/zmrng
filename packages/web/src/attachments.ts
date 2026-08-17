// Pure helpers for turning dropped/pasted browser `File`s into the transient
// `Attachment` shape the server expects. Kept out of the React components so the
// validation + MIME/kind logic is unit-testable without a DOM. The limits here
// mirror the server's (`ALLOWED_MEDIA_TYPES` / `MAX_ATTACHMENTS` /
// `MAX_ATTACHMENT_BYTES` in types.ts) so the two ends agree.

import {
  ALLOWED_MEDIA_TYPES,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
  type AttachmentKind,
} from './types'

/** Map a MIME type to its attachment kind — PDFs are documents, everything else an image. */
export function mimeToKind(mime: string): AttachmentKind {
  return mime === 'application/pdf' ? 'document' : 'image'
}

/**
 * Validate one file against the shared allow-list + size cap. Returns a
 * human-readable error string, or `null` when the file is acceptable. The
 * "near-miss must not match" cases (e.g. `image/svg+xml`, `text/plain`) live
 * here so they are covered by the pure unit test.
 */
export function validateFile(file: File): string | null {
  if (!ALLOWED_MEDIA_TYPES.includes(file.type)) {
    return `${file.name || 'file'}: unsupported type (${file.type || 'unknown'})`
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    const mb = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0)
    return `${file.name || 'file'}: too large (max ${mb} MB)`
  }
  return null
}

/** Strip the `data:...;base64,` prefix from a FileReader data-URL, leaving raw base64. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/** Read a `File` into an `Attachment` (base64, no data-URL prefix). Assumes `validateFile` passed. */
export function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('failed to read file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve({
        kind: mimeToKind(file.type),
        mediaType: file.type,
        dataBase64: stripDataUrlPrefix(result),
        name: file.name || undefined,
      })
    }
    reader.readAsDataURL(file)
  })
}

/** Pull the `File[]` off a clipboard paste event (images pasted as blobs land here). */
export function filesFromPaste(e: ClipboardEvent | React.ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const out: File[] = []
  for (const item of items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/** Pull the `File[]` off a drag-and-drop event. */
export function filesFromDrop(e: DragEvent | React.DragEvent): File[] {
  const dt = e.dataTransfer
  if (!dt) return []
  return Array.from(dt.files)
}
