import * as yaml from 'yaml';
import {
  ScalarTokenWriter,
  getStringValue,
  getTopLevelBlocks,
  parseYAML,
} from './yaml';
import { PrefixingLogger } from './log';
import { DockerRegistryClient } from './artifactRegistry';
import { EnvironmentPromotions, PromotionInfo } from './promotionInfo';
import { GitHubClient, getGitConfigRefPromotionInfo } from './github';
import { LinkTemplateMap, renderLinkTemplate } from './templates';
import { createHash } from 'node:crypto';
import { AnnotatedError } from './index';

interface Promote {
  scalarTokenWriter: ScalarTokenWriter;
  value: string;
}

const DEFAULT_YAML_PATHS = [
  ['gitConfig', 'ref'],
  ['dockerImage', 'tag'],
];

export async function updatePromotedValues(
  contents: string,
  promotionTarget: string | null,
  frozenEnvironments: Set<string>,
  _logger: PrefixingLogger,
  dockerRegistryClient: DockerRegistryClient | null = null,
  gitHubClient: GitHubClient | null = null,
  linkTemplateMap: LinkTemplateMap | null = null,
): Promise<{
  newContents: string;
  environmentPromotions: EnvironmentPromotions | null;
}> {
  const logger = _logger.withExtendedPrefix('[promote] ');

  const { document, stringify, lineCounter } = parseYAML(contents);

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.
  if (!document) {
    return { newContents: contents, environmentPromotions: null };
  }

  // We decide what to do and then we do it, just in case there are any
  // overlaps between our reads and writes.
  logger.info('Looking for promote');
  const { promotes, environmentPromotions } = await findPromotes(
    document,
    lineCounter,
    promotionTarget,
    dockerRegistryClient,
    gitHubClient,
    linkTemplateMap,
    frozenEnvironments,
  );

  logger.info('Copying values');
  for (const { scalarTokenWriter, value } of promotes) {
    scalarTokenWriter.write(value);
  }

  return { newContents: stringify(), environmentPromotions };
}

