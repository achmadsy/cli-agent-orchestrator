import { describe, expect, it } from 'vitest'
import { cliChoiceValue, cliOptions, parseCliChoice } from '../cliChoices'
import type { ProviderInfo, ProviderProfile } from '../api'

const PROVIDERS: ProviderInfo[] = [
  { name: 'claude_code', binary: 'claude', installed: true },
  { name: 'codex', binary: 'codex', installed: true },
  { name: 'kiro_cli', binary: 'kiro-cli', installed: false },
]

function account(id: string, label: string, provider: string, auth_state = 'authenticated', is_default = false): ProviderProfile {
  return {
    id, label, provider, auth_state: auth_state as ProviderProfile['auth_state'], is_default,
    login_method: 'isolated_home', settings: {}, created_at: '', updated_at: '',
  }
}

describe('cliChoices', () => {
  it('round-trips a CLI and a CLI with an account', () => {
    expect(cliChoiceValue('codex')).toBe('codex')
    expect(cliChoiceValue('codex', 'codex-work')).toBe('codex@codex-work')
    expect(cliChoiceValue('', 'codex-work')).toBe('')
    expect(parseCliChoice('codex')).toEqual({ provider: 'codex' })
    expect(parseCliChoice('codex@codex-work')).toEqual({ provider: 'codex', account: 'codex-work' })
  })

  it('lists a CLI without accounts as one plain entry', () => {
    const options = cliOptions(PROVIDERS, [])
    expect(options.map(o => o.value)).toEqual(['claude_code', 'codex', 'kiro_cli'])
    expect(options.find(o => o.value === 'kiro_cli')?.disabled).toBe(true)
    expect(options.every(o => o.group === undefined)).toBe(true)
  })

  it('lists accounts by name, then the plain CLI, in the CLI group', () => {
    const options = cliOptions(PROVIDERS, [
      account('codex-work', 'Codex Work', 'codex'),
      account('codex-personal', 'Codex Personal', 'codex', 'unconfigured'),
    ])
    const codex = options.filter(o => o.group === 'codex')
    expect(codex.map(o => [o.value, o.label])).toEqual([
      ['codex@codex-work', 'Codex Work'],
      ['codex@codex-personal', 'Codex Personal'],
      ['codex', 'codex'],
    ])
    expect(codex[0].disabled).toBe(false)
    expect(codex[1].disabled).toBe(true)
    expect(codex[1].sublabel).toContain('not signed in')
    expect(codex[2].sublabel).toBe('CLI login on this machine')
    expect(options.find(o => o.value === 'claude_code')?.group).toBeUndefined()
  })

  it('names the default account on the plain CLI entry', () => {
    const options = cliOptions(PROVIDERS, [account('codex-work', 'Codex Work', 'codex', 'authenticated', true)])
    expect(options.find(o => o.value === 'codex')?.sublabel).toBe('Default account: Codex Work')
  })

  it('keeps the current pick enabled even when it is no longer signed in', () => {
    const options = cliOptions(PROVIDERS, [account('codex-work', 'Codex Work', 'codex', 'expired')], {
      current: 'codex@codex-work',
    })
    expect(options.find(o => o.value === 'codex@codex-work')?.disabled).toBe(false)
  })
})
