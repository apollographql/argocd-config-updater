import { getWebURL, GitHubClient } from './github';
import { PrefixingLogger } from './log';
import { parseYAML } from './yaml';
import { findTrackables } from './update-git-refs';
import { CleanupChange } from './format-cleanup-changes';

/**
 * Extract app name from file path.
 * Examples:
 *   - "teams/governance/operationcollections/application-values.yaml" -> "operationcollections"
 *   - "/path/to/teams/apollo-router/application-values.yaml" -> "apollo-router"
 */
function extractAppNameFromFilename(filename: string): string {
  // Split the path and find the directory containing application-values.yaml
  const parts = filename.split('/');
  const yamlIndex = parts.findIndex(
    (part) => part === 'application-values.yaml',
  );

  if (yamlIndex > 0) {
    // The app name is the directory just before application-values.yaml
    return parts[yamlIndex - 1];
  }

  // Fallback: try to extract from any filename pattern
  const basename = parts[parts.length - 1];
  if (basename.endsWith('.yaml') || basename.endsWith('.yml')) {
    return basename.replace(/\.(yaml|yml)$/, '');
  }

  return 'unknown-app';
}

/**
 * Updates closed PR tracking references to point to 'main' branch.
 *
 * This function scans YAML configuration files for Git references that track
 * pull requests (in the format "pr-123") and checks if those PRs are closed.
 * If a PR is closed, the tracking reference is updated to "main".
 *
 * @param options - Configuration for the cleanup operation
 * @param options.contents - The YAML file contents to process
 * @param options.frozenEnvironments - Set of environment names that should not be modified
 * @param options.gitHubClient - GitHub client for API calls to check PR status
 * @param options.logger - Logger for operation feedback
 * @returns Promise resolving to updated contents and list of changes made
 */
export async function cleanupClosedPrTracking(options: {
  contents: string;
  frozenEnvironments: Set<string>;
  gitHubClient: GitHubClient;
  logger: PrefixingLogger;
  filename: string;
}): Promise<{ contents: string; changes: CleanupChange[] }> {
  const { contents, frozenEnvironments, gitHubClient, logger, filename } =
    options;

  const { document, stringify } = parseYAML(contents);
  if (!document) {
    return { contents, changes: [] };
  }

  const changes: CleanupChange[] = [];
  const trackables = findTrackables(document, frozenEnvironments);
  for (const trackable of trackables) {
    const match = trackable.trackMutableRef.match(/^pr-(\d+)$/);
    if (match && trackable.trackScalarTokenWriter) {
      const prNumber = parseInt(match[1], 10);
      try {
        const pr = await gitHubClient.getPullRequest({
          repoURL: trackable.repoURL,
          prNumber,
        });

        if (pr.state === 'closed') {
          trackable.trackScalarTokenWriter.write('main');
          logger.info(`PR #${prNumber} is closed, updated to main`);

          // Extract app name from filename and environment from blockKey
          const appName = extractAppNameFromFilename(filename);
          const environment = trackable.environment; // environment from YAML top-level key

          changes.push({
            prNumber,
            prTitle: pr.title,
            prURL: `${getWebURL(trackable.repoURL)}/pull/${prNumber}`,
            appName,
            environment,
            closedAt: pr.closedAt,
          });
        } else {
          logger.info(`PR #${prNumber} is ${pr.state}`);
        }
      } catch (error) {
        logger.info(`PR #${prNumber} lookup failed, leaving unchanged`);
      }
    }
  }

  return {
    contents: stringify(),
    changes,
  };
}
