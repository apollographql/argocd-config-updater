import { RE2 } from 're2-wasm';
import * as yaml from 'yaml';
import {
  ScalarTokenWriter,
  getStringValue,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';
import { DockerRegistryClient } from './artifactRegistry';

interface Promote {
  scalarTokenWriter: ScalarTokenWriter;
  value: string;
}

export interface PromotedCommit {
  /**
   * The commit hash
   */
  commitSHA: string;
  /**
   * A link to view the commit on Github.
   */
  commitURL: string;
}

// Map from environment (eg `staging`) to list of promoted commits. Empty list
// means "the tag may be changing but the image hasn't actually changed in that
// range". Null means "we can't tell you what's promoted because it's not a
// normal main-to-main upgrade or something".
export type PromotedCommitsByEnvironment = Map<string, PromotedCommit[] | null>;

const DEFAULT_YAML_PATHS = [
  ['gitConfig', 'ref'],
  ['dockerImage', 'tag'],
];

export async function updatePromotedValues(
  contents: string,
  promotionTargetRegexp: string | null,
  _logger: PrefixingLogger,
  dockerRegistryClient: DockerRegistryClient | null = null,
): Promise<{
  newContents: string;
  promotedCommitsByEnvironment: PromotedCommitsByEnvironment | null; // Null if empty
}> {
  const logger = _logger.withExtendedPrefix('[promote] ');

  // We use re2-wasm instead of built-in RegExp so we don't have to worry about
  // REDOS attacks.
  const promotionTargetRE2 = promotionTargetRegexp
    ? new RE2(promotionTargetRegexp, 'u')
    : null;

  const { document, stringify } = parseYAML(contents);

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.
  if (!document) {
    return { newContents: contents, promotedCommitsByEnvironment: null };
  }

  // We decide what to do and then we do it, just in case there are any
  // overlaps between our reads and writes.
  logger.info('Looking for promote');
  const { promotes, promotedCommitsByEnvironment } = await findPromotes(
    document,
    promotionTargetRE2,
    dockerRegistryClient,
  );

  logger.info(`Promotes: ${JSON.stringify(promotes)}`);

  logger.info('Copying values');
  for (const { scalarTokenWriter, value } of promotes) {
    scalarTokenWriter.write(value);
  }

  return { newContents: stringify(), promotedCommitsByEnvironment };
}

async function findPromotes(
  document: yaml.Document.Parsed,
  promotionTargetRE2: RE2 | null,
  dockerRegistryClient: DockerRegistryClient | null,
): Promise<{
  promotes: Promote[];
  promotedCommitsByEnvironment: PromotedCommitsByEnvironment | null;
}> {
  const { blocks, globalBlock } = getTopLevelBlocks(document);
  const promotes: Promote[] = [];

  const promotedCommitsByEnvironment = new Map<
    string,
    PromotedCommit[] | null
  >();

  // This initialization is somewhat copy-pasted from updateDockerTags and updateGitRefs.
  let globalRepoURL: string | null = null;
  let globalDockerImageRepository: string | null = null;

  if (globalBlock?.has('gitConfig')) {
    const gitConfigBlock = globalBlock.get('gitConfig');
    if (!yaml.isMap(gitConfigBlock)) {
      throw Error('Document has `global.gitConfig` that is not a map');
    }
    globalRepoURL = getStringValue(gitConfigBlock, 'repoURL');
  }
  if (globalBlock?.has('dockerImage')) {
    const dockerImageBlock = globalBlock.get('dockerImage');
    if (!yaml.isMap(dockerImageBlock)) {
      throw Error('Document has `global.dockerImageBlock` that is not a map');
    }
    globalDockerImageRepository = getStringValue(
      dockerImageBlock,
      'repository',
    );
  }

  for (const [myName, me] of blocks) {
    if (promotionTargetRE2 && !promotionTargetRE2.test(myName)) {
      continue;
    }
    if (!me.has('promote')) {
      continue;
    }
    const promote = me.get('promote');
    if (!yaml.isMap(promote)) {
      throw Error(`The value at ${myName}.promote must be a map`);
    }
    const from = promote.get('from');
    if (typeof from !== 'string') {
      throw Error(`The value at ${myName}.promote.from must be a string`);
    }
    const fromBlock = blocks.get(from);
    if (!fromBlock) {
      throw Error(
        `The value at ${myName}.promote.from must reference a top-level key with map value`,
      );
    }

    const gitConfigBlock = me.get('gitConfig');
    if (gitConfigBlock && !yaml.isMap(gitConfigBlock)) {
      throw Error(`Document has \`${myName}.gitConfig\` that is not a map`);
    }
    const repoURL =
      (gitConfigBlock && getStringValue(gitConfigBlock, 'repoURL')) ??
      globalRepoURL;
    const dockerImageBlock = me.get('dockerImage');
    if (dockerImageBlock && !yaml.isMap(dockerImageBlock)) {
      throw Error(`Document has \`${myName}.dockerImage\` that is not a map`);
    }
    const dockerImageRepository =
      (dockerImageBlock && getStringValue(dockerImageBlock, 'repository')) ??
      globalDockerImageRepository;

    const yamlPaths: CollectionPath[] = [];
    if (promote.has('yamlPaths')) {
      const yamlPathsSeq = promote.get('yamlPaths');
      if (!yaml.isSeq(yamlPathsSeq)) {
        throw Error(
          `The value at ${myName}.promote.yamlPaths must be an array`,
        );
      }
      const explicitYamlPaths = yamlPathsSeq.toJSON();
      if (!Array.isArray(explicitYamlPaths)) {
        throw Error('YAMLSeq.toJSON surprisingly did not return an array');
      }
      if (!explicitYamlPaths.every(isCollectionPath)) {
        throw Error(
          `The value at ${myName}.promote.yamlPaths must be an array whose elements are arrays of strings or numbers`,
        );
      }
      yamlPaths.push(...explicitYamlPaths);
    } else {
      // By default, promote gitConfig.ref and dockerImage.tag, but only the
      // ones that are actually there.

      for (const potentialCollectionPath of DEFAULT_YAML_PATHS) {
        if (
          fromBlock.getIn(potentialCollectionPath) &&
          me.getIn(potentialCollectionPath)
        ) {
          yamlPaths.push(potentialCollectionPath);
        }
      }

      if (yamlPaths.length === 0) {
        throw Error(
          `${myName}.promote does not specify 'yamlPaths' and none of the default promoted paths (${DEFAULT_YAML_PATHS.map(
            (p) => p.join('.'),
          ).join(', ')}) exist in both the source and the target.`,
        );
      }
    }

    for (const collectionPath of yamlPaths) {
      const sourceValue = fromBlock.getIn(collectionPath);
      if (typeof sourceValue !== 'string') {
        throw Error(`Could not promote from ${[from, ...collectionPath]}`);
      }
      // true means keepScalar, ie get the scalar node to write.
      const targetNode = me.getIn(collectionPath, true);
      if (!yaml.isScalar(targetNode)) {
        throw Error(`Could not promote to ${[myName, ...collectionPath]}`);
      }

      const scalarToken = targetNode.srcToken;
      if (!yaml.CST.isScalar(scalarToken)) {
        // this probably can't happen, but let's make the types happy
        throw Error(
          `${[myName, ...collectionPath]} value must come from a scalar token`,
        );
      }

      if (
        collectionPath.join('.') === 'dockerImage.tag' &&
        repoURL &&
        dockerImageRepository &&
        typeof targetNode.value === 'string' &&
        targetNode.value !== sourceValue &&
        dockerRegistryClient
      ) {
        // We're changing a value and we may be able to look up the commits we're promoting.
        const commits = await dockerRegistryClient.getGitCommitsBetweenTags({
          prevTag: targetNode.value,
          nextTag: sourceValue,
          dockerImageRepository,
        });
        const trimmedRepoURL = repoURL.replace(/(?:\.git)?\/*$/, '');
        promotedCommitsByEnvironment.set(
          myName,
          commits?.map((commitSHA) => ({
            commitSHA,
            commitURL: `${trimmedRepoURL}/commit/${commitSHA}`,
          })) ?? null,
        );
      }

      promotes.push({
        scalarTokenWriter: new ScalarTokenWriter(scalarToken, document.schema),
        value: sourceValue,
      });
    }
  }
  return {
    promotes,
    promotedCommitsByEnvironment: promotedCommitsByEnvironment.size
      ? promotedCommitsByEnvironment
      : null,
  };
}

type CollectionPath = CollectionIndex[];
type CollectionIndex = string | number;

function isCollectionPath(value: unknown): value is CollectionPath {
  return Array.isArray(value) && value.every(isCollectionIndex);
}

function isCollectionIndex(value: unknown): value is CollectionIndex {
  return typeof value === 'string' || typeof value === 'number';
}
