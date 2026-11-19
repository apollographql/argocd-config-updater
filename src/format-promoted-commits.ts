import { basename, dirname } from "node:path";
import {
  PromotionsByTargetEnvironment,
  PromotionSet,
} from "./promotionInfo.js";
import { PRMetadata } from "./promotion-metadata-types.js";
import { type } from "arktype";
import { eachLimit } from "async";
import { CommitInfo, GitHubClient, parseRepoURL } from "./github.js";

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

export interface PromotedCommit {
  trimmedRepoURL: string;
  commitSHA: string;
}

/**
 * Returns every commit that will be listed by formatPromotedCommits (without
 * duplicates), so that the caller can look up information about them.
 */
export function collectPromotedCommits(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
): PromotedCommit[] {
  const promotedCommits = new Map<string, PromotedCommit>();
  for (const promotionsByTargetEnvironment of promotionsByFileThenEnvironment.values()) {
    for (const {
      promotionSet: {
        trimmedRepoURL,
        gitConfigPromotionInfo,
        dockerImagePromotionInfo,
      },
    } of promotionsByTargetEnvironment.values()) {
      for (const promotionInfo of [
        gitConfigPromotionInfo,
        dockerImagePromotionInfo,
      ]) {
        if (promotionInfo?.type === "commits") {
          for (const commitSHA of promotionInfo.commitSHAs) {
            promotedCommits.set(commitURL(trimmedRepoURL, commitSHA), {
              trimmedRepoURL,
              commitSHA,
            });
          }
        }
      }
    }
  }
  return [...promotedCommits.values()];
}

/**
 * Looks up what we know about a commit. Returns null (or undefined) if we
 * don't know anything, in which case the commit is shown as a bare URL.
 */
export type CommitInfoLookup = (
  promotedCommit: PromotedCommit,
) => CommitInfo | null | undefined;

/**
 * Asks GitHub about every commit that will be listed by formatPromotedCommits,
 * and returns a CommitInfoLookup to pass to it.
 *
 * If we can't look up a commit, we just warn about it: the description is
 * still useful if that commit is shown as a bare URL.
 */
export async function lookUpCommitInfos(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
  gitHubClient: GitHubClient,
  parallelism: number,
  warn: (message: string) => void,
): Promise<CommitInfoLookup> {
  const commitInfos = new Map<string, CommitInfo | null>();
  await eachLimit(
    collectPromotedCommits(promotionsByFileThenEnvironment),
    parallelism,
    async ({ trimmedRepoURL, commitSHA }) => {
      try {
        commitInfos.set(
          commitURL(trimmedRepoURL, commitSHA),
          await gitHubClient.getCommitInfo({
            repoURL: trimmedRepoURL,
            commitSHA,
          }),
        );
      } catch (e) {
        warn(
          `Error looking up commit ${commitSHA} in ${trimmedRepoURL}; it will be listed without its author and title: ${e}`,
        );
      }
    },
  );
  return ({ trimmedRepoURL, commitSHA }) =>
    commitInfos.get(commitURL(trimmedRepoURL, commitSHA));
}

function commitURL(trimmedRepoURL: string, commitSHA: string): string {
  return `${trimmedRepoURL}/commit/${commitSHA}`;
}

// Commit titles longer than this are cut off. Git convention is to keep titles
// much shorter than this, so this is only intended to affect titles that are
// truly enormous (eg, somebody put their whole commit message on one line).
export const MAX_COMMIT_TITLE_LENGTH = 120;

// Backslash-escapes the characters that could mean something in the middle of
// a line of Markdown (emphasis, code, links, HTML, strikethrough, entities).
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>~&]/g, "\\$&");
}

// Makes a commit title safe to use as the text of a Markdown link. We leave
// (simple) code spans alone, since they are common in commit titles and it's
// nice for them to render as code, and escape everything else. Note that
// GitHub does not turn `@mentions` or `#123` references into links when they
// are already inside a link, so we don't have to worry about a title
// mentioning the wrong person or linking to an unrelated issue.
function escapeTitleForLinkText(title: string): string {
  return title
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : escapeMarkdown(part)))
    .join("");
}

function formatAuthor({ authorLogin, authorName }: CommitInfo): string {
  if (authorLogin) {
    // Apps have logins like `renovate[bot]`. There's no point in mentioning
    // them, and the brackets need to be escaped.
    return authorLogin.endsWith("[bot]")
      ? escapeMarkdown(authorLogin)
      : `@${authorLogin}`;
  }
  if (authorName) {
    // GitHub doesn't know which user wrote this commit, so all we have is the
    // name from the git commit. Make sure that we don't accidentally mention
    // some unrelated user if that name happens to contain an @.
    return escapeMarkdown(authorName.replaceAll("@", ""));
  }
  return "";
}

