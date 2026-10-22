# Project instructions

## Font licensing

All shipped fonts must be free for commercial use. `font-licenses.json` records the approved binaries, SHA256 hashes, source snapshots and notices. Run `node scripts/check-font-licenses.mjs` before building or distributing. Keep full license notices embedded in native fonts and beside web fonts. Do not restore proprietary source kits, trial fonts or unverified downloaded fonts. Font substitutions must retain the design roles and pass rendered mobile/desktop checks.
