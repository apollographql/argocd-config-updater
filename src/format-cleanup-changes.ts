export interface CleanupChange {
  prNumber: number;
  prTitle: string;
  prURL: string;
}

export type CleanupChangesByFile = Map<string, CleanupChange[]>;

export function formatCleanupChanges(changes: CleanupChange[]): string {
  if (!changes.length) return '';

  const prMap = new Map<number, CleanupChange>();
  for (const change of changes) {
    prMap.set(change.prNumber, change);
  }

  const header = `Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}:\n\n`;

  const prLines = [...prMap.values()]
    .sort((a, b) => a.prNumber - b.prNumber)
    .map(
      (change) =>
        `- PR [#${change.prNumber}](${change.prURL}): ${change.prTitle}`,
    );

  return [header, ...prLines].join('\n');
}
