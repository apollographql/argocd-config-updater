import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { throttling } from '@octokit/plugin-throttling';
import { readFile, writeFile } from 'fs/promises';
import { ArtifactRegistryDockerRegistryClient } from './artifactRegistry';
import { OctokitGitHubClient } from './github';
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
    for (const filename of filenames) {
      await processFile(filename);
    }
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
      const gitHubClient = new OctokitGitHubClient(octokit);
      contents = await updateGitRefs(contents, gitHubClient);
    }

    const artifactRegistryRepository = core.getInput(
      'update-docker-tags-for-artifact-registry-repository',
    );

    if (artifactRegistryRepository) {
      const dockerRegistryClient = new ArtifactRegistryDockerRegistryClient(
        artifactRegistryRepository,
      );
      contents = await updateDockerTags(contents, dockerRegistryClient);
    }

    if (core.getBooleanInput('update-promoted-values')) {
      contents = await updatePromotedValues(
        contents,
        core.getInput('promotion-target-regexp') || null,
      );
    }

    await writeFile(filename, contents);
  });
}

main();
