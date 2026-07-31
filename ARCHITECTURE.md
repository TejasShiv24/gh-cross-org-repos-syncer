# Architecture

`gh-cross-org-repos-syncer` has no server, no CI, and no persistent state. It is a single Node.js process that shells out to `git` and `gh` on your machine, using your own authenticated GitHub CLI session.

![Architecture diagram: source GitHub org, your local machine, and destination GitHub org](docs/architecture.svg)

## Flow

1. **CLI prompts.** `update` asks for the source org/repo and destination org/repo (destination repo name defaults to the source repo name if left blank).
2. **Prerequisite checks.** The tool verifies `git` and `gh` are installed and that `gh auth status` succeeds before touching any repository.
3. **Resolve default branches.** `gh repo view` is used to look up the default branch of both the source and destination repositories, so the tool never assumes `main`.
4. **Temporary workspace.** A temp directory is created (`os.tmpdir()`), and both repositories are shallow-cloned into it: the source repo's default branch and the destination repo's default branch.
5. **Mirror sync.** The destination working tree (excluding `.git`) is cleared and replaced with the source working tree. This is a full mirror, not a merge.
6. **Branch, commit, push.** A branch named `updated-push-<dd/mm/yyyy>/<source-commit-sha>` is created off the destination repo. The commit message is `chore: updated code pushing from the <source-org> <source-repo>`. The branch is pushed to the destination repository.
7. **Pull Request.** `gh pr create` opens a PR in the destination repository targeting its default branch, so a human reviews the diff before it merges.
8. **Cleanup.** The temporary workspace is removed whether the run succeeds or fails.

## Why the branch name includes the commit SHA

Using the sync date alone (`updated-push-<dd/mm/yyyy>`) meant two syncs on the same day would try to reuse the same branch name and collide. Appending the source repo's short commit SHA (read right after cloning it) keeps branch names unique per source state, while still being human-readable and sorted by day.

## No hidden state

Nothing is written outside the temp workspace, and the temp workspace never survives the run. Every invocation of `update` is independent: same org, different org, same repo, different repo, it doesn't matter, because none of it is hardcoded or cached between runs.
