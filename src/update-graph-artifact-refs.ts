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
    
    if (!trackSupergraph) {
      // trackSupergraph is not provided at all, skip this entry
      continue;
    }
    
    // After this point, we're guaranteed to have a trackSupergraph. And everything will throw
    // instead of failing silently because the customer must have intended to track a supergraph.
    if (!trackSupergraph.value) {
      // trackSupergraph is provided but empty, throw error since customer intended to track
      throw Error(
        `trackSupergraph value is empty, must be in the format \`image:tag\``,
      );
    }
    
    const [, imageName, tag] =
      trackSupergraph.value.match(/^([^:]+):([^:]+)$/) || [];
    
    // Skip if the trackSupergraph format is invalid (doesn't match image:tag pattern)
    if (!imageName || !tag) {
      throw Error(
        `trackSupergraph \`${trackSupergraph.value}\` is invalid, must be in the format \`image:tag\``,
      );
    }
    
    // Safely navigate the YAML structure
    const values = value.get('values');
    if (!values || !yaml.isMap(values)) {
      throw Error(
        `\`values\` must be provided in the document if using trackSupergraph`,
      );
    }
    
    const router = values.get('router');
    if (!router || !yaml.isMap(router)) {
      throw Error(
        `\`router\` must be provided in the document if using trackSupergraph`,
      );
    }
    
    const extraEnvVars = router.get('extraEnvVars');
    if (!extraEnvVars || !yaml.isSeq(extraEnvVars)) {
      throw Error(
        `\`extraEnvVars\` must be provided in the document if using trackSupergraph`,
      );
    }
    
    const graphArtifactMap = getMapFromSeqWithName(
      extraEnvVars as yaml.YAMLSeq<yaml.YAMLMap>,
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
          throw new AnnotatedError(e.message, {
            range: trackable?.trackRange,
            lineCounter,
          });
        } else {
          throw e;
        }
      }
    })();

    // if (!digest) {
    //   throw new AnnotatedError(
    //     `The digest for tag '${trackable.tag}' on the image '${trackable.imageName}' does not exist. Check that both the image and tag are spelled correctly.`,
    //     {
    //       range: trackable?.trackRange,
    //       lineCounter,
    //     },
    //   );
    // }

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
