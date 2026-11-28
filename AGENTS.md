# AGENTS.md

pi-extensions-collection: Pi coding-agent extensions installed as one git package. Each extension is an npm workspace (`ask-user`, `background-terminal`, `bash-timeout`, `goal`, `subagent`, `tool-groups`) with shared code in `shared/`. No build step, no npm publishing.

## Commands

- `npm test` — root tests (`scripts/*.test.mjs`) plus every workspace's tests
- `npm run typecheck` — TypeScript across all workspaces

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles use their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
