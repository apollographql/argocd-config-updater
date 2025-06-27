export interface CleanupChange {
  prNumber: number;
  prTitle: string;
  prURL: string;
  appName: string;
  environment: string;
  closedAt: string | null;
}

export type CleanupChangesByFile = Map<string, CleanupChange[]>;

export function formatCleanupChanges(changes: CleanupChange[]): string {
  if (!changes.length) return '';

  // Group changes by app
  const changesByApp = new Map<string, CleanupChange[]>();
  for (const change of changes) {
    const key = change.appName;
    if (!changesByApp.has(key)) {
      changesByApp.set(key, []);
    }
    const appChanges = changesByApp.get(key);
    if (appChanges) {
      appChanges.push(change);
    }
  }

  const header = `Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}:\n\n`;
  const sections: string[] = [];

  // Sort apps alphabetically
  const sortedApps = [...changesByApp.keys()].sort();

  for (const appName of sortedApps) {
    const appChanges = changesByApp.get(appName);
    if (!appChanges) continue;

    // Sort changes by PR number within each app
    appChanges.sort((a, b) => a.prNumber - b.prNumber);

    // Get unique environments for this app
    const environments = [
      ...new Set(appChanges.map((c) => c.environment)),
    ].sort();
    const envString = environments.join(', ');

    sections.push(`**${appName}** (${envString})`);

    for (const change of appChanges) {
      const closedDateStr = formatClosedDate(change.closedAt);
      sections.push(
        `- PR [#${change.prNumber}](${change.prURL}): ${change.prTitle}${closedDateStr}`,
      );
    }

    sections.push(''); // Add blank line between apps
  }

  // Remove last blank line
  if (sections.length > 0 && sections[sections.length - 1] === '') {
    sections.pop();
  }

  return header + sections.join('\n');
}

function formatClosedDate(closedAt: string | null): string {
  if (!closedAt) return '';

  try {
    const date = new Date(closedAt);
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };
    return ` (closed ${date.toLocaleDateString('en-US', options)})`;
  } catch {
    return '';
  }
}
