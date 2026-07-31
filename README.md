# gh-cross-org-repos-syncer

`gh-cross-org-repos-syncer` is a small command line tool that helps you synchronize code between repositories that belong to different GitHub organizations.

The tool runs entirely on your local machine. It copies the contents of a source repository into a destination repository, creates a new branch, pushes the changes, and opens a Pull Request for review. Since every sync goes through a Pull Request, you can review the changes before they are merged.

The project was originally built to simplify synchronizing repositories across organizations without relying on GitHub Actions, repository secrets, or custom automation. It has since been made generic so it can be used with any GitHub organizations and repositories.

If you'd like to know why this project exists and how it differs from other approaches, see [WHY_UNIQUE.md](WHY_UNIQUE.md). For a diagram of how the pieces fit together, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

Before using the tool, make sure you have the following installed.

* Node.js 18 or later
* Git
* GitHub CLI (`gh`)

You should also be authenticated with GitHub CLI and have access to both the source and destination repositories.

## Installation

From the project directory, run:

```bash
bash setup.sh
```

The setup script will:

1. Check whether Git is installed.
2. Check whether GitHub CLI is installed.
3. Verify that GitHub CLI is authenticated.
4. Start `gh auth login` if authentication is required.
5. Install the project dependencies.
6. Link the package globally so the `update` command is available from anywhere.

## Usage

Once the setup is complete, simply run:

```bash
update
```

The tool will ask for:

* Source Repository URL, e.g. `https://github.com/<org>/<repo>` (a bare `org/repo` also works)
* Destination Repository URL, in the same format

For the destination, you can leave the repository part out (just give the org, or its URL) and the source repository name will be reused automatically.

## What happens during a sync

After you provide the repository details, the tool will:

1. Resolve the default branch of both repositories, and detect whether the destination repository is empty.
2. Clone both repositories into a temporary directory. If the destination repository has no commits yet, its default branch is initialized first (an empty commit is pushed to create it) so there is a base for the Pull Request.
3. Create a new branch in the destination repository, named `updated-push-<dd/mm/yyyy>/<source-commit-sha>` so multiple syncs on the same day don't collide.
4. Replace the destination repository contents with the source repository contents.
5. Create a commit describing the synchronization.
6. Push the new branch.
7. Open a Pull Request against the destination repository's default branch.
8. Remove all temporary files before exiting.

## Notes

The synchronization replaces the destination repository's working tree with the contents of the source repository, excluding the Git metadata. This means the Pull Request should always be reviewed before merging.

If the source repository has no commits, the sync fails immediately since there is nothing to copy. Only the destination repository is initialized automatically when empty.

The tool does not store repository information between runs. Every execution is independent, so you can use it with different organizations and repositories each time.

Authentication is handled entirely through your existing GitHub CLI session. No Personal Access Tokens or repository secrets are required.

Everything runs locally. There are no GitHub Actions, runners, or external services involved.

## Uninstall

If you no longer need the tool, you can remove it with:

```bash
npm unlink -g gh-cross-org-repos-syncer
```