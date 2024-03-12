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

export interface TrackingUpdates {
  stacks: string[];
  tracking: string;
}

export async function updateTracking(
  contents: string,
  trackingConfig: TrackingUpdates,
): Promise<string> {
  return core.group('Update tracking ref', async () => {
    const { document, stringify } = parseYAML(contents);

    // If the file is empty (or just whitespace or whatever), that's fine; we
    // can just leave it alone.
    if (!document) {
      return contents;
    }

    core.info('Looking for trackMutableRef');
    updateDoc(document, trackingConfig);
    return stringify();
  });
}

function updateDoc(doc: yaml.Document.Parsed, trackingConfig: TrackingUpdates) {

  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  for (const [key, value] of blocks) {
    if (!trackingConfig.stacks.includes(key)) {
      continue;
    }

    const refScalarTokenAndValue = getStringAndScalarTokenFromMap(
      value,
      'track',
    );

    if (refScalarTokenAndValue) {
      const writer = new ScalarTokenWriter(refScalarTokenAndValue.scalarToken, doc.schema);
      writer.write(trackingConfig.tracking)
    }
  }
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

    const dockerTreeSHA = dockerRefCommitSHA
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
        ` docker: ${dockerTreeSHA} for ${dockerRefCommitSHA}`,
    );

    // The second check shouldn't be neccesary since dockerTreeSHA is only
    // defined if dockerRefCommitSha is defined, but TypeScript doesn't know
    if (dockerTreeSHA === trackedTreeSHA && dockerRefCommitSHA) {
      if (dockerRefCommitSHA !== trackable.ref) {
        core.info('(using docker sha)');
        trackable.refScalarTokenWriter.write(dockerRefCommitSHA);
      } else {
        // Commit sha is already whats written so no changes
        core.info('(matches docker, unchanged)');
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
      core.info('(updated to latest from ref!)');
      trackable.refScalarTokenWriter.write(trackedRefCommitSHA);
    }
  }
}
