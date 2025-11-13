import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { updatePromotedValues } from '../src/update-promoted-values';
import { PrefixingLogger } from '../src/log';

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, '__fixtures__', 'update-promoted-values', filename),
    'utf-8',
  );
}

const logger = PrefixingLogger.silent();

describe('action', () => {
  it('updates git refs', async () => {
    const contents = await fixture('sample.yaml');
    const { newContents } = await updatePromotedValues(
      contents,
      'prod',
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();

    // It should be idempotent in this case.
    const { newContents: actual } = await updatePromotedValues(
      newContents,
      'prod',
      new Set<string>(),
      logger,
    );
    expect(actual).toBe(newContents);

    // Update the first one again but freeze one environment.
    const { newContents: frozenContents } = await updatePromotedValues(
      contents,
      null,
      new Set<string>(['some-service-prod']),
      logger,
    );
    expect(frozenContents).toMatchSnapshot();
  });

  it('respects defaults and explicit specifications for yamlPaths', async () => {
    const { newContents } = await updatePromotedValues(
      await fixture('yaml-paths-defaults.yaml'),
      null,
      new Set<string>(),
      logger,
    );

    expect(newContents).toMatchSnapshot();
  });

  it('throws if no default yamlPaths entry works', async () => {
    const contents = await fixture('default-fails.yaml');
    await expect(
      updatePromotedValues(contents, null, new Set<string>(), logger),
    ).rejects.toThrow('none of the default promoted paths');
  });
});
