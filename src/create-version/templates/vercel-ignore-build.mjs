/**
 * Gates Git deployments while an exact release is owned by CI.
 *
 * A commit cannot contain its own SHA, so the release commit is identified as the one that
 * changes `.golfo-rp/release.json` against its first parent; later commits keep the metadata
 * untouched and fall through to the original gate. Without a readable parent (shallow clone or
 * first commit) the release commit is recognized by its own `Golfo-Rp-Execution: ci` trailer,
 * which later commits never carry, so the gate stays closed until the release workflow deploys.
 * A CI release never lowers the version: a rollback that restores an older metadata file goes to
 * the original gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const RELEASE_METADATA_FILE = '.golfo-rp/release.json';
/** Revision compared against the deployed commit; absent in shallow clones and on the first commit. */
const PARENT_REVISION = 'HEAD^';
/** `git diff --quiet` status reporting that the path changed between both commits. */
const GIT_DIFF_CHANGED_STATUS = 1;
/** Trailer that `golfo-rp create-version` writes in the release commit (mirrors `RELEASE_EXECUTION_TRAILER`). */
const RELEASE_EXECUTION_TRAILER = 'Golfo-Rp-Execution';
/** Trailer value of a release whose deployment is delegated to CI. */
const CI_RELEASE_EXECUTION = 'ci';
/** Stable `X.Y.Z` version without leading zeros (mirrors `isStableReleaseVersion`). */
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Runs a read-only Git command in the deployed checkout.
 * @param {string[]} gitArguments - Git arguments.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Git result.
 */
function runGit(gitArguments) {
  return spawnSync('git', gitArguments, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

/** @returns {boolean} Whether the deployed commit carries exactly one `Golfo-Rp-Execution: ci` trailer value. */
function hasCiReleaseTrailer() {
  const trailers = runGit(['log', '-1', `--format=%(trailers:key=${RELEASE_EXECUTION_TRAILER},valueonly=true)`, 'HEAD']);
  if (trailers.status !== 0) return false;
  const recordedValues = [...new Set(trailers.stdout.split('\n').map((value) => value.trim()).filter(Boolean))];
  return recordedValues.length === 1 && recordedValues[0] === CI_RELEASE_EXECUTION;
}

/** @returns {boolean} Whether the deployed commit is the one that wrote the release metadata. */
function isReleaseMetadataCommit() {
  const parent = runGit(['rev-parse', '--verify', '--quiet', `${PARENT_REVISION}^{commit}`]);
  if (parent.status !== 0) return hasCiReleaseTrailer();
  const changed = runGit(['diff', '--quiet', PARENT_REVISION, 'HEAD', '--', RELEASE_METADATA_FILE]);
  return changed.status === GIT_DIFF_CHANGED_STATUS;
}

/**
 * @param {unknown} currentVersion - Version of the deployed `package.json`.
 * @returns {boolean} Whether it is a stable version lower than the stable version of the parent commit.
 */
function isVersionRollback(currentVersion) {
  const parentManifest = runGit(['show', `${PARENT_REVISION}:package.json`]);
  if (parentManifest.status !== 0) return false;
  let previousVersion;
  try {
    previousVersion = JSON.parse(parentManifest.stdout).version;
  } catch {
    return false;
  }
  const current = STABLE_VERSION_PATTERN.exec(String(currentVersion));
  const previous = STABLE_VERSION_PATTERN.exec(String(previousVersion));
  if (!current || !previous) return false;
  const difference = [1, 2, 3].map((index) => Number(current[index]) - Number(previous[index])).find((part) => part !== 0);
  return difference !== undefined && difference < 0;
}

let delegated = false;
try {
  if (existsSync(RELEASE_METADATA_FILE)) {
    const metadata = JSON.parse(readFileSync(RELEASE_METADATA_FILE, 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    delegated =
      metadata.execution === 'ci' && metadata.version === manifest.version && isReleaseMetadataCommit() && !isVersionRollback(manifest.version);
  }
} catch {
  console.error('No se pudo leer la metadata del release; se omite el despliegue automático.');
  process.exit(0);
}
if (delegated) {
  console.log('El release está en CI; producción espera a que pasen los checks.');
  process.exit(0);
}
const originalIgnoreCommand = __ORIGINAL_IGNORE_COMMAND__;
process.exitCode = originalIgnoreCommand
  ? spawnSync(originalIgnoreCommand, { shell: true, stdio: 'inherit', windowsHide: true }).status ?? 0
  : 1;
