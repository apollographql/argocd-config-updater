import * as yaml from 'yaml';

export type CSTScalarToken = yaml.CST.FlowScalar | yaml.CST.BlockScalar;

export class ScalarTokenWriter {
  constructor(
    private scalarToken: CSTScalarToken,
    private schema: yaml.Schema,
  ) {}

  write(value: string): void {
    // We're writing to the CST so that we can preserve formatting. But CSTs don't
    // know about the difference between numbers and strings, so we can't use the
    // yaml module's built in ability to say "hey, I'm writing a string, please
    // quote it if necessary". We borrow the logic from
    // https://github.com/eemeli/yaml/blob/b7696fc0018/src/stringify/stringifyString.ts#L326-L329
    // to check if it needs quotes. We then force it to single-quote unless it's
    // already quoted (in which case we leave the quote style alone). (Passing
    // `type: undefined` means to leave the style alone.)
    const test = (tag: yaml.CollectionTag | yaml.ScalarTag): boolean =>
      !!(
        tag.default &&
        tag.tag !== 'tag:yaml.org,2002:str' &&
        tag.test?.test(value)
      );
    const needsQuote =
      this.schema.tags.some(test) || !!this.schema.compat?.some(test);
    const alreadyQuoted =
      this.scalarToken.type === 'single-quoted-scalar' ||
      this.scalarToken.type === 'double-quoted-scalar' ||
      this.scalarToken.type === 'block-scalar';
    yaml.CST.setScalarValue(
      this.scalarToken,
      value,
      needsQuote && !alreadyQuoted
        ? {
            type: 'QUOTE_SINGLE',
          }
        : undefined,
    );
  }
}

export function getTopLevelBlocks(doc: yaml.Document.Parsed): {
  globalBlock: yaml.YAMLMap.Parsed | null;
  blocks: Map<string, yaml.YAMLMap.Parsed>;
} {
  let globalBlock: yaml.YAMLMap.Parsed | null = null;
  const blocks = new Map<string, yaml.YAMLMap.Parsed>();

  const topLevel = doc.contents;

  if (!yaml.isMap(topLevel)) {
    throw Error('Expected the top level of the document to be a map');
  }

  if (topLevel.has('global')) {
    const gb = topLevel.get('global');
    if (!yaml.isMap(gb)) {
      throw Error(
        'Document has a top-level `global` key whose value is not a map',
      );
    }
    globalBlock = gb;
  }

  for (const { key, value } of topLevel.items) {
    if (!yaml.isScalar(key)) {
      continue;
    }
    if (typeof key.value !== 'string') {
      continue;
    }
    // The `global` block was already handled specially above.
    if (key.value === 'global') {
      if (!yaml.isMap(value)) {
        throw Error(
          'Document has a top-level `global` key whose value is not a map',
        );
      }
      globalBlock = value;
    } else if (yaml.isMap(value)) {
      blocks.set(key.value, value);
    }
  }

  return { globalBlock, blocks };
}

/** Returns null if the value isn't there at all; throws if it's there but isn't
 * a string. */
export function getStringValue(node: yaml.YAMLMap, key: string): string | null {
  return getStringAndScalarTokenFromMap(node, key)?.value ?? null;
}

/**  Returns null if the value isn't there at all; throws if it's there but isn't
 * a string. */
export function getStringAndScalarTokenFromMap(
  node: yaml.YAMLMap,
  key: string,
): {
  scalarToken: CSTScalarToken;
  value: string;
  range?: yaml.Range | null | undefined;
} | null {
  if (!node.has(key)) {
    return null;
  }
  const scalar = node.get(key, true);
  if (!yaml.isScalar(scalar)) {
    throw Error(`${key} value must be a scalar`);
  }
  const scalarToken = scalar?.srcToken;
  if (!yaml.CST.isScalar(scalarToken)) {
    // this probably can't happen, but let's make the types happy
    throw Error(`${key} value must come from a scalar token`);
  }
  if (typeof scalar.value !== 'string') {
    throw Error(`${key} value must be a string`);
  }
  return { scalarToken, value: scalar.value, range: scalar.range };
}

export function parseYAML(contents: string): {
  document: yaml.Document.Parsed | null;
  stringify: () => string;
  lineCounter: yaml.LineCounter;
} {
  // The yaml module lets us parse YAML into three layers of abstraction:
  // - It can create raw JS arrays/objects/etc, which is simple to dealing
  //   with but loses track of everything relating to formatting.
  // - It can create a low-level "Concrete Syntax Tree" (CST) which lets us
  //   re-create the original document with byte-by-byte accuracy, but is
  //   awkward to read from (eg, you have to navigate maps item by item rather
  //   than using keys).
  // - It can create a high-level "Abstract Syntax Tree" (AST) which is easier
  //   to read from but loses some formatting details.
  //
  // We'd prefer to read ASTs and write CSTs, and in fact the module lets us
  // do exactly that. We first create CSTs with the "Parser". We then convert
  // it into ASTs with the Composer, passing in the `keepSourceTokens` option
  // which means that every node in the AST will have a `srcToken` reference
  // to the underlying CST node that created it. When we want to make changes,
  // we do that by writing to the CST node found in a `srcToken` reference.
  // Finally, when we're done, we stringify the CSTs (which have been mutated)
  // rather than the ASTs (via the `stringify` function we return).
  const lineCounter = new yaml.LineCounter();
  const topLevelTokens = [
    ...new yaml.Parser(lineCounter.addNewLine).parse(contents),
  ];
  const documents = [
    ...new yaml.Composer({
      keepSourceTokens: true,
    }).compose(topLevelTokens),
  ];

  // These files are all Helm values.yaml files, and Helm doesn't support a
  // multiple-document stream (with ---) for its value files. Or well, it
  // ignores any documents after the first, so there's no point in allowing
  // folks to put them in our codebase.
  if (documents.length > 1) {
    throw new Error('Multiple documents in YAML file');
  }

  // If the file is empty (or just whitespace or whatever), that's fine; we
  // can just leave it alone.
  if (documents.length < 1) {
    return {
      document: null,
      lineCounter,
      stringify() {
        return '';
      },
    };
  }

  const document = documents[0];

  if (document.errors.length) {
    throw new Error(`Error parsing YAML file: ${document.errors}`);
  }

  return {
    document,
    lineCounter,
    stringify() {
      return topLevelTokens
        .map((topLevelToken) => yaml.CST.stringify(topLevelToken))
        .join('');
    },
  };
}
