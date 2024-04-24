import * as core from '@actions/core';
import { ArtifactRegistryClient } from '@google-cloud/artifact-registry';
import { LRUCache } from 'lru-cache';

export interface GetAllEquivalentTagsOptions {
  /** The name of the specific Docker image in question (ie, a Docker
   * "repository", not an Artifact Registry "repository" that contains them.) */
  dockerImageRepository: string;
  tag: string;
}

export interface GitCommitsBetweenTagsOptions {
  prevTag: string;
  nextTag: string;
  /** The name of the specific Docker image in question (ie, a Docker
   * "repository", not an Artifact Registry "repository" that contains them.) */
  dockerImageRepository: string;
}

export interface DockerRegistryClient {
  getAllEquivalentTags(options: GetAllEquivalentTagsOptions): Promise<string[]>;
  getGitCommitsBetweenTags(
    options: GitCommitsBetweenTagsOptions,
  ): Promise<string[]>;
}

export class ArtifactRegistryDockerRegistryClient {
  private client: ArtifactRegistryClient;
  private repositoryFields: {
    project: string;
    location: string;
    repository: string;
  };
  constructor(
    /** A string of the form
     * `projects/PROJECT/locations/LOCATION/repositories/REPOSITORY`; this is an
     * Artifact Registry repository, which is a set of Docker repositories. */
    artifactRegistryRepository: string,
  ) {
    this.client = new ArtifactRegistryClient();
    const { project, location, repository } =
      this.client.pathTemplates.repositoryPathTemplate.match(
        artifactRegistryRepository,
      );

    if (typeof project !== 'string') {
      throw Error(`String expected for 'project'`);
    }
    if (typeof location !== 'string') {
      throw Error(`String expected for 'location'`);
    }
    if (typeof repository !== 'string') {
      throw Error(`String expected for 'repository'`);
    }

    this.repositoryFields = { project, location, repository };
  }

  /**
   * getGitCommitsBetweenTags
   *
   * @param {string} prevTag
   *   The previous docker tag: of the following format: main---0013567-2024.04-g<githash>
   * @param {string} nextTag
   *  The next docker tag: main---0013567-2024.04-g<githash>
   *
   * @param {object} dockerImageRepository
   *
   * @returns {Promise} - The promise which resolves to an array of relevant commit strings.
   */
  async getGitCommitsBetweenTags({
    prevTag,
    nextTag,
    dockerImageRepository,
  }: {
    prevTag: string;
    nextTag: string;
    dockerImageRepository: string;
  }): Promise<string[]> {
    core.info(
      `running diff docker tags ${prevTag} ${nextTag} ${dockerImageRepository}`,
    );
    // Input is relatively trusted; this is largely to prevent mistaken uses
    // like specifying a full Docker-style repository with slashes.
    if (dockerImageRepository.includes('/')) {
      throw Error('repository cannot contain a slash');
    }

    // Note: we don't need `listTagsAsync` (which is recommended) because we
    // only care about the first element in the result array, which is the list of tags.
    // https://github.com/googleapis/gax-nodejs/blob/main/client-libraries.md#auto-pagination
    // These tags look like the following:
    // {
    //   "name":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/tags/2022.02-278-g123456789",
    //   "version":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/versions/sha256:123abc456defg"
    // }
    const dockerTags = (
      await this.client.listTags({
        parent: this.client.pathTemplates.packagePathTemplate.render({
          ...this.repositoryFields,
          package: dockerImageRepository,
        }),
      })
    )[0].filter((tag) => tag.version && tag.name);

    const relevantCommits = getRelevantCommits(
      prevTag,
      nextTag,
      dockerTags.map((tag) => ({
        name: tag.name as string,
        version: tag.version as string,
      })),
      (dockerTag: DockerTag) => {
        return this.client.pathTemplates.tagPathTemplate.match(dockerTag.name)
          .tag as string;
      },
    );

    return relevantCommits;
  }

  async getAllEquivalentTags({
    dockerImageRepository,
    tag,
  }: GetAllEquivalentTagsOptions): Promise<string[]> {
    // Input is relatively trusted; this is largely to prevent mistaken uses
    // like specifying a full Docker-style repository with slashes.
    if (dockerImageRepository.includes('/')) {
      throw Error('repository cannot contain a slash');
    }
    if (tag.includes('/')) {
      throw Error('tag cannot contain a slash');
    }

    const tagPath = this.client.pathTemplates.tagPathTemplate.render({
      ...this.repositoryFields,
      package: dockerImageRepository,
      tag,
    });

    core.info(`[AR API] Fetching tag ${tagPath}`);
    // Note: this throws if the repository or tag are not found.
    const { version } = (await this.client.getTag({ name: tagPath }))[0];
    if (!version) {
      throw Error(`No version found for ${tagPath}`);
    }

    // It may seem like you can just use `this.client.getVersion({name: version,
    // view: 'FULL'})` here and look in the "relatedTags" field, but that field
    // only shows at most 100 tags. Instead, use the Docker Image-specific API
    // which returns all tags.

    const parsedVersion =
      this.client.pathTemplates.versionPathTemplate.match(version);

    const dockerImagePath =
      this.client.pathTemplates.dockerImagePathTemplate.render({
        ...this.repositoryFields,
        docker_image: `${parsedVersion.package}@${parsedVersion.version}`,
      });

    core.info(`[AR API] Fetching Docker image ${dockerImagePath}`);
    const { tags } = (
      await this.client.getDockerImage({ name: dockerImagePath })
    )[0];
    if (!tags) {
      throw Error(`No tags returned for ${dockerImagePath}`);
    }
    return tags;
  }
}