// Recognizes the ways that GitHub puts a PR number in the title of the commit
// it creates when merging a PR.
function pullRequestNumberFromTitle(title: string): string | null {
  return (
    // Squash and rebase merges: "Title of the PR (#123)".
    title.match(/\(#([0-9]+)\)$/)?.[1] ??
    // Merge commits: "Merge pull request #123 from org/branch".
    title.match(/^Merge pull request #([0-9]+) from /)?.[1] ??
    null
  );
}

function truncateTitle(title: string): string {
  // Count by code points so we don't cut an emoji in half.
  const titleCodePoints = Array.from(title);
  if (titleCodePoints.length <= MAX_COMMIT_TITLE_LENGTH) {
    return title;
  }
  return `${titleCodePoints
    .slice(0, MAX_COMMIT_TITLE_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

/**
 * Formats a single promoted commit as (the contents of) a Markdown list item.
 *
 * If the commit's title tells us which PR it came from (which it does for
 * commits that GitHub creates when merging a PR), it looks like:
 *
 *     @author org/repo#123 ([commit](https://github.com/org/repo/commit/SHA))
 *
 * We don't need to show the commit's title in this case, because when GitHub
 * renders a reference to a PR in a list, it shows the PR's title. We qualify
 * the reference with the repository name so that GitHub links to the right PR
 * (the promotion PR itself is generally in a different repository).
 *
 * Otherwise, it looks like:
 *
 *     @author [Title of the commit](https://github.com/org/repo/commit/SHA)
 */
export function formatPromotedCommit(
  promotedCommit: PromotedCommit,
  commitInfo: CommitInfo | null | undefined,
): string {
  const { trimmedRepoURL, commitSHA } = promotedCommit;
  const url = commitURL(trimmedRepoURL, commitSHA);
  if (!commitInfo) {
    return url;
  }

  const author = formatAuthor(commitInfo);
  const authorPrefix = author ? `${author} ` : "";
  const title = commitInfo.title.trim();

  const pullRequestNumber = pullRequestNumberFromTitle(title);
  if (pullRequestNumber) {
    let ownerAndRepo;
    try {
      ownerAndRepo = parseRepoURL(trimmedRepoURL);
    } catch {
      // Not a GitHub repo. This shouldn't happen (how did we get a
      // CommitInfo?) but if it does, we'll just show the title.
    }
    if (ownerAndRepo) {
      return `${authorPrefix}${ownerAndRepo.owner}/${ownerAndRepo.repo}#${pullRequestNumber} ([commit](${url}))`;
    }
  }

  // A link with no text doesn't render as anything you can click on.
  const linkText = title
    ? escapeTitleForLinkText(truncateTitle(title))
    : commitSHA;
  return `${authorPrefix}[${linkText}](${url})`;
}

export interface PromotedCommitsMarkdown {
  /** The PR body: metadata comment first, then the human-readable list. */
  promotedCommitsMarkdown: string;
  /** True if the human-readable list had to be cut to fit MAX_PR_BODY_LENGTH. */
  truncated: boolean;
  /**
   * A version of the human-readable list for the message of the commit that
   * performs the promotion. It has no metadata comment (the metadata is only
   * read from PR bodies), and it always lists commits as bare URLs.
   *
   * We deliberately don't describe commits here like we do in the PR body. The
   * promotion commit is re-created every time the promotion PR is updated,
   * and created again when it is merged. If its message mentioned authors and
   * referred to PRs, each of those commits would notify everyone it mentions
   * and add an entry to the timeline of every PR it refers to. And commit
   * messages aren't Markdown, so we have no way to stop GitHub from treating
   * an `@name` or `#123` in a commit title as a mention or as a reference to
   * an unrelated issue in the repository containing the promotion commit.
   */
  promotedCommitsCommitMessage: string;
}

export function formatPromotedCommits(
  promotionsByFileThenEnvironment: Map<string, PromotionsByTargetEnvironment>,
  prMetadata: PRMetadata,
  commitInfoLookup: CommitInfoLookup = () => null,
): PromotedCommitsMarkdown {
  const validatedPrMetadata = PRMetadata(prMetadata);
  if (validatedPrMetadata instanceof type.errors) {
    validatedPrMetadata.throw();
  }
  const organizedPromotionsByTargetEnvironment =
    reorganizePromotionInfoForMessage(promotionsByFileThenEnvironment);
  const renderBody = (formatCommitEntry: typeof formatPromotedCommit): string =>
    [...organizedPromotionsByTargetEnvironment.entries()]
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
            const formatCommit = (commitSHA: string): string => {
              const promotedCommit = { trimmedRepoURL, commitSHA };
              return formatCommitEntry(
                promotedCommit,
                commitInfoLookup(promotedCommit),
              );
            };
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
                    : dockerImagePromotionInfo.commitSHAs.map(formatCommit)
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
                    : gitConfigPromotionInfo.commitSHAs.map(formatCommit)
                ).map((line) => `- ${line}\n`),
              );
            }
            return text.join("");
          });
        return environmentHeader + forEnvironment.join("\n\n---\n\n");
      })
      .join("");
  const metadataComment = `<!-- prMetadata:${Buffer.from(JSON.stringify(prMetadata)).toString("base64")} -->\n\n`;
  return {
    ...assemblePRBody(metadataComment, renderBody(formatPromotedCommit)),
    promotedCommitsCommitMessage: assemblePRBody(
      "",
      renderBody(({ trimmedRepoURL, commitSHA }) =>
        commitURL(trimmedRepoURL, commitSHA),
      ),
    ).promotedCommitsMarkdown,
  };
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
): Pick<PromotedCommitsMarkdown, "promotedCommitsMarkdown" | "truncated"> {
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
