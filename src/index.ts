import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import { throttling } from '@octokit/plugin-throttling';
import { eachLimit } from 'async';
import { readFile, writeFile } from 'fs/promises';
import {
  ArtifactRegistryDockerRegistryClient,
  CachingDockerRegistryClient,
  CachingDockerRegistryClientDump,
  DockerRegistryClient,
  isCachingDockerRegistryClientDump,
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
import {
  PromotedCommitsByEnvironment,
  updatePromotedValues,
} from './update-promoted-values';
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

    const apiCacheFileName = core.getInput('api-cache');
    let initialAPICache: APICache | null = null;
    if (apiCacheFileName) {
      initialAPICache = await maybeReadAPICache(apiCacheFileName);
    }
    const finalAPICache: APICache = {
      version: 2,
      gitHub: null,
      dockerRegistry: null,
    };

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
        finalAPICache.gitHub = cachingGitHubClient.dump();
      };
    }

    let dockerRegistryClient: DockerRegistryClient | null = null;
    let finalizeDockerRegistryClient: (() => Promise<void>) | null = null;
    const artifactRegistryRepository =
      core.getInput('artifact-registry-repository') ||
      core.getInput('update-docker-tags-for-artifact-registry-repository');
    if (artifactRegistryRepository) {
      const artifactRegistryDockerRegistryClient =
        new ArtifactRegistryDockerRegistryClient(artifactRegistryRepository);
      const cachingDockerRegistryClient = new CachingDockerRegistryClient(
        artifactRegistryDockerRegistryClient,
        initialAPICache?.dockerRegistry,
      );
      dockerRegistryClient = cachingDockerRegistryClient;
      finalizeDockerRegistryClient = async () => {
        finalAPICache.dockerRegistry = cachingDockerRegistryClient.dump();
      };
    }

    const generatePromotedCommitsMarkdown = core.getBooleanInput(
      'generate-promoted-commits-markdown',
    );
    const doUpdateDockerTags =
      core.getBooleanInput('update-docker-tags') ||
      !!core.getInput('update-docker-tags-for-artifact-registry-repository');
    if (doUpdateDockerTags && !artifactRegistryRepository) {
      throw new Error(
        'Must set artifact-registry-repository with update-docker-tags',
      );
    }
    if (generatePromotedCommitsMarkdown && !artifactRegistryRepository) {
      throw new Error(
        'Must set artifact-registry-repository with generate-promoted-commits-markdown',
      );
    }

    const parallelism = +core.getInput('parallelism');
    const errors: { filename: string; error: unknown }[] = [];
    const promotedCommitsByFileThenEnvironment = new Map<
      string,
      PromotedCommitsByEnvironment
    >();
    await eachLimit(filenames, parallelism, async (filename) => {
      try {
        const { promotedCommitsByEnvironment } = await processFile({
          filename,
          gitHubClient,
          dockerRegistryClient,
          generatePromotedCommitsMarkdown,
          doUpdateDockerTags,
        });
        if (promotedCommitsByEnvironment) {
          promotedCommitsByFileThenEnvironment.set(
            shortFilename(filename),
            promotedCommitsByEnvironment,
          );
        }
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
      await finalizeDockerRegistryClient?.();
      if (apiCacheFileName) {
        await writeFile(apiCacheFileName, JSON.stringify(finalAPICache));
      }
    }

    if (
      generatePromotedCommitsMarkdown &&
      core.getBooleanInput('update-promoted-values')
    ) {
      core.setOutput(
        'promoted-commits-markdown',
        formatPromotedCommits(promotedCommitsByFileThenEnvironment),
      );
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message);
  }
}

function shortFilename(filename: string): string {
  return filename.startsWith(`${process.cwd()}/`)
    ? filename.substring(process.cwd().length + 1)
    : filename;
}

async function processFile(options: {
  filename: string;
  gitHubClient: GitHubClient | null;
  dockerRegistryClient: DockerRegistryClient | null;
  generatePromotedCommitsMarkdown: boolean;
  doUpdateDockerTags: boolean;
}): Promise<{
  promotedCommitsByEnvironment: PromotedCommitsByEnvironment | null;
}> {
  const {
    filename,
    gitHubClient,
    dockerRegistryClient,
    generatePromotedCommitsMarkdown,
    doUpdateDockerTags,
  } = options;
  const ret: {
    promotedCommitsByEnvironment: PromotedCommitsByEnvironment | null;
  } = { promotedCommitsByEnvironment: null };

  const logger = new PrefixingLogger(`[${shortFilename(filename)}] `);
  let contents = await readFile(filename, 'utf-8');

  if (dockerRegistryClient && doUpdateDockerTags) {
    contents = await updateDockerTags(contents, dockerRegistryClient, logger);
  }

  // The git refs depend on the docker tag potentially so we want to update it after the
  // docker tags are updated.
  if (gitHubClient) {
    contents = await updateGitRefs(contents, gitHubClient, logger);
  }

  if (core.getBooleanInput('update-promoted-values')) {
    const promotionTargetRegexp = core.getInput('promotion-target-regexp');
    const { newContents, promotedCommitsByEnvironment } =
      await updatePromotedValues(
        contents,
        promotionTargetRegexp || null,
        logger,
        generatePromotedCommitsMarkdown ? dockerRegistryClient : null,
      );
    contents = newContents;
    ret.promotedCommitsByEnvironment = promotedCommitsByEnvironment;
  }

  await writeFile(filename, contents);
  return ret;
}

interface APICache {
  version: 2;
  gitHub: CachingGitHubClientDump | null;
  dockerRegistry: CachingDockerRegistryClientDump | null;
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
    !('dockerRegistry' in parsed) ||
    !('version' in parsed) ||
    parsed.version !== 2
  ) {
    core.error(
      `Cache file ${apiCacheFileName} has the wrong structure; ignoring`,
    );
    return null;
  }

  if (parsed.gitHub !== null && !isCachingGitHubClientDump(parsed.gitHub)) {
    core.error(
      `Cache file ${apiCacheFileName} has the wrong structure under 'gitHub'; ignoring`,
    );
    return null;
  }
  if (
    parsed.dockerRegistry !== null &&
    !isCachingDockerRegistryClientDump(parsed.dockerRegistry)
  ) {
    core.error(
      `Cache file ${apiCacheFileName} has the wrong structure under 'dockerRegistry'; ignoring`,
    );
    return null;
  }

  return {
    version: parsed.version,
    gitHub: parsed.gitHub,
    dockerRegistry: parsed.dockerRegistry,
  };
}

function formatPromotedCommits(
  promotedCommitsByFileThenEnvironment: Map<
    string,
    PromotedCommitsByEnvironment
  >,
): string {
  return [...promotedCommitsByFileThenEnvironment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, promotedCommitsByEnvironment]) => {
      const fileHeader = `* ${filename}\n`;
      const byEnvironment = [...promotedCommitsByEnvironment.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([environment, promotedCommits]) => {
          const environmentHeader = `  - ${environment}\n`;
          const rest = (
            promotedCommits === null
              ? [
                  'This promotion is not between two known `main---` tags so the list of promoted commits cannot be determined.',
                ]
              : promotedCommits.length === 0
                ? ['No commits affect this Docker image.']
                : promotedCommits.map(({ commitURL }) => commitURL)
          ).map((line) => `    + ${line}\n`);
          return environmentHeader + rest.join('');
        });
      return fileHeader + byEnvironment.join('\n');
    })
    .join('');
}

main();
