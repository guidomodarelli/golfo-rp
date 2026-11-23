/**
 * Decides whether Vercel builds a commit (`vercel.json` → `ignoreCommand`).
 *
 * A commit ships when its stable `X.Y.Z` version differs from the previous
 * commit's version, in either direction: a release raises it and a rollback
 * lowers it. Which version comes next is `create-version`'s rule, not the gate's:
 * it refuses a version whose tag already exists. An unchanged version and any
 * prerelease or build-metadata version skip the build. When the previous version
 * cannot be read there is nothing to compare, so a stable version builds.
 *
 * A release delegated to CI is skipped only on the commit that changes
 * `.golfo-rp/release.json` against its first parent, the same commit scoping the
 * generated `.golfo-rp/vercel-ignore-build.mjs` applies (that template stays
 * dependency-free, so it inlines the check). Later commits keep the metadata
 * untouched and fall through to the version rule. Without a readable parent
 * (shallow clone or first commit) the release commit is recognized by its own
 * `Golfo-Rp-Execution: ci` trailer, which later commits never carry, so the
 * deployment still waits for the release workflow. A CI release never lowers the
 * version, so a rollback that restores an older `.golfo-rp/release.json` is
 * decided by the version rule and builds.
 *
 * @module build-gate
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CURRENT_REVISION, GIT_DIFF_CHANGED_STATUS, PACKAGE_MANIFEST_FILE, PREVIOUS_REVISION } from "./constants/build-gate.js";
import { compareReleaseVersions, isStableReleaseVersion } from "./versions.js";
import { CI_RELEASE_METADATA_FILE, RELEASE_EXECUTION, RELEASE_EXECUTION_TRAILER } from "./constants/ci-release.js";

/**
 * @typedef {{ shouldBuild: boolean, reason: string }} BuildDecision
 */

/**
 * Tells whether a commit lowers the stable version of its parent.
 *
 * @param {string | null} previousVersion - Version of the previous commit, or `null` when unreadable.
 * @param {string | null} currentVersion - Version of the commit being deployed, or `null` when unreadable.
 * @returns {boolean} Whether both versions are stable and the current one is lower.
 */
function isVersionRollback(previousVersion, currentVersion) {
  return (
    previousVersion !== null &&
    currentVersion !== null &&
    isStableReleaseVersion(previousVersion) &&
    isStableReleaseVersion(currentVersion) &&
    compareReleaseVersions(currentVersion, previousVersion) < 0
  );
}

/**
 * Decides whether a commit is built: a stable version that differs from the previous one ships.
 *
 * @param {string | null} previousVersion - Version of the previous commit, or `null` when unreadable.
 * @param {string | null} currentVersion - Version of the commit being deployed, or `null` when unreadable.
 * @returns {BuildDecision} Decision and a log line.
 */
export function decideBuild(previousVersion, currentVersion) {
  if (currentVersion === null) {
    return { shouldBuild: false, reason: "Current package version could not be read. Skipping build." };
  }

  if (!isStableReleaseVersion(currentVersion)) {
    return { shouldBuild: false, reason: `Version ${currentVersion} is not a stable X.Y.Z release. Skipping build.` };
  }

  if (previousVersion === null) {
    return { shouldBuild: true, reason: `Previous package version could not be compared. Building stable ${currentVersion}.` };
  }

  if (currentVersion === previousVersion) {
    return { shouldBuild: false, reason: "Version did not change. Skipping build." };
  }

  if (isVersionRollback(previousVersion, currentVersion)) {
    return { shouldBuild: true, reason: `Version rolled back: ${previousVersion} -> ${currentVersion}. Building.` };
  }

  return { shouldBuild: true, reason: `Version changed: ${previousVersion} -> ${currentVersion}. Building.` };
}

/**
 * Reads the `version` field of a `package.json` text.
 *
 * @param {() => string} readManifest - Returns the manifest contents.
 * @returns {string | null} Version, or `null` when unreadable.
 */
function readVersion(readManifest) {
  try {
    const version = JSON.parse(readManifest()).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Tells whether the deployed commit carries exactly one `Golfo-Rp-Execution: ci`
 * trailer, the commit-local mark `create-version` writes in a release delegated
 * to CI. A Git failure counts as "no trailer".
 *
 * @param {string} repositoryRoot - Checkout whose `HEAD` is being deployed.
 * @returns {boolean} Whether `HEAD` declares a CI release execution.
 */
function hasCiReleaseTrailer(repositoryRoot) {
  const trailers = spawnSync("git", ["log", "-1", `--format=%(trailers:key=${RELEASE_EXECUTION_TRAILER},valueonly=true)`, CURRENT_REVISION], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (trailers.status !== 0) return false;
  const recordedValues = [...new Set(trailers.stdout.split("\n").map((value) => value.trim()).filter(Boolean))];
  return recordedValues.length === 1 && recordedValues[0] === RELEASE_EXECUTION.ci;
}

/**
 * Tells whether the deployed commit is the one that wrote the CI release
 * metadata. With a readable first parent it compares the metadata against it;
 * without one (first commit or shallow clone) it relies on the release commit's
 * own `Golfo-Rp-Execution: ci` trailer, so the CI gate holds in shallow checkouts.
 *
 * @param {string} repositoryRoot - Checkout whose `HEAD` is being deployed.
 * @returns {boolean} Whether `HEAD` is the CI release commit.
 */
function isReleaseMetadataCommit(repositoryRoot) {
  const parentLookup = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${PREVIOUS_REVISION}^{commit}`], {
    cwd: repositoryRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  if (parentLookup.status !== 0) return hasCiReleaseTrailer(repositoryRoot);
  const metadataDiff = spawnSync("git", ["diff", "--quiet", PREVIOUS_REVISION, CURRENT_REVISION, "--", CI_RELEASE_METADATA_FILE], {
    cwd: repositoryRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  return metadataDiff.status === GIT_DIFF_CHANGED_STATUS;
}

/**
 * Reads the previous and the current `package.json` versions of a Git
 * checkout and decides whether it is built.
 *
 * @param {string} repositoryRoot - Checkout whose `HEAD` is being deployed.
 * @returns {BuildDecision} Decision and a log line.
 */
export function decideBuildForCheckout(repositoryRoot) {
  const previousVersion = readVersion(() =>
    execFileSync("git", ["show", `${PREVIOUS_REVISION}:${PACKAGE_MANIFEST_FILE}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  );
  const currentVersion = readVersion(() => readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  const metadataPath = path.join(repositoryRoot, CI_RELEASE_METADATA_FILE);
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      const isDelegatedRelease =
        metadata.version === currentVersion && metadata.execution === RELEASE_EXECUTION.ci && !isVersionRollback(previousVersion, currentVersion);
      if (isDelegatedRelease && isReleaseMetadataCommit(repositoryRoot)) return { shouldBuild: false, reason: `Release ${currentVersion} is delegated to CI. Production deployment waits for its checks. Skipping build.` };
    } catch {
      return { shouldBuild: false, reason: "CI release metadata could not be read. Skipping build." };
    }
  }

  return decideBuild(previousVersion, currentVersion);
}
