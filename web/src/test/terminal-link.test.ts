import { afterEach, describe, expect, it } from 'vitest'
import { readTerminalLink, stripTerminalLink } from '../terminalLink'

const original = location.href
afterEach(() => history.replaceState(null, '', original))
describe('terminal navigation metadata', () => {
  it('parses an exact session and terminal without consuming the URL', () => {
    const search = '?terminal_session=cao-demo&terminal_id=abcd1234'
    expect(readTerminalLink(search)).toEqual({ request: { session: 'cao-demo', terminalId: 'abcd1234' } })
    expect(readTerminalLink('?other=1')).toBeNull()
  })
  it.each(['?terminal_session=cao-x', '?terminal_id=a', '?terminal_session=../x&terminal_id=a', '?terminal_session=cao-x&terminal_id=a&terminal_id=b'])(
    'rejects invalid or ambiguous link %s', search => expect(readTerminalLink(search)).toHaveProperty('error'),
  )
  it('strips only navigation keys, preserving base path, unrelated query and fragment', () => {
    history.replaceState({ keep: true }, '', '/cao/?keep=1&terminal_session=cao-demo&terminal_id=abcd1234#other=x')
    stripTerminalLink()
    expect(location.pathname + location.search + location.hash).toBe('/cao/?keep=1#other=x')
    expect(history.state).toEqual({ keep: true })
  })
})
