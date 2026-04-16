# Syntaur App Sync and Auto-Update Pipeline

**Date:** 2026-04-15
**Complexity:** small
**Tech Stack:** TypeScript, Electron 34, Electron Forge + Vite, GitHub Actions, update-electron-app

## Objective
Wire up an automated pipeline so that when syntaur publishes a new npm version (via `v*` tag), syntaur-app automatically bumps its dependency, mirrors the version, creates a matching tag, and triggers existing mac/windows release workflows -- delivering auto-updates to end users via `update.electronjs.org`.

## Full Automation Chain
```
syntaur: git tag v0.1.14 && git push --tags
  → syntaur CI (publish.yml): typecheck + test + npm publish
  → syntaur CI (publish.yml): repository_dispatch to prong-horn/syntaur-app
  → syntaur-app CI (sync-syntaur.yml):
      - npm install syntaur@0.1.14 --save-exact --ignore-scripts
      - set version to 0.1.14 in package.json
      - git commit + git tag v0.1.14 + git push
  → syntaur-app CI (mac-release.yml + windows-release.yml):
      - build macOS DMG/ZIP + Windows exe/nupkg
      - upload to GitHub Release
  → End user's running app:
      - update-electron-app checks update.electronjs.org every 10 min
      - Detects new release, downloads, prompts user to restart
```

## Files
| File | Action | Purpose |
|------|--------|---------|
| `~/syntaur-app/package.json` | MODIFY | Switch syntaur dep from tarball to registry; bump version to 0.1.13 |
| `~/syntaur-app/syntaur-0.1.8.tgz` | DELETE | Remove stale committed tarball |
| `~/syntaur-app/.gitignore` | MODIFY | Add `syntaur-*.tgz` pattern to prevent future tarball commits |
| `~/syntaur-app/.github/workflows/sync-syntaur.yml` | CREATE | New workflow: receive dispatch from syntaur, bump dep + version, tag, push |
| `~/syntaur/.github/workflows/publish.yml` | MODIFY | Add repository_dispatch step after npm publish to notify syntaur-app |

## Tasks

### Task 1: Switch syntaur dependency to npm registry

**File:** `~/syntaur-app/package.json` (MODIFY)

**Changes:**
1. Line 4: Change `"version": "0.1.0"` to `"version": "0.1.13"` (mirror current syntaur version)
2. Line 25: Change `"syntaur": "file:syntaur-0.1.8.tgz"` to `"syntaur": "0.1.13"` (exact pin, no caret — versions are controlled by the sync workflow, not semver ranges)

**Verify:**
```bash
cd ~/syntaur-app && npm install --ignore-scripts && npm ls syntaur
# Should show syntaur@0.1.13
```

Note: Use `--ignore-scripts` for verification since `postinstall` includes `electron-rebuild` and `codesign` which require native build tools and macOS respectively. Full `npm ci` (with postinstall) is tested separately on macOS.

### Task 2: Delete stale tarball and update gitignore

**File:** `~/syntaur-app/syntaur-0.1.8.tgz` (DELETE)
**File:** `~/syntaur-app/.gitignore` (MODIFY)

**Changes:**
1. Delete `syntaur-0.1.8.tgz` from the repo root
2. Add `syntaur-*.tgz` line to `.gitignore` after the existing "Dependencies" comment block (after line 2, before the blank line on line 3)

**Updated .gitignore:**
```
# Dependencies
node_modules/
syntaur-*.tgz
```

**Verify:**
```bash
ls ~/syntaur-app/syntaur-*.tgz  # Should return "No such file"
echo "syntaur-test.tgz" | git -C ~/syntaur-app check-ignore --stdin  # Should output the filename
```

### Task 3: Create sync-syntaur workflow in syntaur-app

**File:** `~/syntaur-app/.github/workflows/sync-syntaur.yml` (CREATE)

