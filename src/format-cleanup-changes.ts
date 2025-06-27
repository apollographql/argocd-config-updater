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

  const changesByAppEnv = groupChangesByAppAndEnv(changes);
  const sortedKeys = [...changesByAppEnv.keys()].sort();

  const header = `Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}:\n\n`;
  const sections = buildSections(sortedKeys, changesByAppEnv);

  return header + sections.join('\n');
}

function groupChangesByAppAndEnv(
  changes: CleanupChange[],
): Map<string, CleanupChange[]> {
  const changesByAppEnv = new Map<string, CleanupChange[]>();

  for (const change of changes) {
    const key = `${change.appName}|${change.environment}`;
    const existing = changesByAppEnv.get(key);
    if (existing) {
      existing.push(change);
    } else {
      changesByAppEnv.set(key, [change]);
    }
  }

  return changesByAppEnv;
}

function buildSections(
  sortedKeys: string[],
  changesByAppEnv: Map<string, CleanupChange[]>,
): string[] {
  const sections = sortedKeys.flatMap((key) => {
    const appChanges = changesByAppEnv.get(key);
    if (!appChanges) return [];

    const [appName, environment] = key.split('|');
    const sortedChanges = appChanges.sort((a, b) => a.prNumber - b.prNumber);

    const appHeader = `**${appName}** (${environment})`;
    const prLines = sortedChanges.map(formatPRLine);

    return [appHeader, ...prLines, '']; // blank line between sections
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
