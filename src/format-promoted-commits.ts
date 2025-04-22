import { PromotionsByTargetEnvironment } from './promotionInfo';

export function formatPromotedCommits(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
): string {
  return [...promotionsByFileThenEnvironment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, promotionsByTargetEnvironment]) => {
      const fileHeader = `* ${filename}\n`;
      const byEnvironment = [...promotionsByTargetEnvironment.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([environment, promotionSetWithDockerImage]) => {
          const { promotionSet, dockerImageRepository } =
            promotionSetWithDockerImage;
          const {
            trimmedRepoURL,
            gitConfigPromotionInfo,
            dockerImagePromotionInfo,
            links,
          } = promotionSet;
          const lines = [`  - ${environment}\n`];
          for (const link of links) {
            if (link.url) {
              lines.push(`    + [${link.text}](${link.url})\n`);
            } else {
              lines.push(`    + ${link.text}\n`);
            }
          }
          let alreadyMentionedGitNoCommits = false;
          if (
            dockerImageRepository &&
            dockerImagePromotionInfo &&
            dockerImagePromotionInfo.type !== 'no-change'
          ) {
            let maybeGitConfigNoCommits = '';
            if (gitConfigPromotionInfo.type === 'no-commits') {
              alreadyMentionedGitNoCommits = true;
              maybeGitConfigNoCommits =
                ' (and the git ref for the Helm chart made a no-op change to match)';
            }
            lines.push(
              `    + Changes to Docker image \`${dockerImageRepository}\`${maybeGitConfigNoCommits}\n`,
              ...(dockerImagePromotionInfo.type === 'no-commits'
                ? ['No changes affect the built Docker image.']
                : dockerImagePromotionInfo.type === 'unknown'
                  ? [
                      `Cannot determine set of changes to the Docker image: ${dockerImagePromotionInfo.message}`,
                    ]
                  : dockerImagePromotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `      * ${line}\n`),
            );
          }
          if (
            gitConfigPromotionInfo.type !== 'no-change' &&
            !alreadyMentionedGitNoCommits
          ) {
            lines.push(
              `    + Changes to Helm chart\n`,
              ...(gitConfigPromotionInfo.type === 'no-commits'
                ? // This one shows up when the ref changes even though there are no

                  // new commits. This is something we do to try to make the ref
                  // match the Docker tag, so it actually does happen frequently
                  // (though usually only when the Docker tag is making a
                  // substantive change) so this message might end up being a bit
                  // spammy; we can remove it if it's not helpful.
                  [
                    'The git ref for the Helm chart has changed, but there are no new commits in the range.',
                  ]
                : gitConfigPromotionInfo.type === 'unknown'
                  ? [
                      `Cannot determine set of changes to the Helm chart: ${gitConfigPromotionInfo.message}`,
                    ]
                  : gitConfigPromotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `      * ${line}\n`),
            );
          }
          return lines.join('');
        });
      return fileHeader + byEnvironment.join('\n');
    })
    .join('');
}
