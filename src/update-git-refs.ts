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

    if (trackable.ref === trackable.trackMutableRef) {
      // The mutable ref was written down in ref too. We always want to replace
      // that with the SHA (and if we do the path-based check below we won't,
      // because they're the same). This is something that might happen when
      // you're first adding an app (ie just writing the same thing twice and
      // letting the automation "correct" it to a SHA).
      trackable.refScalarTokenWriter.write(trackedRefCommitSHA);
      continue;
    }

    if (trackable.ref === trackedRefCommitSHA) {
      // The thing we would write is already in the file.
      continue;
    }

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
    if (trackedTreeSHA === null) {
      throw Error(
        `Could not get tree SHA for ${trackedRefCommitSHA} in ${trackable.repoURL} for ref ${trackable.path}`,
      );
    }
    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    core.info(
      `for path ${trackable.path}, got tree shas ${currentTreeSHA} for ${trackable.ref} and ${trackedTreeSHA} for ${trackedRefCommitSHA}`,
    );
    if (currentTreeSHA === trackedTreeSHA) {
      core.info('(unchanged)');
    } else {
      core.info('(changed!)');
      trackable.refScalarTokenWriter.write(trackedRefCommitSHA);
    }
  }
}
