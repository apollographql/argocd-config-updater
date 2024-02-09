import * as core from '@actions/core';
import { ArtifactRegistryClient } from '@google-cloud/artifact-registry';
import { sort as semverSort } from 'semver';

export interface GetAllEquivalentTagsOptions {
  /** The name of the specific Docker image in question (ie, a Docker
   * "repository", not an Artifact Registry "repository" that contains them.) */
  dockerImageRepository: string;
  tag: string;
}

export interface DockerRegistryClient {
  getAllEquivalentTags(options: GetAllEquivalentTagsOptions): Promise<string[]>;
  getLatestChartVersion(helmChart: string): Promise<string | null>;
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

    core.info(`Fetching tag ${tagPath}`);
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

    core.info(`Fetching Docker image ${dockerImagePath}`);
    const { tags } = (
      await this.client.getDockerImage({ name: dockerImagePath })
    )[0];
    if (!tags) {
      throw Error(`No tags returned for ${dockerImagePath}`);
    }
    return tags;
  }

  async getLatestChartVersion(helmChart: string): Promise<string | null> {
    // Input is relatively trusted; this is largely to prevent mistaken uses
    // like specifying a full Docker-style repository with slashes.
    if (helmChart.includes('/')) {
      throw Error('Chart name cannot have a slash');
    }

    const repositoryPath = this.client.pathTemplates.packagePathTemplate.render(
      {
        ...this.repositoryFields,
        package: helmChart,
      },
    );
    core.debug(`Using repository path ${repositoryPath}`);

    const versions = (
      await this.client.listTags({
        parent: repositoryPath,
        // Get max page size. Since this only things that end up on main we should stay under this for a while
        pageSize: 10000,
      })
    )[0]
      .map(
        (repo) =>
          this.client.pathTemplates.tagPathTemplate.match(repo.name || '')
            .tag as string,
      )
      .filter((tag) =>
        /[1-9]+\.[0-9]+\.[0-9]+-b[0-9]+\.g[a-zA-Z0-9]+/.test(tag),
      );
    core.debug(`Versions: ${JSON.stringify(versions)}`);
    const latestVersion = semverSort(versions).at(-1) || null;

    core.info(`Fetched tag ${latestVersion}`);
    return latestVersion;
  }
}
