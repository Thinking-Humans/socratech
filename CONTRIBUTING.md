# Contributing to Socratech

Bug reports, focused fixes, documentation, reviews and testing are welcome. Socratech is maintained by Thinking Humans.

## Project direction

Discuss meaningful changes with the maintainers **before implementing them**. That covers the notebook model, teaching method, agent behavior, publishing, core architecture, storage formats, new features and integrations. Open an issue that explains the problem, the behavior you propose and the alternatives you considered.

A fix restores intended behavior. Changing what the intended behavior should be is a design proposal. If the intended behavior is unclear, ask first.

Plugins are the home for optional capabilities that don't belong in core. The plugin infrastructure is still evolving, so discuss the use case before assuming an extension point is stable.

## Upstream

Socratech is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness) and regularly merges upstream changes. A bug that also exists in LearnHarness and doesn't touch Socratech-specific code (notebooks, publishing, branding) is best reported and fixed [upstream](https://github.com/amosblomqvist/learnharness/issues). Socratech picks the fix up on the next merge. Keep Socratech-only changes out of shared files where you can, so merges stay clean.

## Pull requests

**Keep each PR focused on one coherent problem.** Include the tests and documentation that change needs. Leave unrelated fixes, refactors, dependency updates and formatting for separate PRs. Follow the existing architecture and conventions.

In the description, explain:

- the problem, linking the issue if there is one;
- what changed and why it fixes the problem;
- how you verified it, including limitations and anything untested.

Use clear, concise language and distinguish what you observed from what you suspect. AI-assisted and hand-written contributions are held to the same standard; you're responsible for the accuracy of everything in the PR.

### Verification

Run the relevant checks and add regression coverage where useful:

```bash
npm run typecheck && npm run lint && npm test
```

See the [development guide](docs/development.md) for setup and the [architecture reference](docs/architecture.md) for runtime boundaries.

## Bug reports

Include the app version or commit, your OS, what you did, what you expected and what happened. Add the provider/model when relevant, plus a minimal example, screenshot or redacted error if you can.

Never post credentials, tokens, private notebooks or private learning records, and never use them as test fixtures. Prefer synthetic or shareable examples.

## Review and credit

Maintainers decide project direction and what is accepted. Review may lead to revisions, narrower scope or a decision not to proceed; passing tests alone don't establish that a behavior belongs in the product. We may finish a contribution with follow-up changes while preserving authorship and credit.

Socratech is licensed under [AGPL-3.0](LICENSE). By contributing, you agree your contribution is licensed under the same terms.
