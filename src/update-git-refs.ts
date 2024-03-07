import * as core from '@actions/core';
import * as yaml from 'yaml';
import { GitHubClient } from './github';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';

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
): Promise<string> {
  return core.group('Processing trackMutableRef', async () => {
    const { document, stringify } = parseYAML(contents);

    // If the file is empty (or just whitespace or whatever), that's fine; we
    // can just leave it alone.
    if (!document) {
      return contents;
    }

    core.info('Looking for trackMutableRef');
    const trackables = findTrackables(document);

    core.info('Checking refs against GitHub');
    await checkRefsAgainstGitHubAndModifyScalars(trackables, gitHubClient);
    return stringify();
  });
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

      const tagScalarTokenAndValue = getStringValue(dockerImageBlock, 'tag');

      const gitCommitMatches =
        tagScalarTokenAndValue?.match(/-g([0-9a-fA-F]+)$/);
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

async function checkRefsAgainstGitHubAndModifyScalars(
  trackables: Trackable[],
  gitHubClient: GitHubClient,
): Promise<void> {
  for (const trackable of trackables) {
    const trackedRefCommitSHA = await gitHubClient.resolveRefToSHA({
      repoURL: trackable.repoURL,
      ref: trackable.trackMutableRef,
    });

    // Convert trackable.ref to SHA too, because getTreeSHAForPath requires you
    // to pass a commit SHA (due to the particular GitHub APIs it uses).
    const currentRefCommitSHA = await gitHubClient.resolveRefToSHA({
      repoURL: trackable.repoURL,
      ref: trackable.ref,
    });

    // OK, we've got a SHA that we could overwrite the current ref
    // (`trackable.ref`) with in the config file. But we don't want to do this
    // if it would be a no-op. Let's check the tree SHA
    // (https://git-scm.com/book/en/v2/Git-Internals-Git-Objects#_tree_objects)
    // at the given path to see if it has changed between `trackable.ref` and
    // the SHA we're thinking about replacing it with.
    const currentTreeSHA = await gitHubClient.getTreeSHAForPath({
      repoURL: trackable.repoURL,
      commitSHA: currentRefCommitSHA,
      path: trackable.path,
    });
    const trackedTreeSHA = await gitHubClient.getTreeSHAForPath({
      repoURL: trackable.repoURL,
      commitSHA: trackedRefCommitSHA,
      path: trackable.path,
    });

    // The docker commit is usually a short sha, which we can't get the tree path for
    // This converts it to a full sha so we can get the tree sha later
    const dockerRefCommitSHA = trackable.maybeDockerCommit
      ? await gitHubClient.resolveRefToSHA({
          repoURL: trackable.repoURL,
          ref: trackable.maybeDockerCommit,
        })
      : null;

    const dockerTreeSha = dockerRefCommitSHA
      ? await gitHubClient.getTreeSHAForPath({
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
    core.info(
      `for path ${trackable.path}, got tree shas` +
        ` current: ${currentTreeSHA} for ${trackable.ref}` +
        ` tracked: ${trackedTreeSHA} for ${trackedRefCommitSHA}` +
        ` docker: ${dockerTreeSha} for ${dockerRefCommitSHA}`,
    );

    // The second check shouldn't be neccesary since dockerTreeSha is only
    // defined if dockerRefCommitSha is defined, but TypeScript doesn't know
    if (dockerTreeSha === trackedTreeSHA && dockerRefCommitSHA) {
      if (dockerRefCommitSHA !== trackable.ref) {
        core.info('(using docker sha)');
        trackable.refScalarTokenWriter.write(dockerRefCommitSHA);
      } else {
        // Commit sha is already whats written so no changes
        core.info('(unchanged)');
      }
    } else if (currentTreeSHA === trackedTreeSHA) {
      if (currentRefCommitSHA !== trackable.ref) {
        // This will freeze the current ref if it is a mutable ref.
        core.info('(freezing current ref)');
        trackable.refScalarTokenWriter.write(currentRefCommitSHA);
      } else {
        // Commit sha is already whats written so no changes
        core.info('(unchanged)');
      }
    } else {
      core.info('(updated to latest form ref!)');
      trackable.refScalarTokenWriter.write(trackedRefCommitSHA);
    }
  }
}
