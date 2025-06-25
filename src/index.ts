import * as core from '@actions/core';
import * as github from '@actions/github';
import * as glob from '@actions/glob';
import * as yaml from 'yaml';
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
import { updatePromotedValues } from './update-promoted-values';
import { PrefixingLogger } from './log';
import { inspect } from 'util';
import { PromotionsByTargetEnvironment } from './promotionInfo';
import { LinkTemplateMap, readLinkTemplateMapFile } from './templates';
import { formatPromotedCommits } from './format-promoted-commits';
import { CleanupChange, formatCleanupChanges } from './format-cleanup-changes';
import { cleanupClosedPrTracking } from './update-closed-prs';

export class AnnotatedError extends Error {
  startLine: number | undefined;
  startColumn: number | undefined;
  endLine: number | undefined;
  endColumn: number | undefined;

  constructor(
    message: string,
    {
      range,
      lineCounter,
    }: { range: yaml.Range | null | undefined; lineCounter: yaml.LineCounter },
  ) {
    super(message);
    if (range) {
      ({ line: this.startLine, col: this.startColumn } = lineCounter.linePos(
        range[0],
      ));
      // End is exclusive, so subtract 1
      ({ line: this.endLine, col: this.endColumn } = lineCounter.linePos(
        range[2] - 1,
      ));
    }
  }
}

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
    const generatePromotedCommitsMarkdown = core.getBooleanInput(
      'generate-promoted-commits-markdown',
    );
    const doUpdateGitRefs = core.getBooleanInput('update-git-refs');
    const doCleanupClosedPrTracking = core.getBooleanInput(
      'cleanup-closed-pr-tracking',
    );
    if (
      doUpdateGitRefs ||
      generatePromotedCommitsMarkdown ||
      doCleanupClosedPrTracking
    ) {
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
    const linkTemplateFile = core.getInput('link-template-file');
    const linkTemplateMap: LinkTemplateMap | null = linkTemplateFile
      ? await readLinkTemplateMapFile(linkTemplateFile)
      : null;

    const frozenEnvironmentsFile = core.getInput('frozen-environments-file');
    const frozenEnvironments = frozenEnvironmentsFile
      ? await readFrozenEnvironmentsFile(frozenEnvironmentsFile)
      : new Set<string>();

    const parallelism = +core.getInput('parallelism');
    const errors: {
      error: string;
      annotation: {
        file: string;
        startLine?: number;
        startColumn?: number;
        endLine?: number;
        endColumn?: number;
      };
    }[] = [];
    const promotionsByFileThenEnvironment = new Map<
      string,
      PromotionsByTargetEnvironment
    >();
    const allCleanupChanges: CleanupChange[] = [];
    await eachLimit(filenames, parallelism, async (filename) => {
      try {
        const { promotionsByTargetEnvironment, cleanupChanges } =
          await processFile({
            filename,
            gitHubClient,
            dockerRegistryClient,
            generatePromotedCommitsMarkdown,
            doUpdateDockerTags,
            doUpdateGitRefs,
            doCleanupClosedPrTracking,
            linkTemplateMap,
            frozenEnvironments,
          });
        if (promotionsByTargetEnvironment) {
          promotionsByFileThenEnvironment.set(
            shortFilename(filename),
            promotionsByTargetEnvironment,
          );
        }
        allCleanupChanges.push(...cleanupChanges);
      } catch (error) {
        if (error instanceof AnnotatedError) {
          errors.push({
            error: error.message,
            annotation: { ...error, file: filename },
          });
        } else {
          errors.push({
            error: inspect(error),
            annotation: { file: filename },
          });
        }
      }
    });
    if (errors.length) {
      core.setFailed(
        `Errors occurred while processing ${errors.length} file${errors.length > 1 ? 's' : ''}`,
      );
      for (const { error, annotation } of errors) {
        core.error(error, annotation);
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
        formatPromotedCommits(promotionsByFileThenEnvironment),
      );
    }

    if (doCleanupClosedPrTracking && allCleanupChanges.length > 0) {
      core.setOutput(
        'cleanup-changes-markdown',
        formatCleanupChanges(allCleanupChanges),
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
  doUpdateGitRefs: boolean;
  doCleanupClosedPrTracking: boolean;
  linkTemplateMap: LinkTemplateMap | null;
  frozenEnvironments: Set<string>;
}): Promise<{
  promotionsByTargetEnvironment: PromotionsByTargetEnvironment | null;
  cleanupChanges: CleanupChange[];
}> {
  const {
    filename,
    gitHubClient,
    dockerRegistryClient,
    generatePromotedCommitsMarkdown,
    doUpdateDockerTags,
    doUpdateGitRefs,
    doCleanupClosedPrTracking,
    linkTemplateMap,
    frozenEnvironments,
  } = options;
  const ret: {
    promotionsByTargetEnvironment: PromotionsByTargetEnvironment | null;
    cleanupChanges: CleanupChange[];
  } = { promotionsByTargetEnvironment: null, cleanupChanges: [] };

  const logger = new PrefixingLogger(`[${shortFilename(filename)}] `);
  let contents = await readFile(filename, 'utf-8');

  if (doCleanupClosedPrTracking && gitHubClient) {
    const result = await cleanupClosedPrTracking({
      contents,
      frozenEnvironments,
      gitHubClient,
      logger,
    });
    contents = result.contents;
    ret.cleanupChanges = result.changes;
  }

  if (dockerRegistryClient && doUpdateDockerTags) {
    contents = await updateDockerTags(
      contents,
      dockerRegistryClient,
      frozenEnvironments,
      logger,
    );
  }

  // The git refs depend on the docker tag potentially so we want to update it after the
  // docker tags are updated.
  if (gitHubClient && doUpdateGitRefs) {
    contents = await updateGitRefs(
      contents,
      gitHubClient,
      frozenEnvironments,
      logger,
    );
  }

  if (core.getBooleanInput('update-promoted-values')) {
    const promotionTargetRegexp = core.getInput('promotion-target-regexp');
    const { newContents, promotionsByTargetEnvironment } =
      await updatePromotedValues(
        contents,
        promotionTargetRegexp || null,
        frozenEnvironments,
        logger,
        generatePromotedCommitsMarkdown ? dockerRegistryClient : null,
        generatePromotedCommitsMarkdown ? gitHubClient : null,
        linkTemplateMap,
      );
    contents = newContents;
    ret.promotionsByTargetEnvironment = promotionsByTargetEnvironment;
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

export async function readFrozenEnvironmentsFile(
  filename: string,
): Promise<Set<string>> {
  const contents = await readFile(filename, 'utf-8');
  const parsed = yaml.parse(contents) as unknown;
  if (!Array.isArray(parsed)) {
    throw Error(
      `Frozen environments file ${filename} must be a list at the top level`,
    );
  }
  const ret = new Set<string>();
  for (const element of parsed) {
    if (typeof element !== 'string') {
      throw Error(
        `All elements of top-level list in frozen environments file ${filename} must be strings`,
      );
    }
    ret.add(element);
  }
  return ret;
}

main();
