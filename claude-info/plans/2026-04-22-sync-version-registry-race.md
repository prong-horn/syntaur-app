---
title: Fix Sync Syntaur Version workflow registry race
date: 2026-04-22
status: draft
---

# Fix: `Sync Syntaur Version` fails with `ETARGET` right after a syntaur release

## Problem

When `prong-horn/syntaur` publishes a new version to npm, its CI fires a `repository_dispatch` event (`syntaur-published`) at this repo. Our `Sync Syntaur Version` workflow immediately runs `npm install syntaur@<version> --save-exact`, which sometimes fails with:

```
npm error code ETARGET
npm error notarget No matching version found for syntaur@0.4.0.
```

Cause: the dispatch is sent the instant `npm publish` finishes, but the npm registry needs a few seconds to index the new version. The install call beats the index and gets `ETARGET`.

Recent runs showing the race: 0.3.3 and 0.4.0 failed; 0.4.1 happened to win the race and passed. The current pass/fail is flaky — we cannot rely on it.

## Goal

Make `Sync Syntaur Version` succeed reliably for every published `syntaur` version, without requiring manual reruns. Keep the workflow simple — no moving the fix to the publisher repo (syntaur) for now, since a consumer-side retry is the right-shaped fix (defensive against any future publisher timing changes).

## Non-goals

- Do not change `syntaur`'s `publish.yml` (a 30s pre-dispatch sleep would work but only for syntaur-initiated runs; consumer-side fix is more robust).
- Do not retry on other npm failures (network blip, 5xx). Scope retry to the specific "version not yet visible" case.
- Do not bump or rename the workflow — keep the file at `.github/workflows/sync-syntaur.yml`.

## Approach

Add a short poll step BEFORE `npm install` that waits until `npm view syntaur@<version> version` resolves to a matching version, with a bounded timeout. If the timeout is hit, fail loudly — the registry is genuinely down, not just slow.

Implementation choice: `npm view` (HEAD-equivalent) rather than `npm install` as the probe. Reasons:
- `npm view` is cheap — a single JSON GET against the registry.
- `npm install` has side effects (writes to `node_modules`, runs scripts) we don't want to do N times just to probe.
- `npm view syntaur@0.4.0 version` prints the version on success and exits non-zero on ETARGET, so it fits directly into a retry loop.

## Tasks

### 1. Add a "Wait for npm registry" step

In `.github/workflows/sync-syntaur.yml`, insert between "Determine version" and "Update syntaur dependency":

```yaml
      - name: Wait for npm registry to index version
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          ATTEMPTS=20          # 20 tries
          INTERVAL=6           # 6 seconds apart → ~120s max wait
          for i in $(seq 1 $ATTEMPTS); do
            if npm view "syntaur@$VERSION" version >/dev/null 2>&1; then
              echo "syntaur@$VERSION is live on the registry (attempt $i)."
              exit 0
            fi
            echo "Attempt $i/$ATTEMPTS: syntaur@$VERSION not yet on registry; sleeping ${INTERVAL}s..."
            sleep "$INTERVAL"
          done
          echo "ERROR: syntaur@$VERSION never appeared on the registry after $((ATTEMPTS * INTERVAL))s." >&2
          exit 1
```

- 120s total budget is well beyond the observed few-second index delay, and short enough that a truly broken registry is flagged within reasonable CI runtime.
- `>/dev/null 2>&1` so the loop doesn't spam every attempt's output.
- Exits 0 and moves to the install step as soon as the version resolves.

### 2. Leave `Update syntaur dependency` alone

After step 1 passes, the existing `npm install "syntaur@..." --save-exact --ignore-scripts` call will succeed on the first try. No retries needed there.

### 3. Manually re-run the dispatch for 0.4.1

After deploying the fix, trigger `workflow_dispatch` with `version=0.4.1` to confirm the happy path still works. Not strictly necessary since 0.4.1 already synced, but a good smoke test.

```bash
gh workflow run sync-syntaur.yml --repo prong-horn/syntaur-app \
  --field version=0.4.1
```

Expect: "Wait for npm registry" exits on attempt 1 immediately; rest of workflow is a no-op since `package.json` is already at `0.4.1`.

### 4. Backfill any failed syncs

`v0.3.3` and `v0.4.0` dispatches both failed. If the syntaur-app repo doesn't have a tag for those versions yet, re-run them via `workflow_dispatch`:

```bash
gh workflow run sync-syntaur.yml --repo prong-horn/syntaur-app --field version=0.3.3
gh workflow run sync-syntaur.yml --repo prong-horn/syntaur-app --field version=0.4.0
```

(0.4.1 should already be synced per the successful 24781301800 run.)

### 5. Verify

After the next real release dispatch from `syntaur`:
- Green checkmark email instead of red X
- `package.json` on `syntaur-app` main shows the new `syntaur` version
- A `v<new-version>` tag exists on `syntaur-app`

## Rollout

1. Edit `.github/workflows/sync-syntaur.yml` locally.
2. Commit: `ci: wait for npm registry index before syncing syntaur version`.
3. Push to `main`.
4. Run tasks 3 and 4.
5. Wait for the next real syntaur release to confirm the fix in production.

## Risks

- **Registry down for >2 minutes during a real release** — fix fails loudly (exit 1), email still fires, but now it's a legitimate "registry is broken" signal rather than a flaky timing failure. That's the correct failure mode.
- **Network quirk making `npm view` fail even when the version IS indexed** — unlikely given GitHub Actions runners' connectivity, but in the worst case we re-run the dispatch manually. Same escape hatch we have today.

## Alternative considered and rejected

Sleeping 30s in `syntaur`'s `publish.yml` before the `repository-dispatch` step would also fix this, but:
- It's a fixed wait that's sometimes too short (if the registry is slow) and usually too long (registry usually indexes in <10s).
- It only helps `syntaur`-initiated syncs; any other future dispatcher (e.g., a manual trigger from a script) would still hit the race.
- The consumer-side poll is self-healing — it stops as soon as the version is visible, so no wasted CI time.
