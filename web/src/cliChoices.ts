import type { ProviderInfo, ProviderProfile } from './api'
import type { SelectOption } from './components/CustomSelect'

/**
 * One menu value names a CLI, or a CLI plus one of its accounts
 * ("codex@codex-work"). Neither a CLI name nor an account ID can contain "@".
 */
const SEP = '@'

export interface CliChoice {
  provider: string
  account?: string
}

export const cliLabel = (provider: string) => provider.replace(/_/g, ' ')

export function cliChoiceValue(provider?: string | null, account?: string | null): string {
  if (!provider) return ''
  return account ? `${provider}${SEP}${account}` : provider
}

export function parseCliChoice(value: string): CliChoice {
  const at = value.indexOf(SEP)
  if (at < 0) return { provider: value }
  return { provider: value.slice(0, at), account: value.slice(at + 1) || undefined }
}

const AUTH_LABELS: Record<string, string> = {
  authenticated: 'signed in',
  unconfigured: 'not signed in',
  expired: 'login expired',
  unknown: 'login not checked',
  error: 'login check failed',
  unsupported: 'login not supported',
}

export const authLabel = (state: string) => AUTH_LABELS[state] ?? state

/**
 * Options for a "which CLI" menu. A CLI with accounts (Settings › Provider
 * Profiles) gets its own section: each account by its name, then the CLI
 * itself, which uses the CLI's default account or, without one, the CLI's own
 * login on this machine. A CLI without accounts is one plain entry.
 *
 * Accounts that are not signed in, and CLIs that are not installed, are
 * listed but disabled, except the value already selected.
 */
export function cliOptions(
  providers: ProviderInfo[],
  accounts: ProviderProfile[],
  opts: { current?: string; allowUninstalled?: boolean; label?: (provider: string) => string } = {},
): SelectOption[] {
  const label = opts.label ?? cliLabel
  const options: SelectOption[] = []
  for (const p of providers) {
    const mine = accounts.filter(a => a.provider === p.name)
    const unusable = !p.installed && !opts.allowUninstalled
    const plainDisabled = unusable && p.name !== opts.current
    if (mine.length === 0) {
      options.push({
        value: p.name,
        label: label(p.name),
        sublabel: !p.installed ? 'Not installed' : undefined,
        disabled: plainDisabled,
      })
      continue
    }
    const group = label(p.name)
    for (const a of mine) {
      const value = cliChoiceValue(p.name, a.id)
      options.push({
        value,
        label: a.label,
        sublabel: `${label(p.name)} · ${!p.installed ? 'not installed' : authLabel(a.auth_state)}`,
        disabled: (unusable || a.auth_state !== 'authenticated') && value !== opts.current,
        group,
      })
    }
    const fallback = mine.find(a => a.is_default)
    options.push({
      value: p.name,
      label: label(p.name),
      sublabel: !p.installed
        ? 'Not installed'
        : fallback ? `Default account: ${fallback.label}` : 'CLI login on this machine',
      disabled: plainDisabled,
      group,
    })
  }
  return options
}