export class CachingDockerRegistryClient {
  constructor(private wrapped: DockerRegistryClient) {}
  private getAllEquivalentTagsCache = new LRUCache<
    string,
    string[],
    GetAllEquivalentTagsOptions
  >({
    max: 1024,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return this.wrapped.getAllEquivalentTags(context);
    },
  });

  async getGitCommitsBetweenTags(
    options: GitCommitsBetweenTagsOptions,
  ): Promise<string[]> {
    // For now we aren't caching anything since this will only run on promotion prs
    return this.wrapped.getGitCommitsBetweenTags(options);
  }

  async getAllEquivalentTags(
    options: GetAllEquivalentTagsOptions,
  ): Promise<string[]> {
    const tags = await this.getAllEquivalentTagsCache.fetch(
      JSON.stringify(options),
      { context: options },
    );
    if (!tags) {
      throw Error(
        'getAllEquivalentTagsCache.fetch should never resolve without a list of tags',
      );
    }
    return tags;
  }
}

/**
 * An example format of a docker tag:
 * {
 *   "name":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/tags/2022.02-278-g123456789",
 *   "version":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/versions/sha256:123abc456defg"
 * }
 *
 */
export type DockerTag = {
  name: string;
  version: string;
};

/**
 * getRelevantCommits
 *
 * @param {string} prevTag
 *   The previous docker tag: of the following format: main---0013567-2024.04-g<githash>
 * @param {string} nextTag
 *  The next docker tag: main---0013567-2024.04-g<githash>
 *
 * @param {DockerTag[]} dockerTags
 *  The docker tags as we need to parse and filter into relevant commits. Provided by a previous call to the artifact registry.
 *
 *
 * @param {function} getTagFromDockerTag
 *   Should map from `projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/servicename/tags/2022.02-278-g123456789` -> `2022.02-278-g123456789`
 *   Should be a wrapper around the ArtifactRegistryClient, but written this way for testability, so the behavior can be injected.
 *
 * @returns {string[]} - The relevant commits as strings
 */
export function getRelevantCommits(
  prevTag: string,
  nextTag: string,
  dockerTags: DockerTag[],
  getTagFromDockerTag: (dockerTag: DockerTag) => string,
): string[] {
  if (!prevTag.startsWith('main')) return [];
  if (!nextTag.startsWith('main')) return [];

  /**
   * Going to loop over our docker tags, filtering out ones outside the relevant range, and build an array of tag info.
   *
   * We will then do some commit deduping and return a list of relevant commits.
   */
  const relevantCommitsWithTagInfo = new Array<{
    version: string;
    tag: string;
    commit: string;
  }>();

  for (const dockerTag of dockerTags) {
    if (!dockerTag.version || !dockerTag.name) continue;

    const tag = getTagFromDockerTag(dockerTag);

    if (!tag.startsWith('main')) continue;
    if (!tagInRange(prevTag, nextTag, tag)) continue;

    // We only care about the tags between prev and next that have a git commit
    const gitCommitMatches = tag.match(/-g([0-9a-fA-F]+)$/);
    if (gitCommitMatches) {
      const currTagInfo = {
        version: dockerTag.version,
        tag,
        commit: gitCommitMatches[1],
      };
      relevantCommitsWithTagInfo.push(currTagInfo);
    }
  }

  const result = dedupNeighboringTags(relevantCommitsWithTagInfo)
    .sort((a, b) => a.tag.localeCompare(b.tag))
    .map((c) => c.commit);

  return result;
}

function tagInRange(prevTag: string, nextTag: string, tag: string): boolean {
  return tag > prevTag && tag < nextTag;
}

function dedupNeighboringTags(
  tags: { version: string; tag: string; commit: string }[],
): { version: string; tag: string; commit: string }[] {
  if (tags.length === 0) {
    return [];
  }

  const res = [tags[0]];
  for (let i = 1; i < tags.length; i++) {
    const currTag = tags[i];
    const prevTag = tags[i - 1];
    if (currTag.commit !== prevTag.commit) {
      res.push(currTag);
    }
  }
  return res;
}
