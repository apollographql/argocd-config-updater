import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { throttling } from '@octokit/plugin-throttling';
import { eachLimit } from 'async';
import { readFile, writeFile } from 'fs/promises';
import {
  ArtifactRegistryDockerRegistryClient,
  CachingDockerRegistryClient,
  DockerRegistryClient,
} from './artifactRegistry';
import {
  CachingGitHubClient,
  GitHubClient,
  OctokitGitHubClient,
} from './github';
import { updateDockerTags } from './update-docker-tags';
import { updateGitRefs } from './update-git-refs';
import { updatePromotedValues } from './update-promoted-values';
import { TrackingUpdates, updateTracking } from './update-tracking-ref';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function main(): Promise<void> {
  try {
    const files = core.getInput('files');
    const globber = await glob.create(files);
    const filenames = await globber.glob();

    const trackingUpdateValues = core.getInput('updater-tracker-value');
    const stacks = core.getMultilineInput('update-tracker-stacks');
    let tracking:  TrackingUpdates | null = null;
    if (trackingUpdateValues && stacks) {
      tracking = {
        tracking: trackingUpdateValues,
        stacks: stacks
      }
    }

    let gitHubClient: GitHubClient | null = null;
    if (core.getBooleanInput('update-git-refs')) {
      const githubToken = core.getInput('github-token');
      const octokit = github.getOctokit(githubToken, throttling);
      gitHubClient = new CachingGitHubClient(new OctokitGitHubClient(octokit));
    }

    let dockerRegistryClient: DockerRegistryClient | null = null;
    const artifactRegistryRepository = core.getInput(
      'update-docker-tags-for-artifact-registry-repository',
    );
    if (artifactRegistryRepository) {
      dockerRegistryClient = new CachingDockerRegistryClient(
        new ArtifactRegistryDockerRegistryClient(artifactRegistryRepository),
      );
    }

    const parallelism = +core.getInput('parallelism');
    await eachLimit(filenames, parallelism, async (f) =>
      processFile(f, tracking, gitHubClient, dockerRegistryClient),
    );
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function processFile(
  filename: string,
  trackingUpdate: TrackingUpdates | null,
  gitHubClient: GitHubClient | null,
  dockerRegistryClient: DockerRegistryClient | null,
): Promise<void> {
  return core.group(`Processing ${filename}`, async () => {
    let contents = await readFile(filename, 'utf-8');

    if (trackingUpdate) {
      contents = await updateTracking(contents, trackingUpdate);
    }

    if (dockerRegistryClient) {
      contents = await updateDockerTags(contents, dockerRegistryClient);
    }

    // The git refs depend on the docker tag potentially so we want to update it after the
    // docker tags are updated.
    if (gitHubClient) {
      contents = await updateGitRefs(contents, gitHubClient);
    }

    if (core.getBooleanInput('update-promoted-values')) {
      const promotionTargetRegexp = core.getInput('promotion-target-regexp');
      contents = await updatePromotedValues(
        contents,
        promotionTargetRegexp || null,
      );
      // Legacy: remove this once users switch over to suggested-promotion-branch-name.
      core.setOutput(
        'sanitized-promotion-target-regexp',
        promotionTargetRegexp.replaceAll(/[^-a-zA-Z0-9._]/g, '_'),
      );
      core.setOutput(
        'suggested-promotion-branch-name',
        `${promotionTargetRegexp}_${core.getInput('files')}`.replaceAll(
          /[^-a-zA-Z0-9._]/g,
          '_',
        ),
      );
    }

    await writeFile(filename, contents);
  });
}

main();
