import * as core from '@actions/core';
import {
  ArtifactRegistryClient,
  protos,
} from '@google-cloud/artifact-registry';
import { LRUCache } from 'lru-cache';
import { PromotionInfo, promotionInfoUnknown } from './promotionInfo';

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
  ): Promise<PromotionInfo>;
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
   * @param {string} prevTag The previous docker tag: of the following format:
   *   main---0013567-2024.04-g<githash>
   * @param {string} nextTag The next docker tag:
   *  main---0013567-2024.04-g<githash>
   *
   * @param {object} dockerImageRepository
   *
   * @returns {Promise} - The promise which resolves to an array of relevant
   * commit SHAs, or null if there's a promotion but we aren't able to map
   * that to commits (eg, it's not between two `main---` tags).
   */
  async getGitCommitsBetweenTags({
    prevTag,
    nextTag,
    dockerImageRepository,
  }: {
    prevTag: string;
    nextTag: string;
    dockerImageRepository: string;
  }): Promise<PromotionInfo> {
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
    )[0].map((iTag) => {
      const tag = new protos.google.devtools.artifactregistry.v1.Tag(iTag);
      return {
        // Trim off the path here, going from absolute path to the base name
        // "projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/tags/2022.02-278-g123456789"
        // Becomes: "2022.02-278-g123456789"
        tag: this.client.pathTemplates.tagPathTemplate.match(tag.name)
          .tag as string,
        version: tag.version,
      };
    });

    return getRelevantCommits(prevTag, nextTag, dockerTags);
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
  constructor(
    private wrapped: DockerRegistryClient,
    dump?: CachingDockerRegistryClientDump | null,
  ) {
    if (dump) {
      this.getGitCommitsBetweenTagsCache.load(dump.promotionsBetweenTags);
    }
  }
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

  private getGitCommitsBetweenTagsCache = new LRUCache<
    string,
    PromotionInfo,
    GitCommitsBetweenTagsOptions
  >({
    max: 1024,
    fetchMethod: async (_key, _staleValue, { context }) => {
      return await this.wrapped.getGitCommitsBetweenTags(context);
    },
  });

  async getGitCommitsBetweenTags(
    options: GitCommitsBetweenTagsOptions,
  ): Promise<PromotionInfo> {
    const cached = await this.getGitCommitsBetweenTagsCache.fetch(
      JSON.stringify(options),
      { context: options },
    );
    if (!cached) {
      throw Error(
        'getGitCommitsBetweenTagsCache.fetch should never resolve without a return value',
      );
    }
    return cached;
  }

  dump(): CachingDockerRegistryClientDump {
    // We cache the git commit list across executions, because assuming there's no
    // thrown error, both tags are main--- numbers that currently exist, so if
    // there aren't any force pushes to main then the set of relevant commits in
    // that range of history shouldn't change. (But don't dump
    // getAllEquivalentTagsCache since that changes over time!)
    return { promotionsBetweenTags: this.getGitCommitsBetweenTagsCache.dump() };
  }
}

export interface CachingDockerRegistryClientDump {
  promotionsBetweenTags: [string, LRUCache.Entry<PromotionInfo>][];
}

export function isCachingDockerRegistryClientDump(
  dump: unknown,
): dump is CachingDockerRegistryClientDump {
  if (!dump || typeof dump !== 'object') {
    return false;
  }
  if (!('promotionsBetweenTags' in dump)) {
    return false;
  }
  const { promotionsBetweenTags } = dump;
  if (!Array.isArray(promotionsBetweenTags)) {
    return false;
  }

  // XXX we could check the values further if we want to be more anal
  return true;
}

/**
 * An example format of a docker tag:
 * {
 *   "name":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/tags/2022.02-278-g123456789",
 *   "version":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/versions/sha256:123abc456defg"
 * }
 *
 * All of the information up to the final bits of information will be the same for all of these, though for version, we really only care about differences so we dont bother parsing anything out
 *
 * so we actually want to store these as:
 *
 * {
 *   "tag":"2022.02-278-g123456789",
 *   "version":"projects/platform-cross-environment/locations/us-central1/repositories/platform-docker/packages/identity/versions/sha256:123abc456defg"
 * }
 *
 */
export type DockerTag = {
  tag: string;
  version: string;
};

/**
 * getRelevantCommits
 *
 * @param {string} prevTag
 *   The previous docker tag: of the following format: main---0013567-2024.04-g<githash>
 *
 * @param {string} nextTag
 *  The next docker tag: main---0013567-2024.04-g<githash>
 *
 * @param {DockerTag[]} dockerTags
 *  The docker tags as we need to parse and filter into relevant commits. Provided by a previous call to the artifact registry.
 *
 * @returns {string[] | null} - The relevant commits as strings, or null if we can't calculate the list
 */
export function getRelevantCommits(
  prevTag: string,
  nextTag: string,
  dockerTags: DockerTag[],
): PromotionInfo {
  // We only want to speak authoratively about what is being promoted if both the
  // old and new tags are part of the linear `main---1234` order, and we know
  // their versions directly.
  if (!isMainTag(prevTag)) {
    return promotionInfoUnknown(
      `Old Docker tag \`${prevTag}\` does not start with \`main---\`.`,
    );
  }
  if (!isMainTag(nextTag)) {
    return promotionInfoUnknown(
      `New Docker tag \`${nextTag}\` does not start with \`main---\`.`,
    );
  }
  if (!dockerTags.some(({ tag }) => tag === nextTag)) {
    return promotionInfoUnknown(`New Docker tag \`${nextTag}\` unknown.`);
  }
  const prevTagVersion = dockerTags.find(({ tag }) => tag === prevTag)?.version;
  if (prevTagVersion === undefined) {
    return promotionInfoUnknown(`Old Docker tag \`${prevTag}\` unknown.`);
  }

  dockerTags = [...dockerTags]; // Don't mutate the argument
  dockerTags.sort((a, b) => a.tag.localeCompare(b.tag));

  // Put a "dummy" entry at the beginning of this list with the version
  // associated with the old tag. This means the logic below won't have to
  // special-case not including this version or special-case deduped being
  // empty; we slice it off before we return it.
  const deduped: { commit: string; version: string }[] = [
    { commit: '', version: prevTagVersion },
  ];
  for (const { tag, version } of dockerTags) {
    if (!isMainTag(tag)) continue;
    if (tag <= prevTag) continue;
    if (tag > nextTag) break;

    // We only care about the tags between prev and next that have a git commit
    const commit = tag.match(/-g([0-9a-fA-F]+)$/)?.[1];
    if (commit === undefined) {
      continue;
    }

    if (deduped[deduped.length - 1].version === version) {
      continue;
    }
    deduped.push({ commit, version });
  }
  // Slice off the version that is prevTagVersion.
  const commitSHAs = deduped.map(({ commit }) => commit).slice(1);

  return commitSHAs.length
    ? {
        type: 'commits',
        commitSHAs,
      }
    : { type: 'no-commits' };
}

function isMainTag(tag: string): boolean {
  return tag.startsWith('main---');
}
