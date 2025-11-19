// This file is shared between argocd-config-updater (which writes promotion PR
// bodies) and argo-lookout (an internal Apollo tool which runs GitHub checks
// against promotion PRs).

import { type } from 'arktype';

export const AppPromotion = type({
  source: {
    appName: 'string',
  },
  target: {
    appName: 'string',
  },
});

export type AppPromotion = typeof AppPromotion.infer;

export const PRMetadata = type({
  appPromotions: AppPromotion.array(),
});

export type PRMetadata = typeof PRMetadata.infer;
