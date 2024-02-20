import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { throttling } from '@octokit/plugin-throttling';
import { eachLimit } from 'async';
import { readFile, writeFile } from 'fs/promises';
import {
  ArtifactRegistryDockerRegistryClient,
  CachingDockerRegistryClient,
} from './artifactRegistry';
import { CachingGitHubClient, OctokitGitHubClient } from './github';
import { updateDockerTags } from './update-docker-tags';
import { updateGitRefs } from './update-git-refs';
import { updatePromotedValues } from './update-promoted-values';

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function main(): Promise<void> {
  try {
    const files = core.getInput('files');
    const globber = await glob.create(files);
    const filenames = await globber.glob();
    const parallelism = +core.getInput('parallelism');
    await eachLimit(filenames, parallelism, processFile);
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function processFile(filename: string): Promise<void> {
  return core.group(`Processing ${filename}`, async () => {
    let contents = await readFile(filename, 'utf-8');

    if (core.getBooleanInput('update-git-refs')) {
      const githubToken = core.getInput('github-token');
      const octokit = github.getOctokit(githubToken, throttling);
      const gitHubClient = new CachingGitHubClient(
        new OctokitGitHubClient(octokit),
      );
      contents = await updateGitRefs(contents, gitHubClient);
    }

    const artifactRegistryRepository = core.getInput(
      'update-docker-tags-for-artifact-registry-repository',
    );

    if (artifactRegistryRepository) {
      const dockerRegistryClient = new CachingDockerRegistryClient(
        new ArtifactRegistryDockerRegistryClient(artifactRegistryRepository),
      );
      contents = await updateDockerTags(contents, dockerRegistryClient);
    }

    if (core.getBooleanInput('update-promoted-values')) {
      const promotionTargetRegexp = core.getInput('promotion-target-regexp');
      contents = await updatePromotedValues(
        contents,
        promotionTargetRegexp || null,
      );
      core.setOutput(
        'sanitized-promotion-target-regexp',
        promotionTargetRegexp.replaceAll(/[^-a-zA-Z0-0._]/g, '_'),
      );
    }

    await writeFile(filename, contents);
  });
}

main();
