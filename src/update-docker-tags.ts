import min from 'lodash/min';
import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';
import { AnnotatedError } from './annotatedError';

interface Trackable {
  trackMutableTag: string;
  dockerImageRepository: string;
  tag: string;
  tagScalarTokenWriter: ScalarTokenWriter;
  trackRange: yaml.Range | null | undefined;
}

export async function updateDockerTags(
  contents: string,
  dockerRegistryClient: DockerRegistryClient,
  frozenEnvironments: Set<string>,
  _logger: PrefixingLogger,
): Promise<string> {
  const logger = _logger.withExtendedPrefix('[trackMutableTag] ');
  const { document, lineCounter, stringify } = parseYAML(contents);

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.
  if (!document) {
    return contents;
  }

  logger.info('Looking for trackMutableTag');
  const trackables = findTrackables(document, frozenEnvironments, lineCounter);

  logger.info('Checking tags against Artifact Registry');
  await checkTagsAgainstArtifactRegistryAndModifyScalars(
    trackables,
    lineCounter,
    dockerRegistryClient,
    logger,
  );
  return stringify();
}

function findTrackables(
  doc: yaml.Document.Parsed,
  frozenEnvironments: Set<string>,
  lineCounter: yaml.LineCounter,
): Trackable[] {
  const trackables: Trackable[] = [];

  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  let globalDockerImageRepository: string | null = null;

  if (globalBlock?.has('dockerImage')) {
    const dockerImageBlock = globalBlock.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw new AnnotatedError(
        'Document has `global.dockerImageBlock` that is not a map',
        {
          range: dockerImageBlock?.range,
          lineCounter,
        },
      );
    }
    // Read repository from 'global' (keeping it null if it's not
    // there, though throwing if it's there as non-strings).
    globalDockerImageRepository = getStringValue(
      dockerImageBlock,
      'repository',
    );
  }

  for (const [key, value] of blocks) {
    if (frozenEnvironments.has(key)) {
      continue;
    }

    if (!value.has('dockerImage')) {
      continue;
    }
    const dockerImageBlock = value.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw new AnnotatedError(
        `Document has \`${key}.dockerImage\` that is not a map`,
        {
          range: dockerImageBlock?.range,
          lineCounter,
        },
      );
    }

    const dockerImageRepository =
      getStringValue(dockerImageBlock, 'repository') ??
      globalDockerImageRepository;
    // Tracking can be specified at `dockerImage.trackMutableTag` or just at
    // `track`.
    const trackMutableTag =
      getStringAndScalarTokenFromMap(dockerImageBlock, 'trackMutableTag') ??
      getStringAndScalarTokenFromMap(value, 'track');
    const tagScalarTokenAndValue = getStringAndScalarTokenFromMap(
      dockerImageBlock,
      'tag',
    );

    if (
      trackMutableTag &&
      trackMutableTag?.value &&
      dockerImageRepository &&
      tagScalarTokenAndValue
    ) {
      trackables.push({
        trackMutableTag: trackMutableTag.value,
        dockerImageRepository,
        tag: tagScalarTokenAndValue.value,
        trackRange: trackMutableTag.range,
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
  lineCounter: yaml.LineCounter,
  dockerRegistryClient: DockerRegistryClient,
  logger: PrefixingLogger,
): Promise<void> {
  for (const trackable of trackables) {
    const prefix = `${trackable.trackMutableTag}---`;

    const equivalentTags = (
      await (async () => {
        try {
          return await dockerRegistryClient.getAllEquivalentTags({
            dockerImageRepository: trackable.dockerImageRepository,
            tag: trackable.trackMutableTag,
          });
        } catch (e) {
          if (e instanceof Error) {
            let message = e.message;
            if (e.message === `5 NOT_FOUND: Requested entity was not found.`) {
              message = `The tag '${trackable.trackMutableTag}' on the Docker image '${
                trackable.dockerImageRepository
              }' does not exist. Check that both the image and tag are spelled correctly.`;
              if (trackable.trackMutableTag.startsWith('pr-')) {
                message +=
                  ' Check that the Docker image has been successfully built ' +
                  'at least once after the PR was created. (CircleCI workflows ' +
                  'that started before the PR was created do not count! Push ' +
                  'another change to trigger a build that knows the PR number.)';
              }
            }
            throw new AnnotatedError(message, {
              range: trackable?.trackRange,
              lineCounter,
            });
          } else {
            throw e;
          }
        }
      })()
    ).filter((t) => t.startsWith(prefix));

    // We assume that all the tags with the triple-dash in them are immutable:
    // once they point at a particular SHA, they never change. (Whereas the tag
    // we're "tracking" is mutable.)
    //
    // If the current tag has the right format for an immutable tag and it
    // points to the same image as the mutable tag, leave it alone: there's no
    // reason to create a no-op diff.
    if (equivalentTags.includes(trackable.tag)) {
      logger.info(
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
    logger.info(
      `for image ${trackable.dockerImageRepository}:${trackable.trackMutableTag}, changing to minimal matching tag ${earliestMatchingTag}`,
    );
    trackable.tagScalarTokenWriter.write(earliestMatchingTag);
  }
}
