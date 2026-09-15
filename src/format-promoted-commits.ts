import { basename, dirname } from "node:path";
import {
  PromotionsByTargetEnvironment,
  PromotionSet,
} from "./promotionInfo.js";
import { PRMetadata } from "./promotion-metadata-types.js";
import { type } from "arktype";

interface App {
  appDirectory: string;
  dockerImageRepository: string | null;
}
interface PromotionSetWithApps {
  promotionSet: PromotionSet;
  apps: App[];
}

type OrganizedPromotionsByTargetEnvironment = Map<
  string,
  OrganizedPromotionsByPromotionSetJSON
>;
type OrganizedPromotionsByPromotionSetJSON = Map<string, PromotionSetWithApps>;

function reorganizePromotionInfoForMessage(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
): OrganizedPromotionsByTargetEnvironment {
  const organizedPromotionsByTargetEnvironment = new Map<
    string,
    OrganizedPromotionsByPromotionSetJSON
  >();
  for (const [
    filename,
    promotionsByTargetEnvironment,
  ] of promotionsByFileThenEnvironment.entries()) {
    const appDirectory = dirname(filename);
    for (const [
      targetEnvironment,
      promotionSetWithDockerImage,
    ] of promotionsByTargetEnvironment.entries()) {
      let organizedPromotionsByPromotionSetJSON =
        organizedPromotionsByTargetEnvironment.get(targetEnvironment);
      if (!organizedPromotionsByPromotionSetJSON) {
        organizedPromotionsByPromotionSetJSON = new Map();
        organizedPromotionsByTargetEnvironment.set(
          targetEnvironment,
          organizedPromotionsByPromotionSetJSON,
        );
      }

      const { promotionSet, dockerImageRepository } =
        promotionSetWithDockerImage;
      const promotionSetJSON = JSON.stringify(promotionSet);

      let promotionSetWithApps =
        organizedPromotionsByPromotionSetJSON.get(promotionSetJSON);
      if (!promotionSetWithApps) {
        promotionSetWithApps = { promotionSet, apps: [] };
        organizedPromotionsByPromotionSetJSON.set(
          promotionSetJSON,
          promotionSetWithApps,
        );
      }

      promotionSetWithApps.apps.push({ appDirectory, dockerImageRepository });
    }
  }
  return organizedPromotionsByTargetEnvironment;
}

export interface PromotedCommitsMarkdown {
  /** The PR body: metadata comment first, then the human-readable list. */
  promotedCommitsMarkdown: string;
  /** True if the human-readable list had to be cut to fit MAX_PR_BODY_LENGTH. */
  truncated: boolean;
}

