import { Link } from './templates';

export interface PromotionInfoCommits {
  type: 'commits';
  commitSHAs: string[]; // non-empty
}

export function promotionInfoCommits(
  commitSHAs: string[],
): PromotionInfoCommits {
  return { type: 'commits', commitSHAs };
}

/** Used when the value is being changed but there are no commits between the two
 *  values (ie, no-op change). */
export interface PromotionInfoNoCommits {
  type: 'no-commits';
}

/** Used when the tag/ref value isn't changed at all. */
export interface PromotionInfoNoChange {
  type: 'no-change';
}

// If we're unable to tell what happened with a promotion, the message will
// explain that.
export interface PromotionInfoUnknown {
  type: 'unknown';
  message: string;
}

export function promotionInfoUnknown(message: string): PromotionInfoUnknown {
  return { type: 'unknown', message };
}

export type PromotionInfo =
  | PromotionInfoCommits
  | PromotionInfoNoCommits
  | PromotionInfoNoChange
  | PromotionInfoUnknown;

export interface EnvironmentPromotions {
  environment: string;
  trimmedRepoURL: string;
  gitConfigPromotionInfo: PromotionInfo;
  dockerImage: {
    repository: string;
    promotionInfo: PromotionInfo;
  } | null; // null if there's no Docker image being tracked
  links: Link[];
}
// Map from application-values filenames to EnvironmentPromotions.
export type PromotionsByFile = Map<string, EnvironmentPromotions[]>;
