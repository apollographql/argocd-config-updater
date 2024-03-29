import * as yaml from 'yaml';
import {
  GetTreeSHAForPathOptions,
  GitHubClient,
  ResolveRefToSHAOptions,
} from './github';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';

interface Trackable {
  trackMutableRef: string;
  repoURL: string;
  path: string;
  ref: string;
  maybeDockerCommit: string | null;
  refScalarTokenWriter: ScalarTokenWriter;
}

export async function updateGitRefs(
  contents: string,
  gitHubClient: GitHubClient,
  _logger: PrefixingLogger,
): Promise<string> {
  const logger = _logger.withExtendedPrefix('[trackMutableRef] ');

  const { document, stringify } = parseYAML(contents);

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.
  if (!document) {
    return contents;
  }

  logger.info('Looking for trackMutableRef');
  const trackables = findTrackables(document);

  logger.info('Checking refs against GitHub');
  await checkRefsAgainstGitHubAndModifyScalars(
    trackables,
    gitHubClient,
    logger,
  );
  return stringify();
}

function findTrackables(doc: yaml.Document.Parsed): Trackable[] {
  const trackables: Trackable[] = [];

  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  let globalRepoURL: string | null = null;
  let globalPath: string | null = null;

  if (globalBlock?.has('gitConfig')) {
    const gitConfigBlock = globalBlock.get('gitConfig');
    if (!yaml.isMap(gitConfigBlock)) {
      throw Error('Document has `global.gitConfig` that is not a map');
    }
    // Read repoURL and path from 'global' (keeping them null if they're not
    // there, though throwing if they're there as non-strings).
    globalRepoURL = getStringValue(gitConfigBlock, 'repoURL');
    globalPath = getStringValue(gitConfigBlock, 'path');
  }

  for (const [key, value] of blocks) {
    if (!value.has('gitConfig')) {
      continue;
    }
    const gitConfigBlock = value.get('gitConfig');
    if (!yaml.isMap(gitConfigBlock)) {
      throw Error(`Document has \`${key}.gitConfig\` that is not a map`);
    }

    const repoURL = getStringValue(gitConfigBlock, 'repoURL') ?? globalRepoURL;
    const path = getStringValue(gitConfigBlock, 'path') ?? globalPath;
    // Tracking can be specified at `gitConfig.trackMutableRef` or just at
    // `track`.
    const trackMutableRef =
      getStringValue(gitConfigBlock, 'trackMutableRef') ??
      getStringValue(value, 'track');
    const refScalarTokenAndValue = getStringAndScalarTokenFromMap(
      gitConfigBlock,
      'ref',
    );

    let maybeDockerCommit: string | null = null;

    if (value.has('dockerImage')) {
      const dockerImageBlock = value.get('dockerImage');
      if (!yaml.isMap(dockerImageBlock)) {
        throw Error(`Document has \`${key}.dockerImage\` that is not a map`);
      }

      const tag = getStringValue(dockerImageBlock, 'tag');

      const gitCommitMatches = tag?.match(/-g([0-9a-fA-F]+)$/);
      if (gitCommitMatches) {
        maybeDockerCommit = gitCommitMatches[1];
      }
    }

    if (trackMutableRef && repoURL && path && refScalarTokenAndValue) {
      trackables.push({
        trackMutableRef,
        repoURL,
        path,
        ref: refScalarTokenAndValue.value,
        refScalarTokenWriter: new ScalarTokenWriter(
          refScalarTokenAndValue.scalarToken,
          doc.schema,
        ),
        maybeDockerCommit,
      });
    }
  }

  return trackables;
}

// While the actual ref we're tracking needs to resolve, it's OK if the current
// value we're overwriting in `ref` doesn't resolve, or if the commit we found
// in the Docker tag doesn't resolve. Those are just heuristics that help us
// choose between multiple git commit SHAs that all have the same subpath tree
// SHA.
async function resolveRefToSHAOrNull(
  gitHubClient: GitHubClient,
  options: ResolveRefToSHAOptions,
): Promise<string | null> {
  try {
    return await gitHubClient.resolveRefToSHA(options);
  } catch (e) {
    console.warn(
      `Ignoring error looking up ref ${options.ref} at ${options.repoURL}: ${e}`,
    );
    return null;
  }
}