async function findPromotes(
  document: yaml.Document.Parsed,
  lineCounter: yaml.LineCounter,
  promotionTarget: string | null,
  dockerRegistryClient: DockerRegistryClient | null,
  gitHubClient: GitHubClient | null,
  linkTemplateMap: LinkTemplateMap | null,
  frozenEnvironments: Set<string>,
): Promise<{
  promotes: Promote[];
  environmentPromotions: EnvironmentPromotions | null;
}> {
  const { blocks, globalBlock } = getTopLevelBlocks(document);
  const promotes: Promote[] = [];

  let environmentPromotions: EnvironmentPromotions | null = null;

  // This initialization is somewhat copy-pasted from updateDockerTags and updateGitRefs.
  let globalRepoURL: string | null = null;
  let globalPath: string | null = null;
  let globalDockerImageRepository: string | null = null;
  let globalDockerImageTag: string | null = null;

  if (globalBlock?.has('gitConfig')) {
    const gitConfigBlock = globalBlock.get('gitConfig');
    if (!yaml.isMap(gitConfigBlock)) {
      throw new AnnotatedError(
        'Document has `global.gitConfig` that is not a map',
        {
          range: gitConfigBlock?.range,
          lineCounter,
        },
      );
    }
    globalRepoURL = getStringValue(gitConfigBlock, 'repoURL');
    globalPath = getStringValue(gitConfigBlock, 'path');
  }
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
    globalDockerImageRepository = getStringValue(
      dockerImageBlock,
      'repository',
    );
    globalDockerImageTag = getStringValue(dockerImageBlock, 'tag');
  }

  for (const [myName, me] of blocks) {
    if (frozenEnvironments.has(myName)) {
      continue;
    }
    if (promotionTarget && promotionTarget !== myName) {
      continue;
    }
    if (!me.has('promote')) {
      continue;
    }
    const promote = me.get('promote');
    if (!yaml.isMap(promote)) {
      throw new AnnotatedError(`The value at ${myName}.promote must be a map`, {
        range: promote?.range,
        lineCounter,
      });
    }
    const from = promote.get('from');
    if (typeof from !== 'string') {
      throw new AnnotatedError(
        `The value at ${myName}.promote.from must be a string`,
        {
          range: from?.range,
          lineCounter,
        },
      );
    }
    const fromBlock = blocks.get(from);
    if (!fromBlock) {
      throw new AnnotatedError(
        `The value at ${myName}.promote.from must reference a top-level key with map value`,
        {
          range: promote?.range,
          lineCounter,
        },
      );
    }

    const gitConfigBlock = me.get('gitConfig');
    if (gitConfigBlock && !yaml.isMap(gitConfigBlock)) {
      throw new AnnotatedError(
        `Document has \`${myName}.gitConfig\` that is not a map`,
        {
          range: gitConfigBlock?.range,
          lineCounter,
        },
      );
    }
    const repoURL =
      (gitConfigBlock && getStringValue(gitConfigBlock, 'repoURL')) ??
      globalRepoURL;
    const path =
      (gitConfigBlock && getStringValue(gitConfigBlock, 'path')) ?? globalPath;
    const trimmedRepoURL = repoURL?.replace(/(?:\.git)?\/*$/, '');

    const dockerImageBlock = me.get('dockerImage');
    if (dockerImageBlock && !yaml.isMap(dockerImageBlock)) {
      throw new AnnotatedError(
        `Document has \`${myName}.dockerImage\` that is not a map`,
        {
          range: dockerImageBlock?.range,
          lineCounter,
        },
      );
    }
    const dockerImageRepository =
      (dockerImageBlock && getStringValue(dockerImageBlock, 'repository')) ??
      globalDockerImageRepository;

    const yamlPaths: CollectionPath[] = [];
    if (promote.has('yamlPaths')) {
      const yamlPathsSeq = promote.get('yamlPaths');
      if (!yaml.isSeq(yamlPathsSeq)) {
        throw new AnnotatedError(
          `The value at ${myName}.promote.yamlPaths must be an array`,
          {
            range: yamlPathsSeq?.range,
            lineCounter,
          },
        );
      }
      const explicitYamlPaths = yamlPathsSeq.toJSON();
      if (!Array.isArray(explicitYamlPaths)) {
        throw new AnnotatedError(
          'YAMLSeq.toJSON surprisingly did not return an array',
          {
            range: yamlPathsSeq?.range,
            lineCounter,
          },
        );
      }
      if (!explicitYamlPaths.every(isCollectionPath)) {
        throw new AnnotatedError(
          `The value at ${myName}.promote.yamlPaths must be an array whose elements are arrays of strings or numbers`,
          {
            range: yamlPathsSeq?.range,
            lineCounter,
          },
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

    let gitConfigPromotionInfo: PromotionInfo = { type: 'no-change' };
    let dockerImagePromotionInfo: PromotionInfo = { type: 'no-change' };

    // Will be updated if promoted.
    let dockerImageTag =
      (dockerImageBlock && getStringValue(dockerImageBlock, 'tag')) ??
      globalDockerImageTag;

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

      if (collectionPath.join('.') === 'dockerImage.tag') {
        dockerImageTag = sourceValue;
      }

      if (
        typeof targetNode.value === 'string' &&
        targetNode.value !== sourceValue
      ) {
        if (
          collectionPath.join('.') === 'dockerImage.tag' &&
          dockerImageRepository &&
          dockerRegistryClient
        ) {
          // We're changing a value and we may be able to look up the commits
          // we're promoting in the Docker image.
          dockerImagePromotionInfo =
            await dockerRegistryClient.getGitCommitsBetweenTags({
              prevTag: targetNode.value,
              nextTag: sourceValue,
              dockerImageRepository,
            });
        }

        if (
          collectionPath.join('.') === 'gitConfig.ref' &&
          repoURL &&
          path &&
          gitHubClient
        ) {
          gitConfigPromotionInfo = await getGitConfigRefPromotionInfo({
            oldRef: targetNode.value,
            newRef: sourceValue,
            repoURL,
            path,
            gitHubClient,
          });
        }
      }

      promotes.push({
        scalarTokenWriter: new ScalarTokenWriter(scalarToken, document.schema),
        value: sourceValue,
      });
    }

    const linksSeq = promote.get('links');
    const linkNames: string[] = [];
    if (linksSeq) {
      if (!yaml.isSeq(linksSeq)) {
        throw Error(
          `The value at ${myName}.promote.links must be an array (if provided)`,
        );
      }
      const links = linksSeq.toJSON();
      if (!Array.isArray(links)) {
        throw Error('YAMLSeq.toJSON surprisingly did not return an array');
      }
      if (!links.every(isString)) {
        throw Error(
          `The value at ${myName}.promote.links (if provided) must be an array whose elements are strings`,
        );
      }
      linkNames.push(...links);
    }

    if (
      trimmedRepoURL &&
      (dockerImagePromotionInfo.type !== 'no-change' ||
        gitConfigPromotionInfo.type !== 'no-change')
    ) {
      const templateVariables = new Map<string, string>();
      if (linkTemplateMap && linkNames.length) {
        if (dockerImageRepository && dockerImageTag) {
          // This particular encoding is designed to be safe for use in a
          // Kubernetes label, which only allows a subset of characters and has
          // a max length of 63; it's also something that can be calculated in a
          // Helm chart via built-in functions printf, sha256sum, and trunc.
          templateVariables.set(
            'docker-image-sha256-63',
            createHash('sha256')
              .update(`${dockerImageRepository}:${dockerImageTag}`)
              .digest('hex')
              .slice(0, 63),
          );
        } else {
          templateVariables.set('docker-image-sha256-63', 'unknown');
        }
      }
      environmentPromotions = {
        environment: myName,
        trimmedRepoURL,
        gitConfigPromotionInfo,
        dockerImage: dockerImageRepository
          ? {
              repository: dockerImageRepository,
              promotionInfo: dockerImagePromotionInfo,
            }
          : null,
        links: linkNames.map((linkName) => {
          if (!linkTemplateMap) {
            throw Error(
              `${myName}.promote.links requires the link-template-file input to be set`,
            );
          }
          return renderLinkTemplate(
            linkTemplateMap,
            linkName,
            templateVariables,
          );
        }),
      };
    }
  }
  return {
    promotes,
    environmentPromotions,
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

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
