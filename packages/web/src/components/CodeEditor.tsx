import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import type { LanguageSupport } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import styles from './CodeEditor.module.css'

/** Extension → CodeMirror language, by file suffix. `null` falls back to plain text. */
function languageFor(path: string): LanguageSupport | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'md':
    case 'markdown':
      return markdown()
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({ jsx: true })
    case 'ts':
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'json':
      return json()
    case 'css':
      return css()
    case 'html':
    case 'htm':
      return html()
    case 'py':
      return python()
    default:
      return null
  }
}

const cmTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--well)',
    color: 'var(--text)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-strong)',
    color: 'var(--text-faint)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'var(--surface-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-selectionBackground, &.cm-focused ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)' },
})

interface Props {
  path: string
  initialValue: string
  onChange: (value: string) => void
}

/** A CodeMirror 6 editor, remounted (via the parent's `key={path}`) per open file
 *  so language + doc reset cleanly on switch. Reports doc changes via `onChange`;
 *  the parent owns the draft state and save flow. */
export function CodeEditor({ path, initialValue, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const onChangeRef = useRef(onChange)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const lang = languageFor(path)
    const extensions = [
      basicSetup,
      cmTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      }),
    ]
    if (lang) extensions.push(lang)
    const view = new EditorView({
      state: EditorState.create({ doc: initialValue, extensions }),
      parent: host,
    })
    return () => view.destroy()
    // Remounts on `path` change only — `initialValue` is a one-shot seed, not a controlled prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  return <div ref={hostRef} className={styles.editor} />
}
