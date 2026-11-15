# Security policy

Socratech stores API keys, sign-in tokens, notebooks, and learning records on your machine. Its agent reads files and fetches web content on your behalf, its code cells run code locally, and publishing pushes to a git repo you choose. If you find a way to abuse any of that, please tell us privately so a fix can ship before the details are public.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security problem.**

Report it through GitHub's private vulnerability reporting:
[Security → Report a vulnerability](https://github.com/Thinking-Humans/socratech/security/advisories/new).

If that page is unavailable, open a blank issue titled "Security contact request" with no details, and a maintainer will reach out privately.

A useful report includes:

- the Socratech version or commit and your OS;
- what an attacker can do and what they need first (a web page the agent reads, a file the learner opens, network access, and so on);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you have in mind.

## Security contacts

- [@UberMayinch](https://github.com/UberMayinch)

Use the private reporting process above for vulnerability reports. Do not report security details through public mentions.

## What to expect

These are targets, not guarantees:

| Step | Target |
| --- | --- |
| Acknowledge your report | within 7 days |
| Initial assessment (confirmed or not, severity) | within 14 days |
| Fix released and advisory published | within 90 days of the report |

The fix is developed privately in a GitHub security advisory. We will keep you updated, agree on a disclosure date with you, and credit you in the published advisory unless you prefer to stay anonymous. A CVE can be requested through GitHub when one is warranted.

## Supported versions

Only the latest release receives security fixes. The desktop app updates itself, so fixes reach users through a new release. If you run from source, update to the latest `main` or the latest release tag.

## Scope

In scope:

- the desktop app (Electron shell, window, and IPC);
- the local API server, whether started by the desktop app or run from source;
- the agent and its tools, including prompt injection from web pages, PDFs, or other content that leads to reading, changing, or sending your data;
- notebook code cells (the per-notebook Python kernel and C++ runner) and notebook media;
- publishing to a site repo (what gets staged, committed, and pushed);
- rendered content such as demos, figures, and markdown;
- the update and release pipeline.

Out of scope:

- attacks that already require running code as your OS user;
- bugs in third-party model or service providers themselves (report those to the provider);
- automated scanner output without a demonstrated impact on Socratech;
- vulnerabilities in LearnHarness code Socratech has not modified: report those [upstream](https://github.com/amosblomqvist/learnharness/security) too.
