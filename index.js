#!/usr/bin/env node

/**
 * gh-cross-org-repos-syncer
 *
 * Interactive local CLI that pulls the full contents of a source GitHub
 * organization's repository and opens a Pull Request against a destination
 * GitHub organization's repository, containing that synced code.
 *
 * Nothing about the source/destination org or repo is hardcoded; every run
 * prompts for fresh values, so this works for any org/repo pair.
 *
 * Requires: git, GitHub CLI (`gh`, already authenticated), Node >= 18.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { input, confirm } from "@inquirer/prompts";
import { execa } from "execa";
import ora from "ora";
import chalk from "chalk";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Parses a GitHub repo reference into { org, repo }. Accepts a full URL
 * ("https://github.com/org/repo"), a bare "org/repo" shorthand, or just an
 * org ("org" / "https://github.com/org") in which case repo is undefined.
 */
function parseRepoInput(rawValue) {
  let value = rawValue.trim();
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/^\/+|\/+$/g, "");
  const [org, repo] = value.split("/").filter(Boolean);
  return { org, repo };
}

/** Returns today's date formatted as dd/mm/yyyy, matching the required branch naming. */
function getFormattedDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Thin wrapper around execa that throws a readable error on failure. */
async function run(command, args, options = {}) {
  try {
    return await execa(command, args, { ...options });
  } catch (error) {
    const stderr = error.stderr?.trim();
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`
    );
  }
}

/**
 * Fetches the default branch name and emptiness of a repo ("owner/repo").
 * A repo with zero commits has no `defaultBranchRef` via GraphQL, so the
 * configured branch name is read from the REST API instead, which always
 * reports it even when the repo is empty.
 */
async function getRepoInfo(ownerRepo) {
  let stdout;
  try {
    ({ stdout } = await run("gh", [
      "repo",
      "view",
      ownerRepo,
      "--json",
      "isEmpty,defaultBranchRef",
    ]));
  } catch (error) {
    throw new Error(
      `${error.message}\nCheck that "${ownerRepo}" is spelled correctly and that the currently active gh account (run \`gh auth status\`) has access to it.`
    );
  }

  const { isEmpty, defaultBranchRef } = JSON.parse(stdout);
  if (defaultBranchRef?.name) {
    return { defaultBranch: defaultBranchRef.name, isEmpty: Boolean(isEmpty) };
  }

  const { stdout: restBranch } = await run("gh", ["api", `repos/${ownerRepo}`, "--jq", ".default_branch"]);
  const defaultBranch = restBranch.trim();
  if (!defaultBranch) {
    throw new Error(`Could not resolve a default branch name for ${ownerRepo}.`);
  }
  return { defaultBranch, isEmpty: Boolean(isEmpty) };
}

/** Removes every entry in a directory except the .git folder. */
async function clearDirExceptGit(dir) {
  const entries = await fs.readdir(dir);
  await Promise.all(
    entries
      .filter((entry) => entry !== ".git")
      .map((entry) => fs.rm(path.join(dir, entry), { recursive: true, force: true }))
  );
}

/** Copies every entry from srcDir into destDir except the .git folder. */
async function copyDirExceptGit(srcDir, destDir) {
  const entries = await fs.readdir(srcDir);
  await Promise.all(
    entries
      .filter((entry) => entry !== ".git")
      .map((entry) =>
        fs.cp(path.join(srcDir, entry), path.join(destDir, entry), { recursive: true })
      )
  );
}

