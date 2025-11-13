import { getWebURL, GitHubClient } from './github.js';
import { PrefixingLogger } from './log.js';
import { parseYAML } from './yaml.js';
import { findTrackables } from './update-git-refs.js';
import { CleanupChange } from './format-cleanup-changes.js';

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

          const environment = trackable.environment;

          changes.push({
            prNumber,
            prTitle: pr.title,
            prURL: `${getWebURL(trackable.repoURL)}/pull/${prNumber}`,
            filename,
            environment,
            closedAt: pr.closedAt,
          });
        } else {
          logger.info(`PR #${prNumber} is ${pr.state}`);
        }
      } catch {
        logger.info(`PR #${prNumber} lookup failed, leaving unchanged`);
      }
    }
  }

  return {
    contents: stringify(),
    changes,
  };
}
