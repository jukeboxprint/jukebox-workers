# Working in jukebox-workers

- This repo is PUBLIC. No secrets, no Cloudflare account / namespace / database ids, no n8n ids, no email addresses
  (tests use `.invalid` or `example.com`), no private hostnames, no customer data. `npm run guard` before every commit.
- Every Worker repo runs this code with its deploy token. A change here reaches all of them once they re-pin, so keep
  changes small, tested and behind the same rules: drift refuses, rollout rolls back, live only on Tyler's word.
- `scripts/door/*.mjs` came from jukebox-copilot (3 Nov 2026) with two changes only: `JBX_REPO_ROOT`, and `proof.mjs`
  finding `dist.mjs` next to itself. Keep them runnable from a caller's checkout.
- Releases: bump `package.json` version, note it in `docs/CHANGES.md`, tag `vX.Y.Z` after merge. Never move a tag.
- The spec is `docs/PATTERN.md`. Change it only on Tyler's word, and say what changed in the PR.
- Docs: write plainly and briefly.
