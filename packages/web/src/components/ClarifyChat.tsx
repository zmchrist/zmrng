import { useState } from 'react'
import styles from './ClarifyChat.module.css'

interface Props {
  onSend: (text: string) => void
  disabled?: boolean
  placeholder?: string
}

export function ClarifyChat({
  onSend,
  disabled,
  placeholder = "Answer the agent's questions…  (⌘↵ to send)",
}: Props) {
  const [text, setText] = useState('')

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = text.trim()
    if (!t || disabled) return
    onSend(t)
    setText('')
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      submit(e)
    }
  }

  return (
    <form className={styles.bar} onSubmit={submit}>
      <textarea
        className={styles.input}
        placeholder={placeholder}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className={styles.send}
        disabled={disabled || !text.trim()}
      >
        Send
      </button>
    </form>
  )
}
