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
  /**
   * The author of the commit, if available. Should be name, or email, or null.
   */
  author: string | null;
  /**
   * A link to view the commit on Github.
   */
  commitUrl: string;
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

  logger.info(`Relevant commits: ${JSON.stringify(relevantCommits)}`);

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
  //
  // Expected format of global:
  //
  // global:
  //   datadogServiceName: my-service
  //   gitConfig:
  //     repoURL: https://github.com/owner/repo.git
  //     path: k8s/services/service
  //   dockerImage:
  //     repository: service
  //
  const repoURL: string | undefined = document.getIn([
    'global',
    'gitConfig',
    'repoURL',
  ]) as string | undefined;

  const dockerImageRepository: string | undefined = document.getIn([
    'global',
    'dockerImage',
    'repository',
  ]) as string | undefined;

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

      let relevantCommits: RelevantCommit[] = [];
      if (
        typeof targetNode.value === 'string' &&
        dockerImageRepository &&
        repoURL &&
        gitHubClient &&
        dockerRegistryClient
      ) {
        relevantCommits = await getRelevantCommits(
          targetNode.value,
          sourceValue,
          dockerImageRepository,
          repoURL,
          gitHubClient,
          dockerRegistryClient,
        );
      }

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

async function getRelevantCommits(
  prevTag: string,
  nextTag: string,
  dockerImageRepository: string,
  repoURL: string,
  gitHubClient: GitHubClient,
  dockerRegistryClient: DockerRegistryClient,
): Promise<RelevantCommit[]> {
  const commits = await dockerRegistryClient.getGitCommitsBetweenTags({
    prevTag,
    nextTag,
    dockerImageRepository,
  });

  console.log(`getGitComitsBetweenTags: ${JSON.stringify(commits)}`);

  if (commits.length <= 0) return [];

  const first = commits[0];
  const last = commits[commits.length - 1];

  console.log(`first: ${JSON.stringify(first)}`);
  console.log(`last: ${JSON.stringify(last)}`);

  const githubCommits = await gitHubClient.compareCommits({
    repoURL,
    baseCommitSHA: first,
    headCommitSHA: last,
  });

  console.log(`githubCommits: ${JSON.stringify(githubCommits)}`);

  if (githubCommits === null) return [];

  const relevantCommits = githubCommits.commits.filter((commit) => {
    return commits.includes(commit.commitSHA);
  });

  return relevantCommits;
}
