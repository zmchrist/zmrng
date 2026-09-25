import { describe, it, expect } from 'vitest'
import { encodeAttach, encodeClose, encodeInput, encodeResize, parseServerMsg } from '../src/terminalProtocol'

describe('encodeAttach', () => {
  it('includes the session id when reattaching', () => {
    expect(JSON.parse(encodeAttach('sess-1', 80, 24))).toEqual({
      type: 'attach',
      sessionId: 'sess-1',
      cols: 80,
      rows: 24,
    })
  })

  it('omits sessionId for a brand-new tab', () => {
    expect(JSON.parse(encodeAttach(undefined, 100, 30))).toEqual({
      type: 'attach',
      cols: 100,
      rows: 30,
    })
  })
})

describe('encodeInput', () => {
  it('produces the exact input frame the server parses', () => {
    expect(encodeInput('ls\n')).toBe('{"type":"input","data":"ls\\n"}')
  })

  it('round-trips through JSON.parse to the client frame shape', () => {
    expect(JSON.parse(encodeInput('x'))).toEqual({ type: 'input', data: 'x' })
  })

  it('escapes control/quote characters safely', () => {
    expect(JSON.parse(encodeInput('a"b\tc'))).toEqual({ type: 'input', data: 'a"b\tc' })
  })
})

describe('encodeResize', () => {
  it('produces the exact resize frame the server parses', () => {
    expect(encodeResize(80, 24)).toBe('{"type":"resize","cols":80,"rows":24}')
  })

  it('round-trips through JSON.parse to the client frame shape', () => {
    expect(JSON.parse(encodeResize(120, 40))).toEqual({ type: 'resize', cols: 120, rows: 40 })
  })
})

describe('parseServerMsg', () => {
  it('accepts a session frame', () => {
    expect(parseServerMsg('{"type":"session","sessionId":"sess-1"}')).toEqual({
      type: 'session',
      sessionId: 'sess-1',
    })
  })

  it('rejects a session frame with a non-string sessionId', () => {
    expect(parseServerMsg('{"type":"session","sessionId":42}')).toBeUndefined()
  })

  it('accepts a data frame', () => {
    expect(parseServerMsg('{"type":"data","data":"hello"}')).toEqual({ type: 'data', data: 'hello' })
  })

  it('accepts an exit frame with a numeric code', () => {
    expect(parseServerMsg('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 })
  })

  it('accepts an exit frame with a null code', () => {
    expect(parseServerMsg('{"type":"exit","code":null}')).toEqual({ type: 'exit', code: null })
  })

  it('rejects malformed JSON without throwing', () => {
    expect(parseServerMsg('{not json')).toBeUndefined()
  })

  it('rejects an unknown type', () => {
    expect(parseServerMsg('{"type":"nope","data":"x"}')).toBeUndefined()
  })

  it('rejects a data frame with a non-string data field', () => {
    expect(parseServerMsg('{"type":"data","data":42}')).toBeUndefined()
  })

  it('rejects an exit frame with a non-numeric, non-null code', () => {
    expect(parseServerMsg('{"type":"exit","code":"0"}')).toBeUndefined()
  })

  it('rejects empty input', () => {
    expect(parseServerMsg('')).toBeUndefined()
  })

  it('rejects a JSON value that is not an object', () => {
    expect(parseServerMsg('"data"')).toBeUndefined()
    expect(parseServerMsg('null')).toBeUndefined()
    expect(parseServerMsg('42')).toBeUndefined()
  })
})

describe('encodeClose', () => {
  it('produces the close frame the server parses', () => {
    expect(JSON.parse(encodeClose())).toEqual({ type: 'close' })
  })
})
