# Terminal font assets

Pinned source: `ryanoasis/nerd-fonts` v3.4.0, commit
`fa7b859994228a9c8759f99c55a8d31ee92a1b5e`.
Every source URL, byte size, SHA256 and embedded notice record is in
`provenance.json`. Font binaries are byte-identical to that revision; CAO does
not merge, rename internally, subset or regenerate them. Local asset filenames
and CSS family aliases do not alter their embedded names.

| Assets | Original family | License / companion notice |
|---|---|---|
| `mono-*.ttf` (regular, bold, oblique, bold-oblique) | DejaVu Sans Mono 2.37 | Bitstream Vera / Arev permissions, DejaVu changes public domain; `LICENSE-DejaVu.txt` |
| `powerline.otf` | PowerlineSymbols | MIT; `LICENSE-Powerline.txt` |
| `fontawesome.otf` | FA Nerd Font (upstream Font Awesome remix) | Font Awesome font SIL OFL 1.1; `LICENSE-FontAwesome.txt` (also preserves upstream icon/code notices) |

Preserve all three complete notices with these assets in source, embedded
sidecar binaries, and redistributed packages. They are also available by exact
filename via the authenticated viewer gateway. Font Awesome is an independent
unmodified font, not merged into a differently licensed derivative. Its
Reserved Font Name is not used for a new/modified font; CAO makes no authorship
or endorsement claim. Brand glyphs identify the corresponding products only.
Do not sell the fonts by themselves.

## Rendering scope

The base four faces provide fixed-cell text/Unicode. Separately licensed
Powerline symbols U+E0A0–E0A2 / U+E0B0–E0B3 and Font Awesome U+ED00–F2FF are
rendered in one base-font cell using escaped text and CSS, with no extra
characters in copied output. These cover the private zsh git/Powerline fixture,
not every Powerlevel10k/Nerd Font glyph. Uncovered icons depend on installed
browser fallback fonts. This is deliberately **not** an all-Nerd-Font promise.

The earlier MesloLGS NF bundle was removed from staged source because its
composite glyph provenance/notices were insufficiently established. It must
not be restored or silently included in release artifacts. No runtime CDN,
font installer or change to the user's server shell/font config is involved.
