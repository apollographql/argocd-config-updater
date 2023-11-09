import * as core from '@actions/core';
import { RE2 } from 're2-wasm';
import * as yaml from 'yaml';
import { ScalarTokenWriter, getTopLevelBlocks } from './yaml';

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
  promotionTargetRegexp: string | null,
): Promise<string> {
  return core.group('Processing promote', async () => {
    // We use re2-wasm instead of built-in RegExp so we don't have to worry about
    // REDOS attacks.
    const promotionTargetRE2 = promotionTargetRegexp
      ? new RE2(promotionTargetRegexp, 'u')
      : null;

    // See updateGitRefs for an explanation about our approach to parsing YAML.
    core.info('Parsing');
    const topLevelTokens = [...new yaml.Parser().parse(contents)];
    const documents = [
      ...new yaml.Composer({ keepSourceTokens: true }).compose(topLevelTokens),
    ];

    // We decide what to do and then we do it, just in case there are any
    // overlaps between our reads and writes.
    core.info('Looking for promote');
    const promotes = documents.flatMap((document) =>
      findPromotes(document, promotionTargetRE2),
    );

    core.info('Copying values');
    for (const { scalarTokenWriter, value } of promotes) {
      scalarTokenWriter.write(value);
    }
    core.info('Stringifying');
    return topLevelTokens
      .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
      .join('');
  });
}

function findPromotes(
  document: yaml.Document.Parsed,
  promotionTargetRE2: RE2 | null,
): Promote[] {
  const { blocks } = getTopLevelBlocks(document);
  const promotes: Promote[] = [];
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
      promotes.push({
        scalarTokenWriter: new ScalarTokenWriter(scalarToken, document.schema),
        value: sourceValue,
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
