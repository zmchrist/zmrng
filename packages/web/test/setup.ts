// Extends Vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// and wires @testing-library/react's automatic cleanup between tests.
import '@testing-library/jest-dom/vitest'

// jsdom implements no layout, so `Element.scrollIntoView` is absent — components
// that auto-scroll (e.g. WorkerLog) would throw in an effect. Stub it as a no-op.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}
