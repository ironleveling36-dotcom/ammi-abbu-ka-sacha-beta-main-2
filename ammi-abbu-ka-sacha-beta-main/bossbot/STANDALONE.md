# Standalone project

This folder is a **complete, self-contained project**. It does not read anything
from the parent repository — all Swiggy code it needs is in `vendor/`.

## Create the GitHub repo (one time)

The Arena sandbox token only has write access to the parent repository, so the
push has to come from your own machine (or from a GitHub connection that has the
new repo selected). The repository `hulm0408/bossbot` already exists and is
empty.

### 3 commands (verified end-to-end)

Run these in the terminal **from any empty folder**:

```bash
git clone -b arena/7406ca34-ammi-abbu-ka-sacha-beta https://github.com/hulm0408/ammi-abbu-ka-sacha-beta.git parent
cd parent && git subtree split -P bossbot -b bossbot-only && cd ..
git clone -b bossbot-only parent bossbot && cd bossbot && git branch -M main && git remote set-url origin https://github.com/hulm0408/bossbot.git && git push -u origin main
```

Result: `https://github.com/hulm0408/bossbot` contains the whole project —
20 files, 4 commits, and `npm test` passes 49/49 from the fresh clone.

> If the branch above is ever deleted, run `git subtree split` from `main`
> after this PR is merged — the folder lives there too.

## Deploy to Render

**Easiest — no file edits:** Render → **New → Web Service** → pick
`hulm0408/bossbot` (root directory empty), then:

| Field | Value |
|---|---|
| Build command | `npm install --omit=dev --ignore-scripts` |
| Start command | `npm start` |
| Health check path | `/` |
| Env | `BOT_TOKEN`, `BOSS_IDS` (numeric IDs, comma separated) |
| Disk | mount at `/opt/render/project/src/vendor/data` |

**Blueprint instead:** delete the `rootDir: bossbot` line from `render.yaml`
first (this *is* the repo root now), then New → Blueprint.

## What is intentionally NOT here

- the parent bot's 12k-line `index.js`, panel code, topic flows, competitor flows
- any hardcoded repo/domain: the cloud vault stays **off** unless
  `GITHUB_VAULT_OWNER` + `GITHUB_VAULT_REPO` are set, so this project can never
  write sessions into another project's repository
