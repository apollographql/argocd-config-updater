import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { updatePromotedValues } from "../update-promoted-values.js";
import { PrefixingLogger } from "../log.js";

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(__dirname, "__fixtures__", "update-promoted-values", filename),
    "utf-8",
  );
}

const logger = PrefixingLogger.silent();

describe("action", () => {
  it("updates git refs", async () => {
    const contents = await fixture("sample.yaml");
    const { newContents, appPromotions } = await updatePromotedValues(
      contents,
      "some-app/values.yaml",
      "prod",
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();
    expect(appPromotions).toEqual([
      {
        source: {
          appName: "some-app-some-service-staging",
          gitConfig: {
            repoURL: "https://github.com/apollographql/some-repo.git",
            path: "services/hello-world",
            ref: "abcdef1234567",
          },
        },
        target: { appName: "some-app-some-service-prod" },
      },
    ]);

    // It should be idempotent in this case.
    const { newContents: actual, appPromotions: idempotentPromotions } =
      await updatePromotedValues(
        newContents,
        "some-app/values.yaml",
        "prod",
        new Set<string>(),
        logger,
      );
    expect(actual).toBe(newContents);
    // No promotions should happen when already up to date
    expect(idempotentPromotions).toEqual([]);

    // Update the first one again but freeze one environment.
    const { newContents: frozenContents, appPromotions: frozenPromotions } =
      await updatePromotedValues(
        contents,
        "some-app/values.yaml",
        null,
        new Set<string>(["some-service-prod"]),
        logger,
      );
    expect(frozenContents).toMatchSnapshot();
    // some-service-prod is frozen, but some-service-not-selected is not
    expect(frozenPromotions).toEqual([
      {
        source: {
          appName: "some-app-some-service-staging",
          gitConfig: {
            repoURL: "https://github.com/apollographql/some-repo.git",
            path: "services/hello-world",
            ref: "abcdef1234567",
          },
        },
        target: { appName: "some-app-some-service-not-selected" },
      },
    ]);
  });

  it("respects defaults and explicit specifications for yamlPaths", async () => {
    const { newContents } = await updatePromotedValues(
      await fixture("yaml-paths-defaults.yaml"),
      "some-app/values.yaml",
      null,
      new Set<string>(),
      logger,
    );

    expect(newContents).toMatchSnapshot();
  });

  it("throws if no default yamlPaths entry works", async () => {
    const contents = await fixture("default-fails.yaml");
    await expect(
      updatePromotedValues(
        contents,
        "some-app/values.yaml",
        null,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow("none of the default promoted paths");
  });

  it("uses global block values for gitConfig and dockerImage fallback", async () => {
    const contents = await fixture("global-fallback.yaml");
    const { newContents, appPromotions } = await updatePromotedValues(
      contents,
      "my-app/values.yaml",
      null,
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();
    expect(appPromotions).toEqual([
      {
        source: {
          appName: "my-app-source-env",
          gitConfig: {
            repoURL: "https://github.com/example/global-repo.git",
            path: "global/path",
            ref: "source-ref-123",
          },
          dockerImage: {
            tag: "source-tag-v1",
            setValue: ["global", "dockerImage", "tag"],
            repository: "gcr.io/example/global-image",
          },
        },
        target: { appName: "my-app-target-env" },
      },
    ]);
  });
});
