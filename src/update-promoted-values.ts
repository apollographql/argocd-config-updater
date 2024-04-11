import { RE2 } from 're2-wasm';
import * as yaml from 'yaml';
import { ScalarTokenWriter, getTopLevelBlocks, parseYAML } from './yaml';
import { PrefixingLogger } from './log';
import { DockerRegistryClient } from './artifactRegistry';
import { GitHubClient } from './github';

interface Promote {
  scalarTokenWriter: ScalarTokenWriter;
  value: string;
  /**
   * Relevant commit hashes to this promotion, keyed by the service block name
   * Sorted from oldest to newest.
   */
  relevantCommits: [string, RelevantCommit[]];
}

export interface RelevantCommit {
  /**
   * The commit hash
   */
  commitSHA: string;
  /**
   * The commit message
   */
  message: string;
  author: string | null;
}

const DEFAULT_YAML_PATHS = [
  ['gitConfig', 'ref'],
  ['dockerImage', 'tag'],
];

export async function updatePromotedValues(
  contents: string,
  promotionTargetRegexp: string | null,
  _logger: PrefixingLogger,
  dockerRegistryClient: DockerRegistryClient | null = null,
  gitHubClient: GitHubClient | null = null,
): Promise<[string, Map<string, RelevantCommit[]>]> {
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
    return [contents, new Map()];
  }

  // We decide what to do and then we do it, just in case there are any
  // overlaps between our reads and writes.
  logger.info('Looking for promote');
  logger.info('test log');
  const promotes = await findPromotes(
    document,
    promotionTargetRE2,
    dockerRegistryClient,
    gitHubClient,
  );

  logger.info(`Promotes: ${JSON.stringify(promotes)}`);

  logger.info('Copying values');
  for (const { scalarTokenWriter, value } of promotes) {
    scalarTokenWriter.write(value);
  }

  const relevantCommits: Map<string, RelevantCommit[]> = new Map();
  for (const [serviceName, commits] of promotes.map((p) => p.relevantCommits)) {
    relevantCommits.set(serviceName, commits);
  }
  return [stringify(), relevantCommits];
}

async function findPromotes(
  document: yaml.Document.Parsed,
  promotionTargetRE2: RE2 | null,
  dockerRegistryClient: DockerRegistryClient | null,
  gitHubClient: GitHubClient | null = null,
): Promise<Promote[]> {
  const { blocks } = getTopLevelBlocks(document);
  const promotes: Promote[] = [];
  for (const [myName, me] of blocks) {
    if (promotionTargetRE2 && !promotionTargetRE2.test(myName)) {
      continue;
    }
    //
    // Expected format of a block:
    //
    // my-service-prod:
    //   track: <branch (main) | pr (pr-1234)>
    //   gitConfig:
    //     ref: <commit>
    //   dockerImage:
    //     tag: main---0013586-2024.04-<commit>
    //   promote:
    //     from: my-service-staging
    //
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
      console.log(`sourceValue: ${JSON.stringify(sourceValue)}`);
      console.log(`from: ${JSON.stringify(from)}`);
      console.log(`collectionPath: ${JSON.stringify(collectionPath)}`);
      console.log(`targetNode: ${JSON.stringify(targetNode)}`);
      console.log(`myName: ${JSON.stringify(myName)}`);
      const scalarToken = targetNode.srcToken;
      if (!yaml.CST.isScalar(scalarToken)) {
        // this probably can't happen, but let's make the types happy
        throw Error(
          `${[myName, ...collectionPath]} value must come from a scalar token`,
        );
      }

      // Need to get repository from global
      // We can assume it is in global and then fail gracefully if it isn't
      // global:
      //   datadogServiceName: engine-identity
      //   gitConfig:
      //     repoURL: https://github.com/mdg-private/monorepo.git
      //     path: k8s/engine/identity
      //   dockerImage:
      //     repository: identity
      //     setValue: [monorepo-base, image]
      //
      //     dockerRegistryClient should be passed in
      //

      let commits: string[] = [];
      let relevantCommits: RelevantCommit[] = [];
      if (gitHubClient && dockerRegistryClient) {
        let dockerImageRepository: string | undefined;
        let repoURL: string | undefined;
        const globalBlock = document.get('global');
        console.info(`globalBlock: ${JSON.stringify(globalBlock)}`);
        if (globalBlock && yaml.isMap(globalBlock)) {
          const gitConfig = globalBlock.get('gitConfig');
          if (gitConfig && yaml.isMap(gitConfig)) {
            const yamlRepoUrl = gitConfig.get('repoURL');
            if (yamlRepoUrl && typeof yamlRepoUrl === 'string') {
              repoURL = yamlRepoUrl;
            }
          }
          const dockerImageBlock = globalBlock.get('dockerImage');
          console.info(`dockerImageBlock: ${JSON.stringify(dockerImageBlock)}`);
          if (dockerImageBlock && yaml.isMap(dockerImageBlock)) {
            const repository = dockerImageBlock.get('repository');
            console.info(`repository: ${JSON.stringify(repository)}`);
            if (repository && typeof repository === 'string') {
              dockerImageRepository = repository;
            }
          }
        }
        console.info(
          `dockerImageRepository: ${JSON.stringify(dockerImageRepository)}`,
        );
        if (
          repoURL &&
          dockerImageRepository &&
          typeof targetNode.value === 'string'
        ) {
          commits = await dockerRegistryClient.getGitCommitsBetweenTags({
            prevTag: targetNode.value,
            nextTag: sourceValue,
            dockerImageRepository,
          });
          if (commits.length > 0) {
            const first = commits[0];
            const last = commits[commits.length - 1];
            const githubCommits = await gitHubClient.compareCommits({
              repoURL,
              baseCommitSHA: first,
              headCommitSHA: last,
            });
            console.info(`githubCommits: ${JSON.stringify(githubCommits)}`);
            relevantCommits =
              (githubCommits &&
                githubCommits.commits.filter((commit) => {
                  return commits.includes(commit.commitSHA);
                })) ||
              [];
            console.info(`relevantCommits: ${JSON.stringify(relevantCommits)}`);
            console.info(
              `number of commits: ${commits.length} ${githubCommits?.commits.length} ${relevantCommits.length}`,
            );
          }
        }
      }

      console.info(`commits: ${JSON.stringify(commits)}`);

      promotes.push({
        scalarTokenWriter: new ScalarTokenWriter(scalarToken, document.schema),
        value: sourceValue,
        relevantCommits: [myName, relevantCommits],
      });
    }
  }
  return promotes;
}

type CollectionPath = CollectionIndex[];
type CollectionIndex = string | number;

function isCollectionPath(value: unknown): value is CollectionPath {
  return Array.isArray(value) && value.every(isCollectionIndex);
}

function isCollectionIndex(value: unknown): value is CollectionIndex {
  return typeof value === 'string' || typeof value === 'number';
}
