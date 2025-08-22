import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getMapFromSeqWithName,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';
import { AnnotatedError } from './index';

export interface TrackableGraphArtifact {
  imageName: string;
  tag: string;
  trackRange: yaml.Range | null | undefined;
  graphArtifactRef: string;
  refScalarTokenWriter: ScalarTokenWriter;
}

export async function updateGraphArtifactRefs(
  contents: string,
  dockerRegistryClient: DockerRegistryClient,
  frozenEnvironments: Set<string>,
  _logger: PrefixingLogger,
): Promise<string> {
  const logger = _logger.withExtendedPrefix('[graphArtifacts] ');

  const { document, lineCounter, stringify } = parseYAML(contents);

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.`
  if (!document) {
    return contents;
  }

  logger.info('Looking for trackable graph artifact refs');
  const trackables = findTrackables(document, frozenEnvironments);

  logger.info('Checking refs against OCI registry');
  await checkTagsAgainstArtifactRegistryAndModifyScalars(
    trackables,
    lineCounter,
    dockerRegistryClient,
    logger,
  );
  return stringify();
}

export function findTrackables(
  doc: yaml.Document.Parsed,
  frozenEnvironments: Set<string>,
): TrackableGraphArtifact[] {
  const trackables: TrackableGraphArtifact[] = [];
  const { blocks } = getTopLevelBlocks(doc);

  for (const [key, value] of blocks) {
    if (frozenEnvironments.has(key)) {
      continue;
    }
    if (!value?.has('trackSupergraph')) {
      // Exit early since this isn't tracking a supergraph artifact at all
      continue;
    }
    const trackSupergraph = getStringAndScalarTokenFromMap(
      value,
      'trackSupergraph',
    );
    const [, imageName, tag] =
      trackSupergraph?.value.match(/^([^:]+):([^:]+)$/) || [];
    const graphArtifactMap = getMapFromSeqWithName(
      value.getIn([
        'values',
        'router',
        'extraEnvVars',
      ]) as yaml.YAMLSeq<yaml.YAMLMap>,
      'GRAPH_ARTIFACT_REFERENCE',
    );
    if (graphArtifactMap === null) {
      throw Error(
        `Document does not provide \`${key}.values.router.extraEnvVars\` with GRAPH_ARTIFACT_REFERENCE that is a map`,
      );
    }
    const graphArtifactRef = getStringAndScalarTokenFromMap(
      graphArtifactMap,
      'value',
    );
    if (imageName && tag && graphArtifactRef) {
      trackables.push({
        imageName,
        tag,
        trackRange: trackSupergraph?.range,
        graphArtifactRef: graphArtifactRef.value,
        refScalarTokenWriter: new ScalarTokenWriter(
          graphArtifactRef.scalarToken,
          doc.schema,
        ),
      });
    }
  }

  return trackables;
}

async function checkTagsAgainstArtifactRegistryAndModifyScalars(
  trackables: TrackableGraphArtifact[],
  lineCounter: yaml.LineCounter,
  dockerRegistryClient: DockerRegistryClient,
  logger: PrefixingLogger,
): Promise<void> {
  for (const trackable of trackables) {
    const [, graphArtifactReferencePrefix] =
      trackable.graphArtifactRef.match(/^(.*?)@/) || [];
    const digest = await (async () => {
      try {
        return await dockerRegistryClient.getDigestForTag({
          packageName: trackable.imageName,
          tagName: trackable.tag,
        });
      } catch (e) {
        if (e instanceof Error) {
          let message = e.message;
          if (e.message === `5 NOT_FOUND: Requested entity was not found.`) {
            message = `The tag '${trackable.tag}' on the Docker image '${trackable.imageName}'
                does not exist. Check that both the image and tag are spelled correctly.`;
          }
          throw new AnnotatedError(message, {
            range: trackable?.trackRange,
            lineCounter,
          });
        } else {
          throw e;
        }
      }
    })();

    if (!digest) {
      throw new Error(`No tag ${trackable.tag} on ${trackable.imageName}`);
    }

    // It's OK if the current one is null because that's what we're overwriting, but we shouldn't
    // overwrite *to* something that doesn't exist.
    logger.info(
      `for image ${trackable.imageName}:${trackable.tag}, changing to tag ${digest}`,
    );
    trackable.refScalarTokenWriter.write(
      `${graphArtifactReferencePrefix}@${digest}`,
    );
  }
}
