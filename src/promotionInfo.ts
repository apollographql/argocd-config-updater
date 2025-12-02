import { Link } from "./templates.js";

export interface PromotionInfoCommits {
  type: "commits";
  commitSHAs: string[]; // non-empty
}

export function promotionInfoCommits(
  commitSHAs: string[],
): PromotionInfoCommits {
  return { type: "commits", commitSHAs };
}

/** Used when the value is being changed but there are no commits between the two
 *  values (ie, no-op change). */
export interface PromotionInfoNoCommits {
  type: "no-commits";
}

/** Used when the tag/ref value isn't changed at all. */
export interface PromotionInfoNoChange {
  type: "no-change";
}

// If we're unable to tell what happened with a promotion, the message will
// explain that.
export interface PromotionInfoUnknown {
  type: "unknown";
  message: string;
}

export function promotionInfoUnknown(message: string): PromotionInfoUnknown {
  return { type: "unknown", message };
}

export type PromotionInfo =
  | PromotionInfoCommits
  | PromotionInfoNoCommits
  | PromotionInfoNoChange
  | PromotionInfoUnknown;

// This is the set of data about a promotion that, if two apps have the same
// values for it, will make them be treated as having identical promotions (ie,
// we'll only have one section about it in the PR description). Notably, it does
// not include the Docker image (or app name) because we often (due to
// monorepos) have the same set of commits contributing to multiple Docker
// images.
export interface PromotionSet {
  trimmedRepoURL: string;
  gitConfigPromotionInfo: PromotionInfo;
  // null if there's no Docker image being tracked
  dockerImagePromotionInfo: PromotionInfo | null;
  links: Link[];
}
export interface PromotionSetWithDockerImage {
  promotionSet: PromotionSet;
  dockerImageRepository: string | null; // null if there's no Docker image being tracked
}

// Map from environment (eg `staging`) to EnvironmentPromotions.
export type PromotionsByTargetEnvironment = Map<
  string,
  PromotionSetWithDockerImage
>;
