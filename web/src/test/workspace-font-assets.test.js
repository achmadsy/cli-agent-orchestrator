// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
const root = new URL('../../../vendor/tmux-webui/internal/assets/static/fonts/', import.meta.url)
const provenance = JSON.parse(readFileSync(new URL('provenance.json', root), 'utf8'))
describe('separately licensed local terminal fonts', () => {
  it('matches every pinned binary and companion notice hash', () => {
    expect(provenance.revision).toBe('fa7b859994228a9c8759f99c55a8d31ee92a1b5e')
    for (const [name, entry] of Object.entries(provenance.files)) {
      const bytes = readFileSync(new URL(name, root))
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(entry.sha256)
      expect(bytes.length).toBe(entry.bytes)
    }
  })
  it('ships complete licenses and no held composite Meslo font', () => {
    expect(readdirSync(root).some(name => /meslo/i.test(name))).toBe(false)
    expect(readFileSync(new URL('LICENSE-DejaVu.txt', root), 'utf8')).toContain('Arev Fonts Copyright')
    expect(readFileSync(new URL('LICENSE-Powerline.txt', root), 'utf8')).toContain('Permission is hereby granted')
    expect(readFileSync(new URL('LICENSE-FontAwesome.txt', root), 'utf8')).toContain('SIL OPEN FONT LICENSE')
  })
})
