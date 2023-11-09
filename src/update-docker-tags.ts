import * as core from '@actions/core';
import min from 'lodash/min';
import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  getTopLevelBlocks,
} from './yaml';

interface Trackable {
  trackMutableTag: string;
  dockerImageRepository: string;
  tag: string;
  tagScalarTokenWriter: ScalarTokenWriter;
}

export async function updateDockerTags(
  contents: string,
  dockerRegistryClient: DockerRegistryClient,
): Promise<string> {
  return core.group('Processing trackMutableTag', async () => {
    // See updateGitRefs for an explanation about our approach to parsing YAML.
    core.info('Parsing');
    const topLevelTokens = [...new yaml.Parser().parse(contents)];
    const documents = [
      ...new yaml.Composer({ keepSourceTokens: true }).compose(topLevelTokens),
    ];

    if (documents.length > 1) {
      throw new Error('Multiple documents in YAML file');
    }

    if (documents.length < 1) {
      return contents;
    }

    const document = documents[0];

    core.info('Looking for trackMutableTag');
    const trackables = findTrackables(document);

    core.info('Checking tags against Artifact Registry');
    await checkTagsAgainstArtifactRegistryAndModifyScalars(
      trackables,
      dockerRegistryClient,
    );
    core.info('Stringifying');
    return topLevelTokens
      .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
      .join('');
  });
}

function findTrackables(doc: yaml.Document.Parsed): Trackable[] {
  const trackables: Trackable[] = [];

  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  let globalDockerImageRepository: string | null = null;

  if (globalBlock?.has('dockerImage')) {
    const dockerImageBlock = globalBlock.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw Error('Document has `global.dockerImageBlock` that is not a map');
    }
    // Read repository from 'global' (keeping it null if it's not
    // there, though throwing if it's there as non-strings).
    globalDockerImageRepository = getStringValue(
      dockerImageBlock,
      'repository',
    );
  }

  for (const [key, value] of blocks) {
    if (!value.has('dockerImage')) {
      continue;
    }
    const dockerImageBlock = value.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw Error(`Document has \`${key}.dockerImage\` that is not a map`);
    }

    const dockerImageRepository =
      getStringValue(dockerImageBlock, 'repository') ??
      globalDockerImageRepository;
    const trackMutableTag = getStringValue(dockerImageBlock, 'trackMutableTag');
    const tagScalarTokenAndValue = getStringAndScalarTokenFromMap(
      dockerImageBlock,
      'tag',
    );

    if (trackMutableTag && dockerImageRepository && tagScalarTokenAndValue) {
      trackables.push({
        trackMutableTag,
        dockerImageRepository,
        tag: tagScalarTokenAndValue.value,
        tagScalarTokenWriter: new ScalarTokenWriter(
          tagScalarTokenAndValue.scalarToken,
          doc.schema,
        ),
      });
    }
  }

  return trackables;
}

async function checkTagsAgainstArtifactRegistryAndModifyScalars(
  trackables: Trackable[],
  dockerRegistryClient: DockerRegistryClient,
): Promise<void> {
  for (const trackable of trackables) {
    const prefix = `${trackable.trackMutableTag}---`;

    const equivalentTags = (
      await dockerRegistryClient.getAllEquivalentTags({
        dockerImageRepository: trackable.dockerImageRepository,
        tag: trackable.trackMutableTag,
      })
    ).filter((t) => t.startsWith(prefix));

    // We assume that all the tags with the triple-dash in them are immutable:
    // once they point at a particular SHA, they never change. (Whereas the tag
    // we're "tracking" is mutable.)
    //
    // If the current tag has the right format for an immutable tag and it
    // points to the same image as the mutable tag, leave it alone: there's no
    // reason to create a no-op diff.
    if (equivalentTags.includes(trackable.tag)) {
      core.info(
        `for image ${trackable.dockerImageRepository}:${trackable.trackMutableTag}, preserving current tag ${trackable.tag}`,
      );
      continue;
    }
    // We can choose *any* of these equivalent triple-dashed tags, and it will
    // select the correct image version.
    //
    // Our tag structure increase over time (by including the number of commits
    // since the start as determined by `git rev-list --first-parent --count
    // HEAD`), and also includes the git commit at which it was built.
    //
    // So by choosing the lexicographically earliest of the equivalent tags, we
    // are most likely to choose a tag where the named git commit actually is
    // the commit that made a relevant change that affected the image.
    //
    // Additionally, this means that reverting a code change is likely to result
    // in a revert of the tag.  Imagine that tag `main---00123-abcd` is
    // currently running in both staging and prod, and a code change moves
    // `main` to `main---00130-bcde` and this is deployed to staging (opening a
    // prod promotion PR). A bug is found, so the code change X is reverted.
    // Reproducible builds will mean that the newest tag `main---00134-dcba`
    // will hopefully point to the same image version as `main---00123-abcd`.
    // Choosing the min version here will mean that we will in fact "revert"
    // staging to `main---00123-abcd`. This is now the exact same tag that is
    // running in prod, so the prod promotion PR can auto-close rather than
    // encouraging us to consider a no-op deploy to prod.
    const earliestMatchingTag = min(equivalentTags);
    if (!earliestMatchingTag) {
      throw new Error(
        `No tags on ${trackable.dockerImageRepository} start with '${prefix}'`,
      );
    }

    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    core.info(
      `for image ${trackable.dockerImageRepository}:${trackable.trackMutableTag}, changing to minimal matching tag ${earliestMatchingTag}`,
    );
    trackable.tagScalarTokenWriter.write(earliestMatchingTag);
  }
}
