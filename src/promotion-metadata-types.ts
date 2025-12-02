// This file is shared between argocd-config-updater (which writes promotion PR
// bodies) and argo-lookout (an internal Apollo tool which runs GitHub checks
// against promotion PRs).

import { type } from "arktype";

export const GitConfig = type({
  repoURL: "string",
  path: "string",
  ref: "string",
});

export type GitConfig = typeof GitConfig.infer;

export const DockerImage = type({
  tag: "string",
  setValue: "string[]",
  repository: "string",
});

export type DockerImage = typeof DockerImage.infer;

export const AppPromotion = type({
  source: {
    appName: "string",
    gitConfig: GitConfig,
    "dockerImage?": DockerImage,
  },
  target: {
    appName: "string",
  },
});

export type AppPromotion = typeof AppPromotion.infer;

export const PRMetadata = type({
  appPromotions: AppPromotion.array(),
});

export type PRMetadata = typeof PRMetadata.infer;
