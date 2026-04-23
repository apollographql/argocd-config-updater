import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, isAbsolute, basename, dirname } from "node:path";
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
  newRef: string;
  previousTag: string | null;
  newTag: string | null;
  resolvedFromCommit: string;
}

export async function rollback(options: {
  contents: string;
  filename: string;
  /** Which top-level env block to roll back (e.g. `prod`, `staging`). Must have
   *  a `promote.from` block; envs that track a mutable ref roll forward instead. */
  targetEnv: string;
  /** If non-empty, roll back to this SHA. If blank, roll back to the most recent
   *  commit where the target env's gitConfig.ref differed from the current value. */
  gitSha: string;
  frozenEnvironments: Set<string>;
  gitHistoryReader: GitHistoryReader;
  /** Path to use when asking git about this file. Defaults to deriving from
   *  `filename` relative to process.cwd(). */
  gitRelativePath?: string;
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
  const gitRelativePath =
    options.gitRelativePath ?? defaultGitRelativePath(filename);
  const applicationBaseName = basename(dirname(filename));

  const envBlock = blocks.get(targetEnv);
  // The action runs across a glob; files that don't contain the target env or
  // are frozen just pass through unchanged.
  if (!envBlock) return { newContents: contents, rollbacks: [] };
  if (frozenEnvironments.has(targetEnv)) {
    return { newContents: contents, rollbacks: [] };
  }
  // Per FOUN-1335: only apps that are promotion targets get rollback. Non-promoted
  // envs (which track a mutable ref directly) roll forward instead.
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
    gitRelativePath,
    gitHistoryReader,
    logger,
  });

  if (resolved.ref === currentRefEntry.value) {
    throw new AnnotatedError(
      `Rollback for \`${targetEnv}\` would be a no-op: resolved ref matches current (${resolved.ref})`,
      { range: currentRefEntry.range, lineCounter },
    );
  }

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
      newRef: resolved.ref,
      previousTag: currentTagEntry?.value ?? null,
      newTag: currentTagEntry && resolved.tag ? resolved.tag : null,
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

    const { ref: historicalRef, tag: historicalTag } =
      readEnvRefAndTag(historical, envName) ?? {};
    if (!historicalRef) continue;

    if (gitSha) {
      // Explicit-SHA mode: find the commit where this env held exactly that SHA.
      if (historicalRef === gitSha) {
        return { ref: historicalRef, tag: historicalTag ?? null, commit };
      }
    } else {
      // Blank-SHA mode: first commit where this env differs from the current ref.
      if (historicalRef !== currentRef) {
        return { ref: historicalRef, tag: historicalTag ?? null, commit };
      }
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

/** Extract one env block's gitConfig.ref and dockerImage.tag from a YAML string.
 *  Returns null if the block or gitConfig.ref aren't present. */
function readEnvRefAndTag(
  fileContents: string,
  envName: string,
): { ref: string; tag: string | null } | null {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fileContents);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const envBlock = (parsed as Record<string, unknown>)[envName];
  if (!envBlock || typeof envBlock !== "object") return null;

  const gitConfig = (envBlock as Record<string, unknown>).gitConfig;
  if (!gitConfig || typeof gitConfig !== "object") return null;
  const ref = (gitConfig as Record<string, unknown>).ref;
  if (typeof ref !== "string") return null;

  const dockerImage = (envBlock as Record<string, unknown>).dockerImage;
  let tag: string | null = null;
  if (dockerImage && typeof dockerImage === "object") {
    const rawTag = (dockerImage as Record<string, unknown>).tag;
    if (typeof rawTag === "string") tag = rawTag;
  }
  return { ref, tag };
}

function defaultGitRelativePath(filename: string): string {
  if (!isAbsolute(filename)) return filename;
  return relative(process.cwd(), filename);
}
