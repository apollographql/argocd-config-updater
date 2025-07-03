import { dirname } from 'node:path';

export interface CleanupChange {
  prNumber: number;
  prTitle: string;
  prURL: string;
  filename: string;
  environment: string;
  closedAt: string | null;
}

export function formatCleanupChanges(changes: CleanupChange[]): string {
  if (!changes.length) return '';

  // Group by environment, then by app directory
  const grouped = new Map<string, Map<string, CleanupChange[]>>();

  for (const change of changes) {
    const appDir = dirname(change.filename);
    const env = change.environment;

    let envGroup = grouped.get(env);
    if (!envGroup) {
      envGroup = new Map();
      grouped.set(env, envGroup);
    }

    let appChanges = envGroup.get(appDir);
    if (!appChanges) {
      appChanges = [];
      envGroup.set(appDir, appChanges);
    }

    appChanges.push(change);
  }

  const lines: string[] = [];
  const sortedEnvs = [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [environment, appGroups] of sortedEnvs) {
    lines.push(`## ${environment}`);
    lines.push('');

    const sortedApps = [...appGroups.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [appDir, appChanges] of sortedApps) {
      lines.push(`- ${appDir}`);

      const sortedChanges = appChanges.sort((a, b) => a.prNumber - b.prNumber);
      for (const change of sortedChanges) {
        const closedDateStr = change.closedAt
          ? ` (closed ${new Date(change.closedAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })})`
          : '';

        lines.push(
          `- PR [#${change.prNumber}](${change.prURL}): ${change.prTitle}${closedDateStr}`,
        );
      }
      lines.push('');
    }
  }

  const header = `# Found ${changes.length} closed PR${changes.length === 1 ? '' : 's'}\n\n`;
  return header + lines.join('\n').trim();
}
