# Contributing to CareerBot

## Branch model

CareerBot uses a dev-first workflow with three long-lived branches:

| Branch | Role |
| --- | --- |
| `main` | Stable release branch and the repo default. Protected: changes land only through a reviewed pull request. Don't commit to it directly. |
| `dev` | Active development. This is where day-to-day work happens. |
| `marketing` | The landing-page site (`marketing/`) and its GitHub Pages deploy. Auto-synced from `main`, so you never merge into it by hand. |

## Day to day

1. Work on `dev`. For small changes, commit straight to `dev`. For larger or
   riskier work, branch off `dev` (`feature/...`) and merge back into `dev`.
2. When `dev` is ready for a release, open a pull request from `dev` into
   `main`. Once the repo is public this PR needs a review (you approve it)
   before it can merge.
3. Merging into `main` is the release. A workflow then merges `main` into
   `marketing` automatically, so the site stays in step without anyone
   touching `marketing/`.

Don't push to `main` directly, and don't open feature PRs against `main`.
Target `dev`.

## The marketing site

The landing page lives only on the `marketing` branch under `marketing/`. To
change it, switch to that branch and edit there:

```bash
git switch marketing
node marketing/preview.mjs   # serves marketing/ at http://localhost:8080
```

Pushing `marketing/` changes to that branch redeploys the live site through
GitHub Pages. Code and docs flow the other way: edit them on `dev`, and they
reach `marketing` through the automatic sync.

## Style

User-facing text (README, docs, site copy, application content) follows
`modes/humanizer.md`: plain language, no em dashes, no filler.
