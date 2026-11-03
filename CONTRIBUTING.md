# Contributing

1. Discuss significant product or schema changes in an issue first.
2. Include tests for changed behavior.
3. For the current anonymous edition, run `npm run test:public`, `node cloud/tests/run.mjs`, `npm run build`, and `npm run test:public:integration`. Legacy workspace changes additionally require their typecheck/lint/tests and `npm run build:legacy`.
4. Never commit `data/`, backups, API keys, manuscripts or generated server keys.
5. Database changes require an additive migration and a regression test.

Contributions are accepted under GPL-3.0-only.