export function formatPromotedCommits(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
  prMetadata: PRMetadata,
): PromotedCommitsMarkdown {
  const validatedPrMetadata = PRMetadata(prMetadata);
  if (validatedPrMetadata instanceof type.errors) {
    validatedPrMetadata.throw();
  }
  const organizedPromotionsByTargetEnvironment =
    reorganizePromotionInfoForMessage(promotionsByFileThenEnvironment);
  const body = [...organizedPromotionsByTargetEnvironment.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([targetEnvironment, organizedPromotionsByPromotionSetJSON]) => {
      const environmentHeader = `### Promoting to ${targetEnvironment}\n`;
      const forEnvironment = [
        ...organizedPromotionsByPromotionSetJSON.entries(),
      ]
        // We sort by the JSON value just to keep things consistent when we
        // refresh.
        .sort(([a], [b]) => a.localeCompare(b))
        .map((entry) => {
          const { promotionSet, apps } = entry[1];
          const {
            trimmedRepoURL,
            gitConfigPromotionInfo,
            dockerImagePromotionInfo,
            links,
          } = promotionSet;
          const text = [
            `Apps:\n${apps
              .sort((a, b) => a.appDirectory.localeCompare(b.appDirectory))
              .map(({ appDirectory, dockerImageRepository }) =>
                dockerImageRepository &&
                dockerImageRepository !== basename(appDirectory)
                  ? `- ${appDirectory} (image \`${dockerImageRepository}\`)\n`
                  : `- ${appDirectory}\n`,
              )
              .join("")}\n`,
          ];
          if (links.length) {
            text.push(`Links:\n`);
            for (const link of links) {
              if (link.url) {
                text.push(`- [${link.text}](${link.url})\n`);
              } else {
                text.push(`- ${link.text}\n`);
              }
            }
            text.push(`\n`);
          }
          let alreadyMentionedGitNoCommits = false;
          if (
            dockerImagePromotionInfo &&
            dockerImagePromotionInfo.type !== "no-change"
          ) {
            let maybeGitConfigNoCommits = "";
            if (gitConfigPromotionInfo.type === "no-commits") {
              alreadyMentionedGitNoCommits = true;
              maybeGitConfigNoCommits =
                " (matching Helm chart update is a no-op)";
            }
            text.push(
              `Changes to Docker images${maybeGitConfigNoCommits}:\n`,
              ...(dockerImagePromotionInfo.type === "no-commits"
                ? ["No changes affect the built Docker image."]
                : dockerImagePromotionInfo.type === "unknown"
                  ? [
                      `Cannot determine set of changes to the Docker image: ${dockerImagePromotionInfo.message}`,
                    ]
                  : dockerImagePromotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `- ${line}\n`),
            );
            text.push("\n");
          }
          if (
            gitConfigPromotionInfo.type !== "no-change" &&
            !alreadyMentionedGitNoCommits
          ) {
            text.push(
              `Changes to Helm chart:\n`,
              ...(gitConfigPromotionInfo.type === "no-commits"
                ? // This one shows up when the ref changes even though there are no

                  // new commits. This is something we do to try to make the ref
                  // match the Docker tag, so it actually does happen frequently
                  // (though usually only when the Docker tag is making a
                  // substantive change) so this message might end up being a bit
                  // spammy; we can remove it if it's not helpful.
                  [
                    "The git ref for the Helm chart has changed, but there are no new commits in the range.",
                  ]
                : gitConfigPromotionInfo.type === "unknown"
                  ? [
                      `Cannot determine set of changes to the Helm chart: ${gitConfigPromotionInfo.message}`,
                    ]
                  : gitConfigPromotionInfo.commitSHAs.map(
                      (commitSHA) => `${trimmedRepoURL}/commit/${commitSHA}`,
                    )
              ).map((line) => `- ${line}\n`),
            );
          }
          return text.join("");
        });
      return environmentHeader + forEnvironment.join("\n\n---\n\n");
    })
    .join("");
  const metadataComment = `<!-- prMetadata:${Buffer.from(JSON.stringify(prMetadata)).toString("base64")} -->\n\n`;
  return assemblePRBody(metadataComment, body);
}

// peter-evans/create-pull-request (which opens promotion PRs from this
// action's output) silently truncates PR bodies longer than this before
// sending them to GitHub. We enforce the same limit ourselves so that the
// truncation is explicit rather than silent.
export const MAX_PR_BODY_LENGTH = 65536;

// Appended to the body when the human-readable commit list had to be cut.
// A reader must never assume that an app or commit missing from the list is
// not being promoted.
//
// Starts with a blank line on purpose: `text\n---` would render as a setext
// heading rather than a horizontal rule.
export const PR_BODY_TRUNCATION_NOTICE = `

---

> [!WARNING]
> **This description is incomplete.** The full list of promoted apps and commits was longer than GitHub's ${MAX_PR_BODY_LENGTH}-character limit for pull request bodies, so it has been cut off above. Apps and commits that are not listed here are **still promoted by this PR**. The changed \`application-values.yaml\` files in the diff are the complete record of what will be deployed. Consider promoting fewer apps at a time.
`;

/**
 * Combines the metadata comment and the human-readable body into the final
 * PR body, keeping it within MAX_PR_BODY_LENGTH.
 *
 * The metadata comment goes at the *top* of the body rather than the bottom:
 * a promotion PR covering many apps can exceed the limit, and losing part of
 * the human-readable commit list is recoverable (the diff is the source of
 * truth) whereas losing part of the metadata breaks the tooling (argo-lookout)
 * that parses it to produce required status checks.
 *
 * If the body must be cut, it is cut at a line boundary (so a half-written
 * link is never emitted) and PR_BODY_TRUNCATION_NOTICE is appended.
 *
 * `metadataComment` is expected to carry its own trailing separator.
 */
export function assemblePRBody(
  metadataComment: string,
  body: string,
): PromotedCommitsMarkdown {
  const full = `${metadataComment}${body}\n`;
  if (full.length <= MAX_PR_BODY_LENGTH) {
    return { promotedCommitsMarkdown: full, truncated: false };
  }
  const available =
    MAX_PR_BODY_LENGTH -
    metadataComment.length -
    PR_BODY_TRUNCATION_NOTICE.length;
  const cutAt = available > 0 ? body.lastIndexOf("\n", available) : -1;
  const truncatedBody = cutAt > 0 ? body.slice(0, cutAt) : "";
  return {
    promotedCommitsMarkdown: `${metadataComment}${truncatedBody}${PR_BODY_TRUNCATION_NOTICE}`,
    truncated: true,
  };
}
