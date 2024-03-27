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

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function main(): Promise<void> {
  try {
    const files = core.getInput('files');
    const globber = await glob.create(files);
    const filenames = await globber.glob();

    core.setOutput(
      'suggested-promotion-branch-name',
      `${core.getInput('promotion-target-regexp')}_${core.getInput('files')}`.replaceAll(
        /[^-a-zA-Z0-9._]/g,
        '_',
      ),
    );

    let gitHubClient: GitHubClient | null = null;
    let logOctokitStats: (() => void) | null = null;
    if (core.getBooleanInput('update-git-refs')) {
      const githubToken = core.getInput('github-token');
      const octokit = github.getOctokit(githubToken, throttling);
      const octokitGitHubClient = new OctokitGitHubClient(octokit);
      logOctokitStats = () => {
        for (const [name, count] of octokitGitHubClient.apiCalls) {
          core.info(`Total GH API calls for ${name}: ${count}`);
        }
      };
      gitHubClient = new CachingGitHubClient(octokitGitHubClient);
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
      processFile(f, gitHubClient, dockerRegistryClient),
    );

    logOctokitStats?.();
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

async function processFile(
  filename: string,
  gitHubClient: GitHubClient | null,
  dockerRegistryClient: DockerRegistryClient | null,
): Promise<void> {
  return core.group(`Processing ${filename}`, async () => {
    let contents = await readFile(filename, 'utf-8');

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
    }

    await writeFile(filename, contents);
  });
}

main();
