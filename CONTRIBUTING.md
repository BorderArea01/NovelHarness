# Contributing

1. Discuss significant product or schema changes in an issue first.
2. Include tests for changed behavior.
3. For the current anonymous edition, run `npm run test:public`, `node cloud/tests/run.mjs`, `npm run build`, and `npm run test:public:integration`. Legacy workspace changes additionally require their typecheck/lint/tests and `npm run build:legacy`.
4. Never commit `data/`, backups, API keys, manuscripts or generated server keys.
5. Database changes require an additive migration and a regression test.

Use a feature/fix branch and a pull request. `main` requires the current PR's
`anonymous-edition` check from GitHub Actions; do not push experiments or partial
CI repairs directly to shared branches. Check the latest PR head SHA before
merging, and do not bypass protection or weaken tests to remove failure mail.

Run `npm run repo:setup` in a maintainer checkout to install the local pre-push
guard. An existing custom hook chain is preserved rather than silently replaced.
The guard does not run builds or use credentials. Server-side branch protection
still applies to clients that have not installed local hooks.

Before a PR, compare the workflow's fresh Ubuntu/Node/Chromium environment with
your local setup, use lockfiles, and declare the UI test language. Generated
resources must be recreated from tracked sources. A local pass does not certify
a different runner. On the first CI failure, inspect its logs before making a
consolidated fix; rerun unchanged code only for an evidenced transient failure.
PR updates trigger one PR validation, and superseded validations are cancelled.
Legitimate CI failures may still notify subscribers; notifications stay enabled.

Contributions are accepted under GPL-3.0-only.