// While the tree SHA for the actual ref we're tracking needs to resolve, it's
// OK if the current value we're overwriting in `ref` doesn't have a tree at
// that path, or if the commit we found in the Docker tag doesn't have a tree at
// that path. Those are just heuristics that help us choose between multiple git
// commit SHAs that all have the same subpath tree SHA.
async function getTreeSHAForPathOrNull(
  gitHubClient: GitHubClient,
  options: GetTreeSHAForPathOptions,
): Promise<string | null> {
  try {
    return await gitHubClient.getTreeSHAForPath(options);
  } catch (e) {
    console.warn(
      `Ignoring error getting tree SHA for ${options.path} at ${options.commitSHA} in ${options.repoURL}: ${e}`,
    );
    return null;
  }
}

async function checkRefsAgainstGitHubAndModifyScalars(
  trackables: Trackable[],
  gitHubClient: GitHubClient,
  logger: PrefixingLogger,
): Promise<void> {
  for (const trackable of trackables) {
    const trackedRefCommitSHA = await gitHubClient.resolveRefToSHA({
      repoURL: trackable.repoURL,
      ref: trackable.trackMutableRef,
    });

    // Convert trackable.ref to SHA too, because getTreeSHAForPath requires you
    // to pass a commit SHA (due to the particular GitHub APIs it uses).
    const currentRefCommitSHA = await resolveRefToSHAOrNull(gitHubClient, {
      repoURL: trackable.repoURL,
      ref: trackable.ref,
    });

    // OK, we've got a SHA that we could overwrite the current ref
    // (`trackable.ref`) with in the config file. But we don't want to do this
    // if it would be a no-op. Let's check the tree SHA
    // (https://git-scm.com/book/en/v2/Git-Internals-Git-Objects#_tree_objects)
    // at the given path to see if it has changed between `trackable.ref` and
    // the SHA we're thinking about replacing it with.
    const currentTreeSHA = currentRefCommitSHA
      ? await getTreeSHAForPathOrNull(gitHubClient, {
          repoURL: trackable.repoURL,
          commitSHA: currentRefCommitSHA,
          path: trackable.path,
        })
      : null;
    const trackedTreeSHA = await gitHubClient.getTreeSHAForPath({
      repoURL: trackable.repoURL,
      commitSHA: trackedRefCommitSHA,
      path: trackable.path,
    });

    // The docker commit is usually a short sha, which we can't get the tree path for
    // This converts it to a full sha so we can get the tree sha later
    const dockerRefCommitSHA = trackable.maybeDockerCommit
      ? await resolveRefToSHAOrNull(gitHubClient, {
          repoURL: trackable.repoURL,
          ref: trackable.maybeDockerCommit,
        })
      : null;

    const dockerTreeSHA = dockerRefCommitSHA
      ? await getTreeSHAForPathOrNull(gitHubClient, {
          repoURL: trackable.repoURL,
          commitSHA: dockerRefCommitSHA,
          path: trackable.path,
        })
      : null;

    if (trackedTreeSHA === null) {
      throw Error(
        `Could not get tree SHA for ${trackedRefCommitSHA} in ${trackable.repoURL} for ref ${trackable.path}`,
      );
    }
    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    logger.info(
      `for path ${trackable.path}, got tree shas` +
        ` current: ${currentTreeSHA} for ${trackable.ref}` +
        ` tracked: ${trackedTreeSHA} for ${trackedRefCommitSHA}` +
        ` docker: ${dockerTreeSHA} for ${dockerRefCommitSHA}`,
    );

    // The second check shouldn't be neccesary since dockerTreeSHA is only
    // defined if dockerRefCommitSha is defined, but TypeScript doesn't know
    if (dockerTreeSHA === trackedTreeSHA && dockerRefCommitSHA) {
      if (dockerRefCommitSHA !== trackable.ref) {
        logger.info('(using docker sha)');
        trackable.refScalarTokenWriter.write(dockerRefCommitSHA);
      } else {
        // Commit sha is already whats written so no changes
        logger.info('(matches docker, unchanged)');
      }
    } else if (currentRefCommitSHA && currentTreeSHA === trackedTreeSHA) {
      if (currentRefCommitSHA !== trackable.ref) {
        // This will freeze the current ref if it is a mutable ref.
        logger.info('(freezing current ref)');
        trackable.refScalarTokenWriter.write(currentRefCommitSHA);
      } else {
        // Commit sha is already whats written so no changes
        logger.info('(unchanged)');
      }
    } else {
      logger.info('(updated to latest from ref!)');
      trackable.refScalarTokenWriter.write(trackedRefCommitSHA);
    }
  }
}
