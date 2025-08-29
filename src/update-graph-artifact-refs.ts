import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';
import { AnnotatedError } from './index';

export interface TrackableGraphArtifact {
  imageName: string;
  tag: string;
  trackRange: yaml.Range | null | undefined;
  supergraphDigestToken: ScalarTokenWriter;
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
  const { blocks, globalBlock } = getTopLevelBlocks(doc);

  // First, check if global block has supergraph configuration
  if (!globalBlock || !yaml.isMap(globalBlock)) {
    // No global block or global is not a map, skip processing
    return trackables;
  }

  const supergraphConfig = globalBlock.get('supergraph');
  if (!supergraphConfig) {
    // No supergraph configuration in global, skip processing
    return trackables;
  }

  if (!yaml.isMap(supergraphConfig)) {
    throw Error(
      `global.supergraph must be a map with artifactURL and imageName`,
    );
  }

  const artifactURL = getStringAndScalarTokenFromMap(
    supergraphConfig,
    'artifactURL',
  );
  const imageName = getStringAndScalarTokenFromMap(
    supergraphConfig,
    'imageName',
  );

  if (!artifactURL?.value || !imageName?.value) {
    throw Error(
      `global.supergraph must provide both artifactURL and imageName`,
    );
  }

  // Now process each block to find supergraph entries with digest that need updating
  for (const [key, value] of blocks) {
    if (key === 'global' || frozenEnvironments.has(key)) {
      continue;
    }

    if (!value?.has('supergraph')) {
      // Skip blocks without supergraph
      continue;
    }

    const supergraphBlock = value.get('supergraph');
    if (!yaml.isMap(supergraphBlock)) {
      throw Error(`\`${key}.supergraph\` must be a map`);
    }

    const digestToken = getStringAndScalarTokenFromMap(
      supergraphBlock,
      'digest',
    );

    if (!digestToken) {
      throw Error(`\`${key}.supergraph.digest\` must be provided`);
    }

    // Extract tag from trackMutableTag if available
    const trackMutableTag = getStringAndScalarTokenFromMap(
      supergraphBlock,
      'trackMutableTag',
    );

    if (!trackMutableTag?.value) {
      throw Error(`\`${key}.supergraph.trackMutableTag\` must be provided`);
    }

    trackables.push({
      imageName: imageName.value,
      tag: trackMutableTag.value,
      trackRange: trackMutableTag?.range,
      supergraphDigestToken: new ScalarTokenWriter(
        digestToken.scalarToken,
        doc.schema,
      ),
    });
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
    // const [, graphArtifactReferencePrefix] =
    //   trackable.graphArtifactRef.match(/^(.*?)@/) || [];
    const digest = await (async () => {
      try {
        return await dockerRegistryClient.getDigestForTag({
          packageName: trackable.imageName,
          tagName: trackable.tag,
        });
      } catch (e) {
        if (e instanceof Error) {
          throw new AnnotatedError(e.message, {
            range: trackable?.trackRange,
            lineCounter,
          });
        } else {
          throw e;
        }
      }
    })();

    logger.info(
      `for image ${trackable.imageName}:${trackable.tag}, changing to digest ${digest}`,
    );
    trackable.supergraphDigestToken.write(digest);
  }
}
