import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NavIcon, type NavIconName } from '../src/components/NavIcon'
import { MOBILE_VIEWS } from '../src/mobileNav'

const NAMES: NavIconName[] = [
  'workspace',
  'team',
  'kb',
  'settings',
  'files',
  'terminal',
  'chat',
  'lanes',
]

describe('<NavIcon>', () => {
  it.each(NAMES)('%s is a single-stroke currentColor outline with drawn content', (name) => {
    const { container } = render(<NavIcon name={name} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg?.getAttribute('fill')).toBe('none')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(svg?.getAttribute('stroke-width')).toBe('1.6')
    expect(svg?.getAttribute('stroke-linecap')).toBe('round')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.children.length).toBeGreaterThan(0)
  })

  it('covers every phone drawer view', () => {
    for (const v of MOBILE_VIEWS) expect(NAMES).toContain(v.icon)
  })
})
