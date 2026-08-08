# Deploy bump — how a merge here reaches the k3d homelab

How a change to this repo's `main` ends up running at `https://blaze.howman.link`,
and what to do when it doesn't.

This is INF-798, closing the same class of bug that INF-793/INF-794 fixed for
`hjr15/howman-cloud-site` — see that repo's
[ADR-0007](https://github.com/hjr15/howman-cloud-site/blob/main/docs/decisions/0007-two-disjoint-deploy-paths-local-homelab-and-public-cloudflare.md)
for the shape of the failure this replaces, and
[`hjr15/service-platform`'s ADR-0023](https://github.com/hjr15/service-platform/blob/main/docs/decisions/0023-blaze-image-pin-cross-repo-bump-not-renovate.md)
for why this repo gets the same mechanism rather than a Renovate-tracked tag.

## The normal case

**Merge to `main`. That is the whole procedure.**

```
push main ──► build image ──► push to ghcr ──► write digest + sourceCommit into
 (paths:      (build job,      (public pkg,      hjr15/service-platform
  scripts/**,  ~1min)           already linked)   deploy/apps/blaze/values-dev.yaml
  package.json,                                          │
  Dockerfile)                                             ▼
                                        ArgoCD (automated: prune + selfHeal) reconciles
                                                            │
                                                            ▼
                                                https://blaze.howman.link
```

Owned by [`.github/workflows/build-image.yml`](../../.github/workflows/build-image.yml),
which now has two jobs: `build` (pre-existing — pushes `ghcr.io/hjr15/blaze:latest` and
`:${{ github.sha }}`) and `bump` (INF-798 — writes the digest that job produced, plus the
commit it was built from, into the chart repo). Only paths that can change the built
image (`scripts/**`, `package.json`, `Dockerfile`, the workflow itself) trigger a run —
a docs-only or test-only push rolls nothing, which is intended.

## What is live right now?

```sh
# which commit — from the cluster
kubectl --context k3d-service-platform -n blaze \
  get deploy blaze -o jsonpath='{.spec.template.metadata.annotations.blaze\.howman\.link/source-commit}{"\n"}'

# which image digest
kubectl --context k3d-service-platform -n blaze \
  get deploy blaze -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

> **`Synced / Healthy` is not freshness.** ArgoCD reports whether the cluster matches
> the pin in `service-platform` git, never whether that pin matches this repo's `main`.
> Compare `source-commit` against this repo's `main` — do not read the ArgoCD colour.
> This is the exact failure `howman-cloud` sat in for ten days before INF-793/794.

## One-time setup

### `BUMP_TOKEN`

The chart lives in `hjr15/service-platform`, so the bump is **cross-repo** and the
default `GITHUB_TOKEN` (scoped to this repo only) cannot write there.

1. <https://github.com/settings/personal-access-tokens/new> — fine-grained token
2. **Resource owner** `hjr15`; **Repository access** → *Only select repositories* →
   **`hjr15/service-platform`** — the repo it writes **to**, not this one
3. **Permissions → Contents → Read and write**. Nothing else
4. `gh secret set BUMP_TOKEN -R hjr15/blaze` and paste at the prompt

**Diary the expiry.** A silently expired PAT reproduces the exact stale-pin failure
this pipeline exists to remove: the bump stops moving and nothing goes red until
someone notices the board is old. (This is also the exact failure class INF-799's
staleness alert is designed to catch regardless of cause.)

### The ghcr package link

Unlike `howman-cloud-site`, this trap does **not** apply here: `ghcr.io/hjr15/blaze`
is already **public** and already linked to this repo (verified via
`gh api user/packages/container/blaze --jq '.repository.full_name, .visibility'` →
`hjr15/blaze`, `public`), so the `build` job's default `GITHUB_TOKEN` push already
works. Nothing to do.

## Troubleshooting

| Symptom | Cause | Do |
|---|---|---|
| `build` green, `bump` fails at **Require BUMP_TOKEN** | Secret absent or expired | Re-mint per above. The image *is* in ghcr — nothing is lost, it just isn't deployed |
| Workflow green, `blaze.howman.link` unchanged | Push didn't touch a path in the trigger filter (`scripts/**`, `package.json`, `Dockerfile`) | Nothing — working as designed |
| Workflow green, ArgoCD green, board still old | Sync not polled yet | Wait one interval, or `kubectl --context k3d-service-platform annotate application blaze -n argocd argocd.argoproj.io/refresh=hard --overwrite` |
| Pod `ImagePullBackOff` | Unlikely — package is public, no pull secret needed. If it happens anyway, check the package wasn't accidentally made private | See `service-platform` → `docs/services/blaze.md` |

## Rolling back

Pin a known-good digest rather than rebuilding.

```sh
gh api user/packages/container/blaze/versions \
  --jq '.[]|select(.metadata.container.tags|length>0)|"\(.metadata.container.tags|join(",")) \(.name)"'
```

Prefer re-running this repo's `Build blaze image` workflow on the commit you want.
If you must edit `deploy/apps/blaze/values-dev.yaml` by hand in `service-platform`
(registry down, CI broken), say so in the commit message — those keys are now
CI-owned, and a silent hand-edit re-creates the exact failure this automation
replaced.
