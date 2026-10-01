import styles from './AttachmentTray.module.css'
import { NavIcon } from './NavIcon'
import type { Attachment } from '../types'

interface Props {
  attachments: Attachment[]
  onRemove: (index: number) => void
  /** Validation/limit error to surface below the strip. */
  error?: string | null
}

/** Build a `data:` URL from an attachment's base64 payload (for image previews). */
function dataUrl(a: Attachment): string {
  return `data:${a.mediaType};base64,${a.dataBase64}`
}

/**
 * A thumbnail strip of pending attachments: image previews render inline, PDFs
 * show a generic chip. Each has a remove button; a validation error renders on
 * its own line below. Purely presentational — state lives in `useAttachments`.
 */
export function AttachmentTray({ attachments, onRemove, error }: Props) {
  if (attachments.length === 0 && !error) return null
  return (
    <div className={styles.tray}>
      {attachments.length > 0 && (
        <ul className={styles.strip}>
          {attachments.map((a, i) => (
            <li key={i} className={styles.item}>
              {a.kind === 'image' ? (
                <img className={styles.thumb} src={dataUrl(a)} alt={a.name ?? 'image attachment'} />
              ) : (
                <span className={styles.doc} aria-hidden="true">
                  PDF
                </span>
              )}
              <span className={styles.name} title={a.name}>
                {a.name ?? a.kind}
              </span>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${a.name ?? 'attachment'}`}
                onClick={() => onRemove(i)}
              >
                <NavIcon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  )
}
