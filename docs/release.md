# Release Checklist

This repo publishes two artifacts for each release:

- npm package: `@tasselx/pi-web`
- GitHub Release: `tasselx/pi-web`

Pushing a `v*.*.*` tag starts the `Release & Publish` workflow (`.github/workflows/release.yml`): it builds from a clean checkout, creates the GitHub Release and publishes the npm package through OIDC (npm Trusted Publishing). This checklist prepares that tag and then writes the release notes. Do not run `npm publish` or `npm run release` yourself: npm rejects a second publish of the same version, so the workflow's publish step would fail.

Use this checklist from a clean `main` checkout.

## 1. Preflight

```bash
git fetch origin
git status --short --branch
git log --oneline --decorate -5
git rev-list --left-right --count main...origin/main
gh auth status
node -e "const p=require('./package.json'); console.log(p.version)"
gh run list --workflow CI --branch main --limit 1
```

Expected:

- `git status` is clean, or only contains changes you intentionally plan to release.
- `main` and `origin/main` are aligned (`0	0`).
- GitHub is authenticated as an account that can push and create releases.
- The latest `CI` run on `main` succeeded, and every commit meant for this release is already on `origin/main`: a commit that exists only locally (a merge, say) has had no CI run, so push `main` and wait for CI first. The release workflow runs lint, `tsc` and the tests again, but a red `main` is cheaper to fix before the tag exists.
- No local build is needed: the workflow builds from a clean checkout, so a running `npm run dev`, leftovers in `.next/` and npm credentials on this machine do not matter.

Before bumping, confirm the next version is free (replace `<version>`):

```bash
npm view @tasselx/pi-web@<version> version --registry https://registry.npmjs.org/   # expect E404
git ls-remote --tags origin v<version>                                            # expect empty
```

## 2. Bump the Version

Choosing the bump: look at `git log --oneline v<previous>..HEAD`. A batch of `feat:` commits (new UI, new commands, new settings) is a minor; only fixes and small adjustments is a patch. Decide before bumping, since a published version cannot be reused.

Set the new version without building or publishing anything on this machine:

```bash
npm version <x.y.z> --no-git-tag-version
git diff --numstat -- package.json package-lock.json
```

Expect `1 1` for `package.json` (the version line) and `2 2` for `package-lock.json` (its two version fields). Anything else means more than the bump changed: revert and look. The workflow builds and publishes from the tag in step 4, so there is no `npm run build` or `npm publish` here.

## 3. Commit the Version Bump

Replace `<version>` with the new package version, for example `0.7.5`.

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v<version>"
```

Stage only those two files (`git diff --cached --name-only` lists exactly them). A block `next dev` appended to `AGENTS.md`, for one, stays out of the release commit.

## 4. Tag and Push

```bash
git tag -a v<version> -m "v<version>"
git push origin main v<version>
```

Push the release tag by name. Do not use `git push --tags`: the local checkout holds tags fetched from contributor forks that are not on origin, and `--tags` publishes them (it leaked a stray `v0.10.5`, on a commit that is on no branch, during the v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags origin` first.

Confirm the tag does not already exist before creating it when unsure:

```bash
git ls-remote --tags origin v<version>
gh release view v<version> --repo tasselx/pi-web
```

Pushing the tag starts the `Release & Publish` workflow. It installs from a clean checkout, runs `npm run lint`, `npx tsc --noEmit` and `npm test`, builds with `npm run build`, creates the GitHub Release with generated notes (only a "Full Changelog" link) and publishes `@tasselx/pi-web` to npm through OIDC. It takes about 4 to 6 minutes. Watch it:

```bash
gh run list --workflow release.yml --limit 3
gh run watch <run-id> --exit-status
```

The same push to `main` also redeploys the demo (`demo-pages.yml`), since the release commit changes `package.json`.

A newly published version may take a few minutes to show up (the publish step says so itself). `npm view @tasselx/pi-web@<version> version` can return E404 and `npm view @tasselx/pi-web version` can show the previous version even though the publish step printed `+ @tasselx/pi-web@<version>`. This is registry propagation, not a failed publish: do not publish again. Poll the registry until the version appears:

```bash
curl -s https://registry.npmjs.org/@tasselx%2Fpi-web/<version> | head -c 80   # JSON once it exists, "version not found" before
npm view @tasselx/pi-web dist-tags --registry https://registry.npmjs.org/
npm view @tasselx/pi-web versions --json --registry https://registry.npmjs.org/
```

### Pushed the tag too early

If the tag went out before the release was ready (a commit still missing, say), cancel the run before its `Publish to npm` step:

```bash
gh run cancel <run-id>
curl -s https://registry.npmjs.org/@tasselx%2Fpi-web/<version> | head -c 80   # still "version not found"
```

Nothing is published yet, but a tag that is already on origin is better not rewritten: fix the cause on `main` and release the next patch instead. The unpublished `v<version>` tag stays on origin, so base the next release notes on the last version that was published and say there that the skipped tag was never released. The workflow creates the GitHub Release before it publishes, so a run cancelled after that step also leaves a release page for a version npm does not have: `gh release delete v<version> --repo tasselx/pi-web` removes it.

## 5. Generate Release Notes from Commits

Use the previous release tag as the base.

```bash
git log --oneline --decorate v<previous>..v<version>
git log --format='%h%x09%s%n%b' v<previous>..v<version>
git diff --stat v<previous>..v<version>
```

Write the release notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Thank outside contributors by name: `git log --format='%h %an | %s' v<previous>..v<version>` lists authors, and the previous release's notes show the style.
- Open with the install/upgrade command (`npm install -g @tasselx/pi-web@latest`), as earlier releases did.
- Write the notes to a file outside the repo (for example `NOTES=$(mktemp)`), or pass them through stdin as shown below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 `v<previous>..v<version>` 的提交整理。

### 新增

- ...

### 修复

- ...

### 改进

- ...

### 内部调整

- 发布 npm 包 `@tasselx/pi-web@<version>`。

## English

Prepared from commits in `v<previous>..v<version>`.

### Added

- ...

### Fixed

- ...

### Improved

- ...

### Internal

- Published npm package `@tasselx/pi-web@<version>`.
```

## 6. Update the GitHub Release

The workflow already created the release in step 4. Its generated notes are only a "Full Changelog" link; replace them with the notes from step 5:

```bash
gh release edit v<version> \
  --repo tasselx/pi-web \
  --notes-file "$NOTES"
```

You can avoid a temporary file by passing notes through stdin:

```bash
gh release edit v<version> --repo tasselx/pi-web --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

If the workflow did not create the release, create it by hand (`--verify-tag` refuses a tag that is not on origin):

```bash
gh release create v<version> \
  --repo tasselx/pi-web \
  --verify-tag \
  --title "v<version>" \
  --notes-file "$NOTES"
```

## 7. Final Verification

```bash
gh run list --limit 4
gh release view v<version> --repo tasselx/pi-web
npm view @tasselx/pi-web@<version> version --registry https://registry.npmjs.org/
npm view @tasselx/pi-web dist-tags --registry https://registry.npmjs.org/
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags origin
```

Expected:

- The `Release & Publish` run for the tag and the `CI` run for the release commit succeeded. `Demo`, which the release commit triggers because it changes `package.json`, should be green too.
- GitHub Release exists, carries the notes from step 6 and is not a draft unless intentionally published as one.
- npm exact version resolves and `latest` points at it (allow a few minutes, see step 4).
- `git ls-remote --tags origin` shows no tag you did not mean to publish.
- `main` is aligned with `origin/main`.
- `HEAD` points at the release commit and `v<version>` tag.
