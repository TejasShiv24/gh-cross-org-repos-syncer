# Why `gh-cross-org-repos-syncer`?

There are already several ways to keep repositories synchronized across GitHub organizations. GitHub Actions, repository mirroring, and fork-based workflows all solve this problem in different ways.

While working with repositories spread across multiple organizations, I found that most of these solutions were more complex than needed. Some depended on GitHub Actions and repository secrets, others pushed changes directly without a review step, and many expected repositories to be connected through official fork relationships.

I wanted something much simpler.

The goal of this project was to create a tool that could be run directly from a terminal whenever synchronization was needed. It should work with any repositories, require almost no setup, and always create a Pull Request instead of updating the destination repository directly.

That idea became **`gh-cross-org-repos-syncer`**.

---

## How It Is Different

| Capability | Common Approaches | `gh-cross-org-repos-syncer` |
| :--- | :--- | :--- |
| **Execution** | GitHub Actions or repository mirroring | Local command-line tool |
| **Review Process** | Often pushes directly or relies on custom CI | Always creates a Pull Request |
| **Authentication** | Requires Personal Access Tokens or Secrets | Uses your existing GitHub CLI (`gh`) session |
| **Configuration** | Stored in hardcoded workflow files | Entered interactively at runtime |
| **Reusability** | Tied to specific repositories | Works with ANY GitHub organizations and repos |

---

## Key Advantages

### 1. Pull Requests Instead of Direct Updates
Synchronization should never bypass code review. Instead of pushing directly to the destination branch, the tool creates a new branch named after the sync date and the source commit SHA (so multiple syncs on the same day never collide) and opens a Pull Request. This gives reviewers a clear diff to inspect before anything is merged.

### 2. No Configuration to Maintain
There are no configuration files or static paths to manage. The tool interactively prompts for a source repository URL and a destination repository URL on each run (a bare `org/repo` works too), making it completely state-free and reusable across different organizations.

### 3. Everything Runs Locally
The tool runs entirely on your local machine using Git and the GitHub CLI. There are no GitHub Actions minutes consumed, no workflow files to update, and no external infrastructure required.

### 4. Simple Authentication
Authentication is handled natively through the GitHub CLI. As long as you are signed in via `gh auth login`, the tool uses your active session for all Git and GitHub operations no need to generate, manage, or expose Personal Access Tokens.

### 5. Automatic Workspace Cleanup
Repositories are cloned and processed inside an isolated temporary system directory. Once synchronization completes (or if an error occurs), the temporary directory is cleaned up automatically.

### 6. Works Even Against a Brand-New Destination Repo
Most sync approaches assume the destination already has commits. If the destination repository is empty, the tool initializes its default branch first, then still opens a Pull Request into it, rather than failing or silently pushing all the source content directly.

---

## A Tool That Stays Out of Your Way

This project is intentionally focused and lightweight. It does one job well: synchronizing one repository into another via a Pull Request. 

There is no project-specific configuration, no hidden state, and no assumptions about how your repositories are structured. You provide the repository details at runtime, and the tool handles the rest.