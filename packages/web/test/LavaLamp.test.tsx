import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LavaLamp } from '../src/components/LavaLamp'

describe('<LavaLamp>', () => {
  it('shows a connected title and marks the animation running when connected', () => {
    render(<LavaLamp connected />)
    const lamp = screen.getByTitle('connected')
    expect(lamp.className).toMatch(/lampOn/)
    expect(lamp.className).not.toMatch(/lampOff/)
  })

  it('shows a disconnected title and dims/pauses the animation when not connected', () => {
    render(<LavaLamp connected={false} />)
    const lamp = screen.getByTitle('disconnected')
    expect(lamp.className).toMatch(/lampOff/)
    expect(lamp.className).not.toMatch(/lampOn/)
  })

  it('renders three outlined (unfilled) blob shapes', () => {
    const { container } = render(<LavaLamp connected />)
    const circles = container.querySelectorAll('circle')
    expect(circles).toHaveLength(3)
  })
})
