import { describe, it, expect } from 'vitest'
import { isNearBottom } from '../src/useAutoScroll'

describe('isNearBottom', () => {
  it('is true when scrolled fully to the bottom', () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 300, clientHeight: 200 })).toBe(true)
  })

  it('is true within the default threshold of the bottom', () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 280, clientHeight: 200 })).toBe(true)
  })

  it('is false once scrolled up past the threshold', () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 100, clientHeight: 200 })).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 250, clientHeight: 200 }, 60)).toBe(true)
    expect(isNearBottom({ scrollHeight: 500, scrollTop: 250, clientHeight: 200 }, 40)).toBe(false)
  })
})
