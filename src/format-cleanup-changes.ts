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

  const sorted = [...changes].sort((a, b) => {
    const appCompare = a.appName.localeCompare(b.appName);
    if (appCompare !== 0) return appCompare;
    const envCompare = a.environment.localeCompare(b.environment);
    if (envCompare !== 0) return envCompare;
    return a.prNumber - b.prNumber;
  });

  const sections: string[] = [];
  let currentApp = '';
  let currentEnv = '';

  for (const change of sorted) {
    if (change.appName !== currentApp || change.environment !== currentEnv) {
      if (sections.length > 0) sections.push(''); // blank line between sections
      sections.push(`**${change.appName}** (${change.environment})`);
      currentApp = change.appName;
      currentEnv = change.environment;
    }
    sections.push(formatPRLine(change));
  }

  const header = `Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}:\n\n`;
  return header + sections.join('\n');
}

function formatPRLine(change: CleanupChange): string {
  const closedDateStr = formatClosedDate(change.closedAt);
  return `- PR [#${change.prNumber}](${change.prURL}): ${change.prTitle}${closedDateStr}`;
}

function formatClosedDate(closedAt: string | null): string {
  if (!closedAt) return '';

  try {
    const date = new Date(closedAt);
    const formattedDate = date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    return ` (closed ${formattedDate})`;
  } catch {
    return '';
  }
}