/** Confirms git and gh are installed, and gh is authenticated. */
async function checkPrerequisites() {
  await run("git", ["--version"]).catch(() => {
    throw new Error("git is not installed or not on PATH.");
  });

  await run("gh", ["--version"]).catch(() => {
    throw new Error("GitHub CLI (gh) is not installed or not on PATH. See https://cli.github.com");
  });

  const authCheck = await execa("gh", ["auth", "status"], { reject: false });
  if (authCheck.exitCode !== 0) {
    throw new Error(
      "GitHub CLI is not authenticated. Run `gh auth login` first, then re-run this tool."
    );
  }
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  console.log(chalk.bold.cyan("\n=== GitHub Org → Org Repo Syncer ===\n"));

  let tmpRoot = null;
  // Tracks whichever spinner is currently running, so a thrown error can stop it
  // instead of leaving it spinning forever once control reaches the catch block.
  let activeSpinner = null;

  try {
    // --- 1. Prerequisite checks -------------------------------------------
    const prereqSpinner = (activeSpinner = ora("Checking git & GitHub CLI authentication...").start());
    await checkPrerequisites();
    prereqSpinner.succeed("git and gh CLI are ready.");

    // --- 2. Interactive prompts -------------------------------------------
    const sourceInput = await input({
      message: "Source Repository URL (e.g. https://github.com/<org>/<repo>):",
      validate: (value) => {
        const { org, repo } = parseRepoInput(value);
        return org && repo ? true : 'Enter a full repository URL, e.g. "https://github.com/org/repo".';
      },
    });
    const { org: sourceOrg, repo: sourceRepo } = parseRepoInput(sourceInput);

    const destInput = await input({
      message: `Destination Repository URL (e.g. https://github.com/<org>/<repo>; leave the repo out to reuse "${sourceRepo}"):`,
      validate: (value) => {
        const { org } = parseRepoInput(value);
        return org ? true : "Enter at least a destination organization or URL.";
      },
    });
    const { org: destOrg, repo: destRepoParsed } = parseRepoInput(destInput);
    const destRepo = destRepoParsed || sourceRepo;

    const sourceOwnerRepo = `${sourceOrg}/${sourceRepo}`;
    const destOwnerRepo = `${destOrg}/${destRepo}`;

    console.log(
      chalk.yellow(
        `\nAbout to sync:\n  Source:      ${sourceOwnerRepo}\n  Destination: ${destOwnerRepo}\n`
      )
    );
    const proceed = await confirm({ message: "Proceed?", default: true });
    if (!proceed) {
      console.log(chalk.gray("Aborted by user. No changes made."));
      return;
    }

    // --- 3. Resolve repo info ------------------------------------------------
    const infoSpinner = (activeSpinner = ora("Resolving repository info for both repositories...").start());
    const { defaultBranch: sourceDefaultBranch, isEmpty: sourceIsEmpty } = await getRepoInfo(sourceOwnerRepo);
    if (sourceIsEmpty) {
      throw new Error(`Source repository ${sourceOwnerRepo} has no commits yet. There is nothing to sync from.`);
    }
    const { defaultBranch: destDefaultBranch, isEmpty: destIsEmpty } = await getRepoInfo(destOwnerRepo);
    infoSpinner.succeed(
      `Resolved: ${sourceOwnerRepo}@${sourceDefaultBranch} -> ${destOwnerRepo}@${destDefaultBranch}` +
        (destIsEmpty ? " (destination is empty; its default branch will be initialized)" : "")
    );

    // --- 4. Create temp workspace ------------------------------------------
    const workspaceSpinner = (activeSpinner = ora("Creating temporary workspace...").start());
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cross-org-repos-syncer-"));
    const sourceDir = path.join(tmpRoot, "source");
    const destDir = path.join(tmpRoot, "destination");
    workspaceSpinner.succeed(`Temporary workspace created at ${tmpRoot}`);

    // --- 5. Clone source repo (default branch, shallow) --------------------
    const cloneSourceSpinner = (activeSpinner = ora(`Cloning ${sourceOwnerRepo}@${sourceDefaultBranch}...`).start());
    await run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      sourceDefaultBranch,
      `https://github.com/${sourceOwnerRepo}.git`,
      sourceDir,
    ]);
    cloneSourceSpinner.succeed(`Cloned source repository ${sourceOwnerRepo}.`);

    const sourceCommitSha = (
      await run("git", ["rev-parse", "--short", "HEAD"], { cwd: sourceDir })
    ).stdout.trim();

    // --- 6. Clone destination repo, initializing its default branch if empty ---
    const cloneDestSpinner = (activeSpinner = ora(`Cloning ${destOwnerRepo}@${destDefaultBranch}...`).start());
    if (destIsEmpty) {
      // No commits yet, so the default branch ref doesn't exist remotely and
      // `--branch` would fail. Clone plainly, then create and push an empty
      // initial commit so the default branch exists as a base for the PR.
      await run("git", ["clone", `https://github.com/${destOwnerRepo}.git`, destDir]);
      await run("git", ["checkout", "-b", destDefaultBranch], { cwd: destDir });
      await run(
        "git",
        ["commit", "--allow-empty", "-m", `chore: initialize ${destDefaultBranch} branch`],
        { cwd: destDir }
      );
      await run("git", ["push", "-u", "origin", destDefaultBranch], { cwd: destDir });
      cloneDestSpinner.succeed(`Initialized empty destination repository ${destOwnerRepo}@${destDefaultBranch}.`);
    } else {
      await run("git", [
        "clone",
        "--depth",
        "1",
        "--branch",
        destDefaultBranch,
        `https://github.com/${destOwnerRepo}.git`,
        destDir,
      ]);
      cloneDestSpinner.succeed(`Cloned destination repository ${destOwnerRepo}.`);
    }

    // --- 7. Create the working branch --------------------------------------
    // The source commit SHA is appended so multiple syncs on the same day don't collide on branch name.
    const branchName = `updated-push-${getFormattedDate()}/${sourceCommitSha}`;
    const createBranchSpinner = (activeSpinner = ora(`Creating branch "${branchName}"...`).start());
    await run("git", ["checkout", "-b", branchName], { cwd: destDir });
    createBranchSpinner.succeed(`Branch "${branchName}" created.`);

    // --- 8. Sync source content into destination branch --------------------
    const syncSpinner = (activeSpinner = ora("Syncing source code into destination working tree...").start());
    await clearDirExceptGit(destDir);
    await copyDirExceptGit(sourceDir, destDir);
    syncSpinner.succeed("Source code synced into destination working tree.");

    // --- 9. Commit -----------------------------------------------------------
    const commitSpinner = (activeSpinner = ora("Committing changes...").start());
    await run("git", ["add", "-A"], { cwd: destDir });

    const status = await run("git", ["status", "--porcelain"], { cwd: destDir });
    if (!status.stdout.trim()) {
      commitSpinner.fail("No differences found between source and destination. Nothing to sync.");
      return;
    }

    const commitMessage = `chore: updated code pushing from the ${sourceOrg} ${sourceRepo}`;
    await run("git", ["commit", "-m", commitMessage], { cwd: destDir });
    commitSpinner.succeed(`Committed: "${commitMessage}"`);

    // --- 10. Push --------------------------------------------------------------
    const pushSpinner = (activeSpinner = ora(`Pushing "${branchName}" to ${destOwnerRepo}...`).start());
    await run("git", ["push", "-u", "origin", branchName], { cwd: destDir });
    pushSpinner.succeed(`Pushed "${branchName}" to ${destOwnerRepo}.`);

    // --- 11. Open the Pull Request ----------------------------------------------
    const prSpinner = (activeSpinner = ora("Creating Pull Request...").start());
    const prBody = [
      `Automated Sync from \`${sourceOwnerRepo}\` (branch \`${sourceDefaultBranch}\`) into \`${destOwnerRepo}\`.`,
      "",
      `- Source: ${sourceOwnerRepo}`,
      `- Source commit: ${sourceCommitSha}`,
      `- Destination: ${destOwnerRepo}`,
      `- Synced on: ${getFormattedDate()}`,
      "",
      "_Generated by gh-cross-org-repos-syncer._",
    ].join("\n");

    const prResult = await run(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        destOwnerRepo,
        "--base",
        destDefaultBranch,
        "--head",
        branchName,
        "--title",
        commitMessage,
        "--body",
        prBody,
      ],
      { cwd: destDir }
    );
    prSpinner.succeed("Pull Request created.");

    console.log(chalk.bold.green(`\nDone! ${prResult.stdout.trim()}\n`));
  } catch (error) {
    if (activeSpinner?.isSpinning) {
      activeSpinner.fail("Step failed.");
    }
    console.error(chalk.bold.red(`\nError: ${error.message}\n`));
    process.exitCode = 1;
  } finally {
    // --- 12. Cleanup temp workspace no matter what ---------------------------
    if (tmpRoot) {
      const cleanupSpinner = ora("Cleaning up temporary files...").start();
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
        cleanupSpinner.succeed("Temporary files removed.");
      } catch (cleanupError) {
        cleanupSpinner.fail(`Failed to remove temporary directory ${tmpRoot}: ${cleanupError.message}`);
      }
    }
  }
}

main();
