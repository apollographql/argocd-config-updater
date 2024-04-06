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
    const dockerTags = (
      await this.client.listTags({
        parent: this.client.pathTemplates.packagePathTemplate.render({
          ...this.repositoryFields,
          package: dockerImageRepository,
        }),
      })
    )[0];

    // We are going to get all of the relevant tags with unique hashes.

    // We want to get the minimum tag for each version, since this implies those commits
    // made a change to the docker image so are relevant to the diff.
    // Tags are of the format `main---0013572-2024.04-acbdef1234558193abc9e24a476133a771ca979c2`
    const tagBoundsMap = new Map<string, { tag: string; commit: string }>();
    for (const dockerTag of dockerTags) {
      if (!dockerTag.version || !dockerTag.name) continue;

      const { tag } = this.client.pathTemplates.tagPathTemplate.match(
        dockerTag.name,
      );

      // If it is a number we can ignore the tag
      if (typeof tag !== 'string') continue;

      // We only care about the tags between prev and next that have a git commit
      const gitCommitMatches = tag.match(/-g([0-9a-fA-F]+)$/);
      if (!gitCommitMatches) continue;

      // Only include tags newer than previous, and older than next.
      // Note, this may need some rework later when we explicitly want to call out rollbacks
      // and other shenanigans.
      if (tag >= nextTag || tag <= prevTag) continue;

      if (
        ((tag >= prevTag && tag <= nextTag) ||
          (tag <= prevTag && tag >= nextTag)) &&
        gitCommitMatches
      ) {
        const minTag = tagBoundsMap.get(dockerTag.version);
        if (minTag && minTag.tag > tag) {
          minTag.tag = tag;
          minTag.commit = gitCommitMatches[1];
        } else {
          tagBoundsMap.set(dockerTag.version, {
            tag,
            commit: gitCommitMatches[1],
          });
        }
      }
    }

    const relevantCommits = new Array<{ tag: string; commit: string }>();

    for (const tagBound of tagBoundsMap.values()) {
      // We can skip the tag we are just coming from as a min
      if (tagBound.tag === prevTag) {
        continue;
      }
      relevantCommits.push(tagBound);
    }

    core.info(`Relevant Commits ${Array.from(relevantCommits).join(', ')}`);

    // Sort commits ascending
    return relevantCommits
      .sort((a, b) => a.tag.localeCompare(b.tag))
      .map((c) => c.commit);
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
    // For now we aren't caching anything since this will on run on promotion prs
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

export type Tag = {
  name: string;
  version: string;
};

export function getTagsInRange(prevTag: Tag, nextTag: Tag, tags: Tag[]): Tag[] {
  if (!(isMainTag(prevTag) && isMainTag(nextTag))) {
    return [];
  }

  const sortedTags = [...tags].sort((a, b) => (a.version > b.version ? 1 : -1));
  const res = sortedTags.filter((tag) => {
    return tag.version > prevTag.version && tag.version < nextTag.version;
  });
  return res;
}

function isMainTag(tag: Tag): boolean {
  return tag.version.startsWith('main---');
}