**Why this design:**
- Triggered by `repository_dispatch` with event type `syntaur-published` (fired by syntaur's publish workflow)
- Also supports `workflow_dispatch` with a version input for manual triggering
- Uses `--ignore-scripts` during `npm install` because the runner is ubuntu-latest and the postinstall includes macOS-only `codesign` and `electron-rebuild` (which needs native build tools). The actual builds happen in mac-release.yml and windows-release.yml on their respective OS runners.
- Mirrors the syntaur version into the app's own version field
- Commits, tags, and pushes — the `v*` tag triggers the existing mac-release.yml and windows-release.yml workflows

**Full file content:**
```yaml
name: Sync Syntaur Version

on:
  repository_dispatch:
    types: [syntaur-published]
  workflow_dispatch:
    inputs:
      version:
        description: 'Syntaur version to sync (without v prefix)'
        required: true

permissions:
  contents: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Determine version
        id: version
        run: |
          if [ "${{ github.event_name }}" = "repository_dispatch" ]; then
            VERSION="${{ github.event.client_payload.version }}"
          else
            VERSION="${{ github.event.inputs.version }}"
          fi
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      - name: Update syntaur dependency
        run: npm install "syntaur@${{ steps.version.outputs.version }}" --save-exact --ignore-scripts

      - name: Mirror app version
        run: npm version "${{ steps.version.outputs.version }}" --no-git-tag-version

      - name: Commit and tag
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add package.json package-lock.json
          git commit -m "chore: sync syntaur v${{ steps.version.outputs.version }}"
          git tag "v${{ steps.version.outputs.version }}"

      - name: Push changes and tag
        run: git push origin main --follow-tags
```

**Key design decisions:**
- `--ignore-scripts` avoids postinstall failures on Linux (codesign, electron-rebuild)
- `npm version --no-git-tag-version` updates package.json without creating a git tag (we create our own tag with the commit message we want)
- `--follow-tags` pushes both the commit and the annotated tag in one push, which triggers mac-release.yml and windows-release.yml
- `workflow_dispatch` allows manual version sync if the automated dispatch ever fails

### Task 4: Add repository_dispatch to syntaur publish workflow

**File:** `~/syntaur/.github/workflows/publish.yml` (MODIFY)

**What:** Add a new step after the existing `npm publish` step that sends a `repository_dispatch` event to `prong-horn/syntaur-app`.

**Add after line 51 (`run: npm publish`):**
```yaml

      - name: Notify syntaur-app
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.SYNTAUR_APP_DISPATCH_PAT }}
          repository: prong-horn/syntaur-app
          event-type: syntaur-published
          client-payload: '{"version": "${{ github.ref_name }}"}'
```

**Wait — `github.ref_name` includes the `v` prefix** (e.g., `v0.1.14`). The sync workflow expects a version WITHOUT the prefix. Fix: strip it in the payload.

**Corrected step:**
```yaml
      - name: Notify syntaur-app
        env:
          VERSION: ${{ github.ref_name }}
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.SYNTAUR_APP_DISPATCH_PAT }}
          repository: prong-horn/syntaur-app
          event-type: syntaur-published
          client-payload: '{"version": "${VERSION#v}"}'
```

**Actually, GitHub Actions doesn't support shell parameter expansion in `with:` blocks.** Need to use a prior step:

```yaml
      - name: Extract version
        id: extract
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Notify syntaur-app
        uses: peter-evans/repository-dispatch@v3
        with:
          token: ${{ secrets.SYNTAUR_APP_DISPATCH_PAT }}
          repository: prong-horn/syntaur-app
          event-type: syntaur-published
          client-payload: '{"version": "${{ steps.extract.outputs.version }}"}'
```

**Verify:** After pushing a `v*` tag to syntaur, check:
1. syntaur Actions tab: publish job succeeds, dispatch step shows 204 response
2. syntaur-app Actions tab: sync-syntaur workflow fires, commits, tags, pushes
3. syntaur-app Actions tab: mac-release and windows-release workflows fire from the new tag

## Dependencies / Manual Prerequisites

1. **GitHub PAT Secret:** Create a fine-grained Personal Access Token:
   - Scoped to `prong-horn/syntaur-app` repository
   - Permission: `Contents: Read and write` (needed for `repository_dispatch`)
   - Store as `SYNTAUR_APP_DISPATCH_PAT` in `prong-horn/syntaur` repo secrets
   - This must be done manually in GitHub Settings before the pipeline works end-to-end

2. **No new npm packages needed** — `update-electron-app` is already configured and works with public repos using default settings.

## Verification Checklist

- [ ] `cd ~/syntaur-app && npm install --ignore-scripts && npm ls syntaur` shows `syntaur@0.1.13`
- [ ] `cd ~/syntaur-app && npm run start` — app starts with registry-installed syntaur
- [ ] `syntaur-0.1.8.tgz` no longer exists in repo
- [ ] `.gitignore` blocks future `*.tgz` files
- [ ] `sync-syntaur.yml` can be manually triggered via `workflow_dispatch` with a version input
- [ ] Full chain test: push a `v*` tag to syntaur → publish → dispatch → sync → release builds
