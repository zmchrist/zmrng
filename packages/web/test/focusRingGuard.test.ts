import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Guard: no stylesheet may hide the focus ring (WCAG 2.4.7 / 1.4.11 / 2.4.13, F55).
//
// The global `:focus-visible` rule in theme.css draws a solid 2px --focus-color
// outline. A CSS-module class selector (`.input:focus`, 0,2,0) outranks
// `input:focus-visible` (0,1,1), so a module rule that sets `outline: none`
// silently removes that ring. This test fails on any rule block that sets
// `outline: none|0` unless the same block also sets a real outline, and on any
// `:focus*` rule whose outline is thinner than 2px (2.4.13).
//
// Exceptions go in ALLOWLIST as `<path relative to src>|<selector>` with a reason.
const ALLOWLIST: Record<string, string> = {}

// happy-dom rewrites import.meta.url to http://, so resolve from __dirname.
const SRC = join(__dirname, '..', 'src')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return name.endsWith('.module.css') || name === 'theme.css' ? [p] : []
  })
}

type Violation = { key: string; decl: string }

/** Rule blocks whose declarations contain `outline: none|0` with no real outline. */
function findHiddenOutlines(css: string, file: string): Violation[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Violation[] = []
  // Innermost blocks only: a selector followed by a body without nested braces.
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean)
    const outlines = decls.filter((d) => /^outline\s*:/i.test(d))
    const hidden = outlines.filter((d) => /^outline\s*:\s*(none|0)\s*(!important)?$/i.test(d))
    if (hidden.length > 0) {
      const restored = outlines.some((d) => !hidden.includes(d))
      if (!restored) out.push({ key: `${file}|${selector}`, decl: hidden[0] })
      continue
    }
    // A focus ring thinner than 2px fails 2.4.13 even when it is visible.
    if (!/:focus/.test(selector)) continue
    const widths = decls.filter((d) => /^outline(-width)?\s*:/i.test(d))
    const thin = widths.find((d) => {
      const v = d.replace(/^[^:]+:/, '')
      if (/\bthin\b/i.test(v)) return true
      const px = v.match(/(\d*\.?\d+)px/)
      return px !== null && Number(px[1]) < 2
    })
    if (thin) out.push({ key: `${file}|${selector}`, decl: thin })
  }
  return out
}

describe('focus-ring guard', () => {
  it('detects a hidden outline and accepts a restored one', () => {
    expect(findHiddenOutlines('.a:focus { outline: none; border-color: red }', 'x')).toHaveLength(1)
    expect(findHiddenOutlines('.a:focus { outline: 0 }', 'x')).toHaveLength(1)
    expect(findHiddenOutlines('.a:focus { outline: none; outline: 2px solid red }', 'x')).toHaveLength(0)
    expect(findHiddenOutlines('.a:focus-visible { outline: 1px solid red }', 'x')).toHaveLength(1)
    expect(findHiddenOutlines('.a:focus-visible { outline-width: thin }', 'x')).toHaveLength(1)
    expect(findHiddenOutlines('.a:focus-visible { outline-offset: -2px }', 'x')).toHaveLength(0)
    expect(findHiddenOutlines('.a { outline: 1px solid red }', 'x')).toHaveLength(0)
    expect(findHiddenOutlines('/* outline: none */ .a:focus { color: red }', 'x')).toHaveLength(0)
  })

  it('no stylesheet hides or thins the focus outline', () => {
    const files = cssFiles(SRC)
    expect(files.length).toBeGreaterThan(0)
    const violations = files
      .flatMap((f) => findHiddenOutlines(readFileSync(f, 'utf8'), relative(SRC, f)))
      .filter((v) => !(v.key in ALLOWLIST))
      .map((v) => `${v.key}  (${v.decl})`)
    expect(violations).toEqual([])
  })

  it('every allowlist entry has a reason and still matches a real rule', () => {
    const all = new Set(
      cssFiles(SRC).flatMap((f) =>
        findHiddenOutlines(readFileSync(f, 'utf8'), relative(SRC, f)).map((v) => v.key),
      ),
    )
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, key).toBeGreaterThan(0)
      expect(all.has(key), `stale allowlist entry: ${key}`).toBe(true)
    }
  })
})
