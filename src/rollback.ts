import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import * as yaml from "yaml";
import {
  CSTScalarToken,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The state of one env in a historical version of the file.
 * There are three cases:
 * An unreadable commit gives no information. Skip it.
 * A missing env marks the start of that env's history. Stop the walk.
 * A found ref is the rollback target. Return it.
 */
type HistoricalEnv =
  | { kind: "unparseable" }
  | { kind: "envMissing" }
  | { kind: "found"; ref: string; tag: string | null };

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
  if (!isRecord(parsed)) return { kind: "unparseable" };

  const envBlock = parsed[envName];
  if (!isRecord(envBlock)) return { kind: "envMissing" };
  const gitConfig = envBlock.gitConfig;
  if (!isRecord(gitConfig)) return { kind: "envMissing" };
  const ref = gitConfig.ref;
  if (typeof ref !== "string") return { kind: "envMissing" };

  const dockerImage = envBlock.dockerImage;
  const tag =
    isRecord(dockerImage) && typeof dockerImage.tag === "string"
      ? dockerImage.tag
      : null;
  return { kind: "found", ref, tag };
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
  filename: string;
  gitHistoryReader: GitHistoryReader;
  logger: PrefixingLogger;
}): Promise<ResolvedTarget> {
  const { envName, currentRef, gitSha, filename, gitHistoryReader, logger } =
    options;

  const commits = await gitHistoryReader.listCommitsAffectingFile(filename);
  if (commits.length === 0) {
    throw new Error(
      `Git history for ${filename} is empty; cannot compute rollback target`,
    );
  }

  // Skip the most recent commit since it is the problem one.
  // Start the search at the commit before it, going backwards.
  // Many commits update dev and staging only. They do not change the promotion target.
  // Find the commit where the ref for this env changed.
  for (const commit of commits.slice(1)) {
    let historical: string;
    try {
      historical = await gitHistoryReader.readFileAtCommit(commit, filename);
    } catch (err) {
      // File may not have existed at that commit (e.g. rename). Skip.
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`Skipping commit ${commit}: ${message}`);
      continue;
    }

    const historicalEnv = readEnvRefAndTag(historical, envName);
    switch (historicalEnv.kind) {
      // A commit whose YAML we cannot parse tells us nothing; keep walking.
      case "unparseable":
        logger.info(`Skipping commit ${commit}: could not parse YAML`);
        continue;

      // The env has no ref at this commit.
      // Older commits belong to a different version of the file.
      // Do not roll back to an older commit. The ref there did not belong to this env.
      // Stop the search here.
      case "envMissing": {
        const why = gitSha
          ? `SHA ${gitSha} predates it.`
          : `There is no earlier deploy to roll back to.`;
        throw new Error(
          `Cannot roll back \`${envName}\`: it has no pinned \`gitConfig.ref\` as of commit ${commit}, which is as far back as its history goes in ${filename}. ${why}`,
        );
      }

      // Explicit-SHA mode: find the commit where this env held exactly that SHA.
      // Blank-SHA mode: first commit where this env's ref differs from current.
      case "found": {
        const isTarget = gitSha
          ? historicalEnv.ref === gitSha
          : historicalEnv.ref !== currentRef;
        if (isTarget) {
          return { ref: historicalEnv.ref, tag: historicalEnv.tag, commit };
        }
        break;
      }
    }
  }

  if (gitSha) {
    throw new Error(
      `SHA ${gitSha} has never been deployed to \`${envName}\` (scanned ${commits.length} commits of ${filename})`,
    );
  }
  throw new Error(
    `No previous deploy found for \`${envName}\` in the history of ${filename} (scanned ${commits.length} commits)`,
  );
}

/** A string value in the current document plus the CST token needed to
 *  overwrite it in place. */
interface ScalarEntry {
  readonly value: string;
  readonly scalarToken: CSTScalarToken;
  readonly range?: yaml.Range | null | undefined;
}

/** Read the env's current gitConfig.ref (and dockerImage.tag, if the env has
 *  one) or throw if the env isn't shaped like a promotion target. */
function readCurrentRefAndTag(
  envBlock: yaml.YAMLMap.Parsed,
  envName: string,
  lineCounter: yaml.LineCounter,
): { ref: ScalarEntry; tag: ScalarEntry | null } {
  const gitConfigNode = envBlock.get("gitConfig");
  if (!gitConfigNode || !yaml.isMap(gitConfigNode)) {
    throw new AnnotatedError(
      `Cannot roll back \`${envName}\`: missing \`gitConfig\` block`,
      { range: envBlock.range, lineCounter },
    );
  }
  const ref = getStringAndScalarTokenFromMap(gitConfigNode, "ref");
  if (!ref) {
    throw new AnnotatedError(
      `Cannot roll back \`${envName}\`: \`gitConfig.ref\` is not set`,
      { range: gitConfigNode.range, lineCounter },
    );
  }

  const dockerImageNode = envBlock.get("dockerImage");
  const tag =
    dockerImageNode && yaml.isMap(dockerImageNode)
      ? getStringAndScalarTokenFromMap(dockerImageNode, "tag")
      : null;
  return { ref, tag };
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

  const unchanged = { newContents: contents, rollbacks: [] };

  const { document, stringify, lineCounter } = parseYAML(contents);
  if (!document) return unchanged;

  const { blocks } = getTopLevelBlocks(document);
  const envBlock = blocks.get(targetEnv);

  // The action runs across a glob; files that don't contain the target env or
  // are frozen just pass through unchanged. So do envs without a `promote`
  // block: only apps that are promotion targets get rollback, while
  // non-promoted envs (which track a mutable ref directly) roll forward
  // instead.
  const isRollbackCandidate =
    envBlock && !frozenEnvironments.has(targetEnv) && envBlock.has("promote");
  if (!isRollbackCandidate) return unchanged;

  const current = readCurrentRefAndTag(envBlock, targetEnv, lineCounter);

  if (gitSha && gitSha === current.ref.value) {
    throw new AnnotatedError(
      `Rollback for \`${targetEnv}\` would be a no-op: requested SHA (${gitSha}) is already deployed`,
      { range: current.ref.range, lineCounter },
    );
  }

  logger.info(
    `Resolving rollback target for ${targetEnv} (current ref: ${current.ref.value})`,
  );

  const resolved = await resolveRollbackTarget({
    envName: targetEnv,
    currentRef: current.ref.value,
    gitSha,
    filename,
    gitHistoryReader,
    logger,
  });

  if (current.tag && !resolved.tag) {
    throw new AnnotatedError(
      `Cannot roll back \`${targetEnv}\`: the current file has a \`dockerImage.tag\` but the historical file (commit ${resolved.commit}) does not`,
      { range: current.tag.range, lineCounter },
    );
  }

  // All validations passed — apply writes.
  new ScalarTokenWriter(current.ref.scalarToken, document.schema).write(
    resolved.ref,
  );
  if (current.tag && resolved.tag) {
    new ScalarTokenWriter(current.tag.scalarToken, document.schema).write(
      resolved.tag,
    );
  }

  return {
    newContents: stringify(),
    rollbacks: [
      {
        appName: `${basename(dirname(filename))}-${targetEnv}`,
        environment: targetEnv,
        previousRef: current.ref.value,
        rolledBackRef: resolved.ref,
        previousTag: current.tag?.value ?? null,
        rolledBackTag: current.tag ? resolved.tag : null,
        resolvedFromCommit: resolved.commit,
      },
    ],
  };
}
