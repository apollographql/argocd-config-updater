import * as core from '@actions/core';
import * as yaml from 'yaml';
import { DockerRegistryClient } from './artifactRegistry';
import {
  ScalarTokenWriter,
  getStringAndScalarTokenFromMap,
  getStringValue,
  parseYAML,
  getScalarTokenFromMap,
} from './yaml';

export async function updateHelmChartDependencies(
  contents: string,
  dockerRegistryClient: DockerRegistryClient,
): Promise<string> {
  return core.group('Processing helm subchart upgrades', async () => {
    const { document, stringify } = parseYAML(contents);

    // If the file is empty (or just whitespace or whatever), that's fine; we
    // can just leave it alone.
    if (!document) {
      return contents;
    }

    core.info('Looking helm chart dependencies');
    const topLevel = document.contents;

    if (!yaml.isMap(topLevel)) {
      throw Error('Expected the top level of the document to be a map');
    }

    const deps = topLevel.get('dependencies');
    if (!deps) {
      // No dependencies to update so skip
      return stringify();
    }
    if (!yaml.isSeq(deps)) {
      throw Error('Expected the dependencies to be a sequence');
    }

    for (const dep of deps.items) {
      if (!yaml.isMap(dep)) {
        throw Error('Expected the dependency to be a map');
      }
      const depName = getStringValue(dep, 'name');
      const repository = getStringValue(dep, 'repository');
      const version = getScalarTokenFromMap(dep, 'version');
      if (depName && repository && version) {
        if (repository.startsWith('oci://')) {
          // TODO: This could be cached
          const newVersion =
            await dockerRegistryClient.getLatestChartVersion(depName);
          if (newVersion) {
            core.info(
              `Updating helm chart ${depName} to use version ${newVersion}`,
            );
            new ScalarTokenWriter(version.scalarToken, document.schema).write(
              newVersion,
            );
          } else {
            core.info(
              `Helm chart ${depName} not found in artifact registry, skipping update`,
            );
          }
        } else {
          core.info(
            `Helm chart ${depName} is not from artifact registry, skipping update`,
          );
        }
      }
    }

    return stringify();
  });
}
