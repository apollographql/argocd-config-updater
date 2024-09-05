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
    }: {
      range: yaml.Range | null | undefined;
      lineCounter: yaml.LineCounter;
    },
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
    if (doUpdateGitRefs || generatePromotedCommitsMarkdown) {
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
    await eachLimit(filenames, parallelism, async (filename) => {
      try {
        const { promotionsByTargetEnvironment } = await processFile({
          filename,
          gitHubClient,
          dockerRegistryClient,
          generatePromotedCommitsMarkdown,
          doUpdateDockerTags,
          doUpdateGitRefs,
          linkTemplateMap,
          frozenEnvironments,
        });
        if (promotionsByTargetEnvironment) {
          promotionsByFileThenEnvironment.set(
            shortFilename(filename),
            promotionsByTargetEnvironment,
          );
        }
      } catch (error) {
        if (error instanceof AnnotatedError) {
          errors.push({
            error: error.message,
            annotation: {
              ...error,
              file: filename,
            },
          });
        } else {
          errors.push({
            error: inspect(error),
            annotation: {
              file: filename,
            },
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
  linkTemplateMap: LinkTemplateMap | null;
  frozenEnvironments: Set<string>;
}): Promise<{
  promotionsByTargetEnvironment: PromotionsByTargetEnvironment | null;
}> {
  const {
    filename,
    gitHubClient,
    dockerRegistryClient,
    generatePromotedCommitsMarkdown,
    doUpdateDockerTags,
    doUpdateGitRefs,
    linkTemplateMap,
    frozenEnvironments,
  } = options;
  const ret: {
    promotionsByTargetEnvironment: PromotionsByTargetEnvironment | null;
  } = { promotionsByTargetEnvironment: null };

  const logger = new PrefixingLogger(`[${shortFilename(filename)}] `);
  let contents = await readFile(filename, 'utf-8');

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

function formatPromotedCommits(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
): string {
  return [...promotionsByFileThenEnvironment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, promotionsByTargetEnvironment]) => {
      const fileHeader = `* ${filename}\n`;
      const byEnvironment = [...promotionsByTargetEnvironment.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([environment, environmentPromotions]) => {
          const { trimmedRepoURL, gitConfigPromotionInfo, dockerImage, links } =
            environmentPromotions;
          const lines = [`  - ${environment}\n`];
          for (const link of links) {
            lines.push(`    + [${link.text}](${link.url})\n`);
          }
          let alreadyMentionedGitNoCommits = false;
          if (dockerImage && dockerImage.promotionInfo.type !== 'no-change') {
            let maybeGitConfigNoCommits = '';
            if (gitConfigPromotionInfo.type === 'no-commits') {
              alreadyMentionedGitNoCommits = true;
              maybeGitConfigNoCommits =
                ' (and the git ref for the Helm chart made a no-op change to match)';
            }
            lines.push(
              `    + Changes to Docker image \`${dockerImage.repository}\`${maybeGitConfigNoCommits}\n`,
              ...(dockerImage.promotionInfo.type === 'no-commits'
                ? ['No changes affect the built Docker image.']
                : dockerImage.promotionInfo.type === 'unknown'
                  ? [
                      `Cannot determine set of changes to the Docker image: ${dockerImage.promotionInfo.message}`,
                    ]
                  : dockerImage.promotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `      * ${line}\n`),
            );
          }
          if (
            gitConfigPromotionInfo.type !== 'no-change' &&
            !alreadyMentionedGitNoCommits
          ) {
            lines.push(
              `    + Changes to Helm chart\n`,
              ...(gitConfigPromotionInfo.type === 'no-commits'
                ? // This one shows up when the ref changes even though there are no
                  // new commits. This is something we do to try to make the ref
                  // match the Docker tag, so it actually does happen frequently
                  // (though usually only when the Docker tag is making a
                  // substantive change) so this message might end up being a bit
                  // spammy; we can remove it if it's not helpful.

                  [
                    'The git ref for the Helm chart has changed, but there are no new commits in the range.',
                  ]
                : gitConfigPromotionInfo.type === 'unknown'
                  ? [
                      `Cannot determine set of changes to the Helm chart: ${gitConfigPromotionInfo.message}`,
                    ]
                  : gitConfigPromotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `      * ${line}\n`),
            );
          }
          return lines.join('');
        });
      return fileHeader + byEnvironment.join('\n');
    })
    .join('');
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
