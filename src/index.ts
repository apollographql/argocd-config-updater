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
  CachingGitHubClientDump,
  GitHubClient,
  OctokitGitHubClient,
  isCachingGitHubClientDump,
} from './github';
import { updateDockerTags } from './update-docker-tags';
import { updateGitRefs } from './update-git-refs';
import { updatePromotedValues } from './update-promoted-values';
import { PrefixingLogger } from './log';
import { inspect } from 'util';

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
    let finalizeGitHubClient: (() => Promise<void>) | null = null;
    if (core.getBooleanInput('update-git-refs')) {
      const githubToken = core.getInput('github-token');
      const octokit = github.getOctokit(
        githubToken,
        {
          throttle: {
            onRateLimit: (retryAfter, options) => {
              core.warning(
                `[RATE LIMIT] Hit GH rate limit for request ${options.method} ${options.url}; retrying after ${retryAfter} seconds`,
              );
              return true;
            },
            onSecondaryRateLimit: (retryAfter, options) => {
              core.warning(
                `[RATE LIMIT] Hit secondary GH rate limit for request ${options.method} ${options.url}; retrying after ${retryAfter} seconds`,
              );
              return true;
            },
          },
        },
        throttling,
      );

      // Log GH rate limit response headers after each response and at the end.
      let lastRateLimitHeaderInfo: string | null = null;
      octokit.hook.after('request', async (response) => {
        const prefix = 'x-ratelimit-';
        const rateLimitHeaders: string[] = [];
        for (const [name, value] of Object.entries(response.headers)) {
          if (name.startsWith(prefix)) {
            rateLimitHeaders.push(`${name.substring(prefix.length)}=${value}`);
          }
        }

        if (rateLimitHeaders.length) {
          const rateLimitHeaderInfo = rateLimitHeaders.join(', ');
          lastRateLimitHeaderInfo = rateLimitHeaderInfo;
          core.info(`[GH Rate Limit Info] ${rateLimitHeaderInfo}`);
        }
      });

      const octokitGitHubClient = new OctokitGitHubClient(octokit);

      const apiCacheFileName = core.getInput('api-cache');
      let initialAPICache: APICache | null = null;
      if (apiCacheFileName) {
        initialAPICache = await maybeReadAPICache(apiCacheFileName);
      }

      const cachingGitHubClient = new CachingGitHubClient(
        octokitGitHubClient,
        initialAPICache?.gitHub,
      );

      gitHubClient = cachingGitHubClient;

      finalizeGitHubClient = async () => {
        for (const [name, count] of octokitGitHubClient.apiCalls) {
          core.info(`Total GH API calls for ${name}: ${count}`);
        }
        if (lastRateLimitHeaderInfo) {
          core.info(`Last GH Rate Limit Info: ${lastRateLimitHeaderInfo}`);
        }
        if (apiCacheFileName) {
          const finalAPICache: APICache = {
            version: 1,
            gitHub: cachingGitHubClient.dump(),
          };
          await writeFile(apiCacheFileName, JSON.stringify(finalAPICache));
        }
      };
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
    const errors: { filename: string; error: unknown }[] = [];
    await eachLimit(filenames, parallelism, async (filename) => {
      try {
        await processFile(filename, gitHubClient, dockerRegistryClient);
      } catch (error) {
        errors.push({ filename, error });
      }
    });
    if (errors.length) {
      core.setFailed(
        `Errors occurred while processing ${errors.length} file${errors.length > 1 ? 's' : ''}`,
      );
      for (const { filename, error } of errors) {
        core.error(`Error while processing ${filename}: ${inspect(error)}`);
      }
    } else {
      await finalizeGitHubClient?.();
    }
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
  const shortFilename = filename.startsWith(`${process.cwd()}/`)
    ? filename.substring(process.cwd().length + 1)
    : filename;
  const logger = new PrefixingLogger(`[${shortFilename}] `);
  let contents = await readFile(filename, 'utf-8');

  if (dockerRegistryClient) {
    contents = await updateDockerTags(contents, dockerRegistryClient, logger);
  }

  // The git refs depend on the docker tag potentially so we want to update it after the
  // docker tags are updated.
  if (gitHubClient) {
    contents = await updateGitRefs(contents, gitHubClient, logger);
  }

  if (core.getBooleanInput('update-promoted-values')) {
    const promotionTargetRegexp = core.getInput('promotion-target-regexp');
    contents = await updatePromotedValues(
      contents,
      promotionTargetRegexp || null,
      logger,
    );
  }

  await writeFile(filename, contents);
}

interface APICache {
  version: 1;
  gitHub: CachingGitHubClientDump;
}

async function maybeReadAPICache(
  apiCacheFileName: string,
): Promise<APICache | null> {
  let apiCacheText: string;
  try {
    apiCacheText = await readFile(apiCacheFileName, 'utf8');
  } catch (e) {
    core.error(`Error reading cache file ${apiCacheFileName}, ignoring: ${e}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(apiCacheText);
  } catch (e) {
    core.error(`Error parsing cache file ${apiCacheFileName}, ignoring: ${e}`);
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('gitHub' in parsed) ||
    !('version' in parsed) ||
    parsed.version !== 1
  ) {
    core.error(
      `Cache file ${apiCacheFileName} has the wrong structure; ignoring`,
    );
    return null;
  }

  if (!isCachingGitHubClientDump(parsed.gitHub)) {
    core.error(
      `Cache file ${apiCacheFileName} has the wrong structure under 'gitHub'; ignoring`,
    );
    return null;
  }

  return { version: parsed.version, gitHub: parsed.gitHub };
}

main();
