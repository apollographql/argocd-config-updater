import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import * as yaml from "yaml";
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getTopLevelBlocks,
  parseYAML,
} from "./yaml.js";
import { PrefixingLogger } from "./log.js";
import { AnnotatedError } from "./annotatedError.js";

const execFileAsync = promisify(execFile);

/**
 * A reader for past versions of a file tracked by git. Abstracted so tests
 * can supply a deterministic fake without setting up a real git repo.
 */
export interface GitHistoryReader {
  /** Commit SHAs that touched `relativePath`, most recent first. */
  listCommitsAffectingFile(relativePath: string): Promise<string[]>;
  /** Contents of `relativePath` as of `commit`. */
  readFileAtCommit(commit: string, relativePath: string): Promise<string>;
}

/**
 * Shells out to the git CLI. Assumes the caller's working directory is inside
 * the repository that contains the file — which is true for this action
 * because GitHub Actions checks the repo out before running.
 */
export class ChildProcessGitHistoryReader implements GitHistoryReader {
  constructor(private cwd: string = process.cwd()) {}

  async listCommitsAffectingFile(relativePath: string): Promise<string[]> {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--format=%H", "--", relativePath],
      { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout.split("\n").filter(Boolean);
  }

  async readFileAtCommit(
    commit: string,
    relativePath: string,
  ): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${commit}:${relativePath}`],
      { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  }
}

/** Summary of a rollback that was applied, returned so callers can build PR bodies. */
export interface AppRollback {
  appName: string;
  environment: string;
  previousRef: string;
  rolledBackRef: string;
  previousTag: string | null;
  rolledBackTag: string | null;
  resolvedFromCommit: string;
}

export async function rollback(options: {
  contents: string;
  /** Repo-relative path of the file, used both for messages and for asking git
   *  about the file's history. */
  filename: string;
  /** Which top-level env block to roll back (e.g. `prod`, `staging`). Must have
   *  a `promote.from` block; envs that track a mutable ref roll forward instead. */
  targetEnv: string;
  /** If non-empty, roll back to this SHA. If blank, roll back to the most recent
   *  commit where the target env's gitConfig.ref differed from the current value. */
  gitSha: string;
  frozenEnvironments: Set<string>;
  gitHistoryReader: GitHistoryReader;
  _logger: PrefixingLogger;
}): Promise<{ newContents: string; rollbacks: AppRollback[] }> {
  const {
    contents,
    filename,
    targetEnv,
    gitSha,
    frozenEnvironments,
    gitHistoryReader,
    _logger,
  } = options;
  const logger = _logger.withExtendedPrefix("[rollback] ");

  const { document, stringify, lineCounter } = parseYAML(contents);
  if (!document) {
    return { newContents: contents, rollbacks: [] };
  }

  const { blocks } = getTopLevelBlocks(document);
  const applicationBaseName = basename(dirname(filename));

  const envBlock = blocks.get(targetEnv);
  // The action runs across a glob; files that don't contain the target env or
  // are frozen just pass through unchanged.
  if (!envBlock) return { newContents: contents, rollbacks: [] };
  if (frozenEnvironments.has(targetEnv)) {
    return { newContents: contents, rollbacks: [] };
  }
  // Only apps that are promotion targets get rollback. Non-promoted envs
  // (which track a mutable ref directly) roll forward instead.
  if (!envBlock.has("promote")) {
    return { newContents: contents, rollbacks: [] };
  }

  const gitConfigNode = envBlock.get("gitConfig");
  if (!gitConfigNode || !yaml.isMap(gitConfigNode)) {
    throw new AnnotatedError(
      `Cannot roll back \`${targetEnv}\`: missing \`gitConfig\` block`,
      { range: envBlock?.range, lineCounter },
    );
  }
  const currentRefEntry = getStringAndScalarTokenFromMap(gitConfigNode, "ref");
  if (!currentRefEntry) {
    throw new AnnotatedError(
      `Cannot roll back \`${targetEnv}\`: \`gitConfig.ref\` is not set`,
      { range: gitConfigNode?.range, lineCounter },
    );
  }

  const dockerImageNode = envBlock.get("dockerImage");
  const currentTagEntry =
    dockerImageNode && yaml.isMap(dockerImageNode)
      ? getStringAndScalarTokenFromMap(dockerImageNode, "tag")
      : null;

  if (gitSha && gitSha === currentRefEntry.value) {
    throw new AnnotatedError(
      `Rollback for \`${targetEnv}\` would be a no-op: requested SHA (${gitSha}) is already deployed`,
      { range: currentRefEntry.range, lineCounter },
    );
  }

  logger.info(
    `Resolving rollback target for ${targetEnv} (current ref: ${currentRefEntry.value})`,
  );

  const resolved = await resolveRollbackTarget({
    envName: targetEnv,
    currentRef: currentRefEntry.value,
    gitSha,
    gitRelativePath: filename,
    gitHistoryReader,
    logger,
  });

  if (currentTagEntry && !resolved.tag) {
    throw new AnnotatedError(
      `Cannot roll back \`${targetEnv}\`: the current file has a \`dockerImage.tag\` but the historical file (commit ${resolved.commit}) does not`,
      { range: currentTagEntry.range, lineCounter },
    );
  }

  // All validations passed — apply writes.
  new ScalarTokenWriter(currentRefEntry.scalarToken, document.schema).write(
    resolved.ref,
  );
  if (currentTagEntry && resolved.tag) {
    new ScalarTokenWriter(currentTagEntry.scalarToken, document.schema).write(
      resolved.tag,
    );
  }

  const rollbacks: AppRollback[] = [
    {
      appName: `${applicationBaseName}-${targetEnv}`,
      environment: targetEnv,
      previousRef: currentRefEntry.value,
      rolledBackRef: resolved.ref,
      previousTag: currentTagEntry?.value ?? null,
      rolledBackTag: currentTagEntry && resolved.tag ? resolved.tag : null,
      resolvedFromCommit: resolved.commit,
    },
  ];

  return { newContents: stringify(), rollbacks };
}

