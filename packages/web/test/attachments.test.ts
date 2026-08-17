import { describe, it, expect } from 'vitest'
import { mimeToKind, validateFile, fileToAttachment } from '../src/attachments'
import { ALLOWED_MEDIA_TYPES, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../src/types'

/** A stand-in `File` for validateFile (which only reads type/size/name). */
function fakeFile(type: string, size: number, name = 'f'): File {
  return { type, size, name } as unknown as File
}

describe('mimeToKind', () => {
  it('maps application/pdf → document and every image type → image', () => {
    expect(mimeToKind('application/pdf')).toBe('document')
    expect(mimeToKind('image/png')).toBe('image')
    expect(mimeToKind('image/jpeg')).toBe('image')
    expect(mimeToKind('image/gif')).toBe('image')
    expect(mimeToKind('image/webp')).toBe('image')
  })
})

describe('validateFile', () => {
  it('accepts each allowed media type at a sane size', () => {
    for (const type of ALLOWED_MEDIA_TYPES) {
      expect(validateFile(fakeFile(type, 1024))).toBeNull()
    }
  })

  it('rejects a disallowed MIME (near-miss types must not match)', () => {
    expect(validateFile(fakeFile('image/svg+xml', 1024))).toMatch(/unsupported/)
    expect(validateFile(fakeFile('text/plain', 1024))).toMatch(/unsupported/)
    expect(validateFile(fakeFile('', 1024))).toMatch(/unsupported/)
  })

  it('rejects an oversized file', () => {
    expect(validateFile(fakeFile('image/png', MAX_ATTACHMENT_BYTES + 1))).toMatch(/too large/)
    expect(validateFile(fakeFile('image/png', MAX_ATTACHMENT_BYTES))).toBeNull()
  })
})

describe('shared limits', () => {
  it('caps the attachment count at 10', () => {
    expect(MAX_ATTACHMENTS).toBe(10)
  })
})

describe('fileToAttachment', () => {
  it('reads a File to base64 with the data-URL prefix stripped', async () => {
    const file = new File([new Uint8Array([104, 105])], 'hi.png', { type: 'image/png' })
    const att = await fileToAttachment(file)
    expect(att.kind).toBe('image')
    expect(att.mediaType).toBe('image/png')
    expect(att.name).toBe('hi.png')
    // base64('hi') === 'aGk=' — and NO 'data:...;base64,' prefix.
    expect(att.dataBase64).toBe('aGk=')
    expect(att.dataBase64).not.toMatch(/^data:/)
  })
})
