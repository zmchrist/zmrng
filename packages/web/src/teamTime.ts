/**
 * Pure timestamp formatting for the Team chat message rows.
 *
 * Renders a message's ISO `createdAt` as a full ISO date plus a 12-hour clock
 * with AM/PM and no seconds — e.g. `2026-09-07 3:42 PM`. Local time is used so
 * the stamp reads in the viewer's own timezone. A malformed/empty input yields
 * an empty string rather than `Invalid Date`, so the row degrades gracefully.
 */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''

  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')

  let hours = d.getHours()
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12
  if (hours === 0) hours = 12

  return `${yyyy}-${mm}-${dd} ${hours}:${minutes} ${meridiem}`
}