interface ResolvedTarget {
  ref: string;
  tag: string | null;
  commit: string;
}

async function resolveRollbackTarget(options: {
  envName: string;
  currentRef: string;
  gitSha: string;
  gitRelativePath: string;
  gitHistoryReader: GitHistoryReader;
  logger: PrefixingLogger;
}): Promise<ResolvedTarget> {
  const {
    envName,
    currentRef,
    gitSha,
    gitRelativePath,
    gitHistoryReader,
    logger,
  } = options;

  const commits =
    await gitHistoryReader.listCommitsAffectingFile(gitRelativePath);
  if (commits.length === 0) {
    throw new Error(
      `Git history for ${gitRelativePath} is empty; cannot compute rollback target`,
    );
  }

  // Skip the most recent commit: it contains the current state.
  // We walk backwards from the one before.
  // Most files have many auto-update commits that touch dev/staging but not
  // the promotion target, so we must find the commit where *this* env's ref
  // actually differed.
  for (let i = 1; i < commits.length; i++) {
    const commit = commits[i];
    let historical: string;
    try {
      historical = await gitHistoryReader.readFileAtCommit(
        commit,
        gitRelativePath,
      );
    } catch (err) {
      // File may not have existed at that commit (e.g. rename). Skip.
      logger.info(`Skipping commit ${commit}: ${(err as Error).message}`);
      continue;
    }

    const historicalEnv = readEnvRefAndTag(historical, envName);

    // A commit whose YAML we cannot parse tells us nothing; keep walking.
    if (historicalEnv.kind === "unparseable") {
      logger.info(`Skipping commit ${commit}: could not parse YAML`);
      continue;
    }

    // The env is absent (or has no pinned ref) at this commit, so this is the
    // point where it was introduced. Anything older belongs to a different
    // incarnation of the file, and silently rolling back to it would deploy a
    // ref that was never this env's. Stop instead of gliding past.
    if (historicalEnv.kind === "envMissing") {
      const why = gitSha
        ? `SHA ${gitSha} predates it.`
        : `There is no earlier deploy to roll back to.`;
      throw new Error(
        `Cannot roll back \`${envName}\`: it has no pinned \`gitConfig.ref\` as of commit ${commit}, which is as far back as its history goes in ${gitRelativePath}. ${why}`,
      );
    }

    // Explicit-SHA mode: find the commit where this env held exactly that SHA.
    // Blank-SHA mode: first commit where this env's ref differs from current.
    const isTarget = gitSha
      ? historicalEnv.ref === gitSha
      : historicalEnv.ref !== currentRef;
    if (isTarget) {
      return { ref: historicalEnv.ref, tag: historicalEnv.tag, commit };
    }
  }

  if (gitSha) {
    throw new Error(
      `SHA ${gitSha} has never been deployed to \`${envName}\` (scanned ${commits.length} commits of ${gitRelativePath})`,
    );
  }
  throw new Error(
    `No previous deploy found for \`${envName}\` in the history of ${gitRelativePath} (scanned ${commits.length} commits)`,
  );
}

/**
 * What a historical version of the file says about one env. The three cases are
 * distinguished because they mean different things to the history walk: an
 * unreadable commit is uninformative and gets skipped, whereas an env that
 * isn't there marks the start of that env's history and stops the walk.
 */
type HistoricalEnv =
  | { kind: "found"; ref: string; tag: string | null }
  | { kind: "envMissing" }
  | { kind: "unparseable" };

/** Extract one env block's gitConfig.ref and dockerImage.tag from a YAML string. */
function readEnvRefAndTag(
  fileContents: string,
  envName: string,
): HistoricalEnv {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fileContents);
  } catch {
    return { kind: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "unparseable" };
  const envBlock = (parsed as Record<string, unknown>)[envName];
  if (!envBlock || typeof envBlock !== "object") return { kind: "envMissing" };

  const gitConfig = (envBlock as Record<string, unknown>).gitConfig;
  if (!gitConfig || typeof gitConfig !== "object")
    return { kind: "envMissing" };
  const ref = (gitConfig as Record<string, unknown>).ref;
  if (typeof ref !== "string") return { kind: "envMissing" };

  const dockerImage = (envBlock as Record<string, unknown>).dockerImage;
  let tag: string | null = null;
  if (dockerImage && typeof dockerImage === "object") {
    const rawTag = (dockerImage as Record<string, unknown>).tag;
    if (typeof rawTag === "string") tag = rawTag;
  }
  return { kind: "found", ref, tag };
}
