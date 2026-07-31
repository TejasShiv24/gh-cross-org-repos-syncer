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

/** Strip protocol/host/trailing slash from an org input so users can paste
 *  either a bare org name ("my-org") or a full URL ("https://github.com/my-org"). */
function normalizeOrg(rawValue) {
  let value = rawValue.trim();
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  value = value.replace(/\/+$/, "");
  // In case a full repo URL was pasted (org/repo), only keep the org segment.
  value = value.split("/")[0];
  return value;
}

function requireNonEmpty(message) {
  return (value) => (value.trim().length > 0 ? true : message);
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

/** Fetches the default branch (main/master/etc.) for a given "org/repo". */
async function getDefaultBranch(ownerRepo) {
  const { stdout } = await run("gh", [
    "repo",
    "view",
    ownerRepo,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]);
  const branch = stdout.trim();
  if (!branch) {
    throw new Error(`Could not resolve default branch for ${ownerRepo}. Does the repo exist and is it accessible?`);
  }
  return branch;
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

  try {
    // --- 1. Prerequisite checks -------------------------------------------
    const prereqSpinner = ora("Checking git & GitHub CLI authentication...").start();
    await checkPrerequisites();
    prereqSpinner.succeed("git and gh CLI are ready.");

    // --- 2. Interactive prompts -------------------------------------------
    const sourceOrgRaw = await input({
      message: "Source GitHub Organization (name or full URL):",
      validate: requireNonEmpty("Source organization is required."),
    });
    const sourceOrg = normalizeOrg(sourceOrgRaw);

    const sourceRepo = (
      await input({
        message: "Source Repository Name:",
        validate: requireNonEmpty("Source repository name is required."),
      })
    ).trim();

    const destOrgRaw = await input({
      message: "Destination GitHub Organization (name or full URL):",
      validate: requireNonEmpty("Destination organization is required."),
    });
    const destOrg = normalizeOrg(destOrgRaw);

    const destRepoInput = (
      await input({
        message: `Destination Repository Name (leave blank to reuse "${sourceRepo}"):`,
      })
    ).trim();
    const destRepo = destRepoInput || sourceRepo;

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

    // --- 3. Resolve default branches --------------------------------------
    const branchSpinner = ora("Resolving default branches for both repositories...").start();
    const sourceDefaultBranch = await getDefaultBranch(sourceOwnerRepo);
    const destDefaultBranch = await getDefaultBranch(destOwnerRepo);
    branchSpinner.succeed(
      `Default branches resolved: ${sourceOwnerRepo}@${sourceDefaultBranch} -> ${destOwnerRepo}@${destDefaultBranch}`
    );

    // --- 4. Create temp workspace ------------------------------------------
    const workspaceSpinner = ora("Creating temporary workspace...").start();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gh-cross-org-repos-syncer-"));
    const sourceDir = path.join(tmpRoot, "source");
    const destDir = path.join(tmpRoot, "destination");
    workspaceSpinner.succeed(`Temporary workspace created at ${tmpRoot}`);

    // --- 5. Clone source repo (default branch, shallow) --------------------
    const cloneSourceSpinner = ora(`Cloning ${sourceOwnerRepo}@${sourceDefaultBranch}...`).start();
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

    // --- 6. Clone destination repo (default branch, shallow) ---------------
    const cloneDestSpinner = ora(`Cloning ${destOwnerRepo}@${destDefaultBranch}...`).start();
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

    // --- 7. Create the working branch --------------------------------------
    // The source commit SHA is appended so multiple syncs on the same day don't collide on branch name.
    const branchName = `updated-push-${getFormattedDate()}/${sourceCommitSha}`;
    const createBranchSpinner = ora(`Creating branch "${branchName}"...`).start();
    await run("git", ["checkout", "-b", branchName], { cwd: destDir });
    createBranchSpinner.succeed(`Branch "${branchName}" created.`);

    // --- 8. Sync source content into destination branch --------------------
    const syncSpinner = ora("Syncing source code into destination working tree...").start();
    await clearDirExceptGit(destDir);
    await copyDirExceptGit(sourceDir, destDir);
    syncSpinner.succeed("Source code synced into destination working tree.");

    // --- 9. Commit -----------------------------------------------------------
    const commitSpinner = ora("Committing changes...").start();
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
    const pushSpinner = ora(`Pushing "${branchName}" to ${destOwnerRepo}...`).start();
    await run("git", ["push", "-u", "origin", branchName], { cwd: destDir });
    pushSpinner.succeed(`Pushed "${branchName}" to ${destOwnerRepo}.`);

    // --- 11. Open the Pull Request ----------------------------------------------
    const prSpinner = ora("Creating Pull Request...").start();
    const prBody = [
      `Automated sync from \`${sourceOwnerRepo}\` (branch \`${sourceDefaultBranch}\`) into \`${destOwnerRepo}\`.`,
      "",
      `- Source: ${sourceOwnerRepo}`,
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
