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

  const changesByApp = groupChangesByApp(changes);
  const sortedAppNames = [...changesByApp.keys()].sort();

  const header = `Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}:\n\n`;
  const sections = buildSections(sortedAppNames, changesByApp);

  return header + sections.join('\n');
}

function groupChangesByApp(
  changes: CleanupChange[],
): Map<string, CleanupChange[]> {
  const changesByApp = new Map<string, CleanupChange[]>();

  for (const change of changes) {
    const existing = changesByApp.get(change.appName);
    if (existing) {
      existing.push(change);
    } else {
      changesByApp.set(change.appName, [change]);
    }
  }

  return changesByApp;
}

function buildSections(
  appNames: string[],
  changesByApp: Map<string, CleanupChange[]>,
): string[] {
  const sections = appNames.flatMap((appName) => {
    const appChanges = changesByApp.get(appName);
    if (!appChanges) return [];
    const sortedChanges = appChanges.sort((a, b) => a.prNumber - b.prNumber);
    const uniqueEnvironments = [
      ...new Set(appChanges.map((c) => c.environment)),
    ].sort();
    const environmentList = uniqueEnvironments.join(', ');

    const appHeader = `**${appName}** (${environmentList})`;
    const prLines = sortedChanges.map(formatPRLine);

    return [appHeader, ...prLines, '']; // blank line between apps
  });

  // Remove last blank line
  sections.pop();
  return sections;
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
