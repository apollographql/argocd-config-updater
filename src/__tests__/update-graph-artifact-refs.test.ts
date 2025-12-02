import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import { updateGraphArtifactRefs } from "../update-graph-artifact-refs.js";
import { PrefixingLogger } from "../log.js";
import {
  DockerRegistryClient,
  GetDigestForTagOptions,
} from "../artifactRegistry.js";

async function fixture(filename: string): Promise<string> {
  return await readFile(
    join(
      __dirname,
      "__fixtures__",
      "update-promoted-graph-artifacts",
      filename,
    ),
    "utf-8",
  );
}

const logger = PrefixingLogger.silent();
const imageTagMap: { [imageName: string]: { [tag: string]: string } } = {
  "some-service-ed9f6f25068608ef": {
    "dev0-00872a1964b50f1b":
      "sha256:90ee9ef20ce29314b29ccbbf4c50c1a881e35fdba7f53445cc083247bba9a6fb",
    "dev1-00872a1964b50f1b":
      "sha256:ecb1de1af081bbad2e770d3db8dde4fc4b4eca6ab3e6950f8f2d833f1690b280",
    "staging-00872a1964b50f1b":
      "sha256:81b06e1d3cafc6d2e29d9ed9f6b1ee6a7b09914ff9fe2c0fded6dc00e337566d",
    "prod-00872a1964b50f1b":
      "sha256:23241438abb41ee697d51878a5f2d29bf5824496e7aeb8649c8d826541160a4b",
    "another-00872a1964b50f1b":
      "sha256:ffc964f26300b5fb3fe36b379ad832963fec1529ea98d1bb5e1bf3acc0e210b6",
    "top-level-00872a1964b50f1b":
      "sha256:113e331763502fcfadfa3f7de2e2abcebd966a1af4e3bd2ac25d65ace3e7cc08",
  },
};
const dockerRegistryClient: DockerRegistryClient = {
  async getDigestForTag({
    packageName,
    tagName,
  }: GetDigestForTagOptions): Promise<string> {
    const digest = imageTagMap[packageName]?.[tagName];
    if (!digest) {
      throw new Error(`The tag '${tagName}' on the image '${packageName}'
        does not exist. Check that both the image and tag are spelled correctly.`);
    }
    return digest;
  },
  async getAllEquivalentTags() {
    return [];
  },
  async getGitCommitsBetweenTags() {
    return { type: "no-commits" };
  },
};

describe("action", () => {
  it("updates graph artifact refs", async () => {
    const contents = await fixture("sample.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toMatchSnapshot();
  });

  it("handles empty YAML file gracefully", async () => {
    const contents = await fixture("empty.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toBe(contents);
  });

  it("handles YAML with only whitespace gracefully", async () => {
    const contents = await fixture("whitespace-only.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    expect(newContents).toBe(contents);
  });

  it("handles YAML without global supergraph configuration", async () => {
    const contents = await fixture("no-global-supergraph.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    // Should return unchanged content since no global supergraph configuration exists
    expect(newContents).toBe(contents);
  });

  it("handles missing artifactURL in global supergraph", async () => {
    const contents = await fixture("missing-artifact-url.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      "global.supergraph must provide both artifactURL and imageName",
    );
  });

  it("handles missing imageName in global supergraph", async () => {
    const contents = await fixture("missing-image-name.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      "global.supergraph must provide both artifactURL and imageName",
    );
  });

  it("handles global supergraph that is not a map", async () => {
    const contents = await fixture("global-supergraph-not-map.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      "global.supergraph must be a map with artifactURL and imageName",
    );
  });

  it("handles blocks without supergraph section", async () => {
    const contents = await fixture("blocks-without-supergraph.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    // Should return unchanged content since no blocks have supergraph sections
    expect(newContents).toBe(contents);
  });

  it("handles supergraph section that is not a map", async () => {
    const contents = await fixture("supergraph-section-not-map.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(/`some-service-dev0\.supergraph` must be a map/);
  });

  it("handles missing digest in supergraph section", async () => {
    const contents = await fixture("missing-digest.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      /`some-service-dev0\.supergraph\.digest` must be provided/,
    );
  });

  it("handles missing trackMutableTag in supergraph section", async () => {
    const contents = await fixture("missing-track-mutable-tag.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      /`some-service-dev0\.supergraph\.trackMutableTag` must be provided/,
    );
  });

  it("handles supergraph with missing image name in registry", async () => {
    const contents = await fixture("image-name-missing-registry.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      /The tag 'dev0' on the image 'some-service-with-dashes'[\s\S]*does not exist[\s\S]*Check that both the image and tag are spelled correctly/,
    );
  });

  it("handles supergraph with missing tag in registry", async () => {
    const contents = await fixture("tag-missing-registry.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(
      /The tag 'dev-0' on the image 'some-service'[\s\S]*does not exist[\s\S]*Check that both the image and tag are spelled correctly/,
    );
  });

  it("handles frozen environments correctly", async () => {
    const contents = await fixture("frozen-environment.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(["some-service-dev0"]), // This environment is frozen
      logger,
    );
    // Should return unchanged content since environment is frozen
    expect(newContents).toBe(contents);
  });

  it("handles multiple frozen environments correctly", async () => {
    const contents = await fixture("sample.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(["some-service-dev0", "some-service-dev1"]), // Multiple frozen environments
      logger,
    );
    // Should process non-frozen environments but skip frozen ones
    expect(newContents).not.toBe(contents);
    // Check that frozen environments are not updated
    expect(newContents).toContain("digest: overwrite-me");
    // Check that non-frozen environments are updated
    expect(newContents).toContain(
      "sha256:81b06e1d3cafc6d2e29d9ed9f6b1ee6a7b09914ff9fe2c0fded6dc00e337566d",
    );
  });

  it("throws error on invalid supergraph section in mixed valid and invalid entries", async () => {
    const contents = await fixture("mixed-valid-invalid-entries.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(/`some-service-invalid\.supergraph` must be a map/);
  });

  it("throws error on malformed YAML structure", async () => {
    const contents = await fixture("malformed-yaml-structure.yaml");
    await expect(
      updateGraphArtifactRefs(
        contents,
        dockerRegistryClient,
        new Set<string>(),
        logger,
      ),
    ).rejects.toThrow(/Error parsing YAML file/);
  });

  it("handles empty trackables array when no blocks have supergraph sections", async () => {
    const contents = await fixture("blocks-without-supergraph.yaml");
    const newContents = await updateGraphArtifactRefs(
      contents,
      dockerRegistryClient,
      new Set<string>(),
      logger,
    );
    // Should return unchanged content when no trackables are found
    expect(newContents).toBe(contents);
  });
});
