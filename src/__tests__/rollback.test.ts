import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rollback,
  GitHistoryReader,
  AppRollback,
  ChildProcessGitHistoryReader,
} from "../rollback.js";
import { PrefixingLogger } from "../log.js";

const execFileAsync = promisify(execFile);

const logger = PrefixingLogger.silent();

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/** In-memory GitHistoryReader for tests. Commit lists are newest-first (HEAD-first),
 *  which matches `git log --format=%H` output. */
class FakeGitHistoryReader implements GitHistoryReader {
  constructor(private history: { commit: string; contents: string | null }[]) {}

  async listCommitsAffectingFile(relativePath: string): Promise<string[]> {
    void relativePath;
    // Every entry is listed, including ones with null contents: `git log -- path`
    // does report commits where `git show <commit>:path` fails (a path deleted
    // and later re-added lists commits from both eras). `contents: null` models
    // exactly that commit, so the caller's skip path gets exercised.
    return this.history.map((h) => h.commit);
  }

  async readFileAtCommit(
    commit: string,
    relativePath: string,
  ): Promise<string> {
    void relativePath;
    const entry = this.history.find((h) => h.commit === commit);
    if (!entry || entry.contents === null) {
      throw new Error(`path did not exist at ${commit}`);
    }
    return entry.contents;
  }
}

/** Minimal valid values file with a promoted prod env. */
function valuesFile({
  prodRef,
  prodTag,
  stagingRef = "staging-ref-111",
  stagingTag = "main---0000001-stage-gstaging-ref-111",
}: {
  prodRef: string;
  prodTag: string;
  stagingRef?: string;
  stagingTag?: string;
}): string {
  return `global:
  namespace: apollo-default
  gitConfig:
    repoURL: https://github.com/mdg-private/monorepo.git
    path: apps/identity/chart
  dockerImage:
    repository: identity

staging:
  track: main
  gitConfig:
    ref: ${stagingRef}
  dockerImage:
    tag: ${stagingTag}

prod:
  gitConfig:
    ref: ${prodRef}
  dockerImage:
    tag: ${prodTag}
  promote:
    from: staging
`;
}

const CURRENT = {
  prodRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  prodTag: "main---0000300-2026.04-gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const PREVIOUS = {
  prodRef: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  prodTag: "main---0000250-2026.03-gbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const OLDER = {
  prodRef: "cccccccccccccccccccccccccccccccccccccccc",
  prodTag: "main---0000200-2026.02-gcccccccccccccccccccccccccccccccccccccccc",
};

describe("rollback", () => {
  describe("blank target SHA (roll back to previous deploy)", () => {
    it("rolls back ref and tag when previous commit actually changed prod", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "commit-now", contents: valuesFile(CURRENT) },
        { commit: "commit-prev", contents: valuesFile(PREVIOUS) },
      ]);

      const { newContents, rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "teams/foundation/identity/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(newContents).toContain(`ref: ${PREVIOUS.prodRef}`);
      expect(newContents).toContain(`tag: ${PREVIOUS.prodTag}`);
      expect(newContents).not.toContain(`ref: ${CURRENT.prodRef}`);
      expect(newContents).not.toContain(`tag: ${CURRENT.prodTag}`);
      expect(rollbacks).toEqual<AppRollback[]>([
        {
          appName: "identity-prod",
          environment: "prod",
          previousRef: CURRENT.prodRef,
          rolledBackRef: PREVIOUS.prodRef,
          previousTag: CURRENT.prodTag,
          rolledBackTag: PREVIOUS.prodTag,
          resolvedFromCommit: "commit-prev",
        },
      ]);
    });

    it("walks past auto-update commits that did not touch prod", async () => {
      // Simulate: HEAD is current. Several earlier commits changed staging only;
      // farther back is the actual previous prod deploy.
      const autoUpdate = (stagingRef: string): string =>
        valuesFile({
          ...CURRENT,
          stagingRef,
          stagingTag: `main---X-g${stagingRef}`,
        });

      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-auto-3", contents: autoUpdate("staging-ref-333") },
        { commit: "c-auto-2", contents: autoUpdate("staging-ref-222") },
        { commit: "c-auto-1", contents: autoUpdate("staging-ref-111") },
        { commit: "c-prev-prod", contents: valuesFile(PREVIOUS) },
      ]);

      const { rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(rollbacks[0].rolledBackRef).toBe(PREVIOUS.prodRef);
      expect(rollbacks[0].resolvedFromCommit).toBe("c-prev-prod");
    });

    it("throws when there is no previous prod deploy in history", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
      ]);
      await expect(
        rollback({
          contents: valuesFile(CURRENT),
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/No previous deploy found/);
    });

    it("skips older commits where the file did not yet exist", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-missing", contents: null },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
      ]);

      const { rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(rollbacks[0].rolledBackRef).toBe(PREVIOUS.prodRef);
    });

    it("skips older commits where the YAML was malformed", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-bad", contents: "::: not valid yaml :::\n  - [[[" },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
      ]);

      const { rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(rollbacks[0].rolledBackRef).toBe(PREVIOUS.prodRef);
    });

    it("stops at the commit where the env was introduced instead of rolling back past it", async () => {
      // The prod block does not exist before `c-added`. The OLDER ref below sits
      // in a pre-prod era of the file; rolling back to it would deploy a ref
      // that prod never ran.
      const withoutProd = `global: {}

staging:
  track: main
  gitConfig:
    ref: ${OLDER.prodRef}
  dockerImage:
    tag: ${OLDER.prodTag}
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-added", contents: withoutProd },
        { commit: "c-ancient", contents: valuesFile(OLDER) },
      ]);

      await expect(
        rollback({
          contents: valuesFile(CURRENT),
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/no pinned `gitConfig.ref` as of commit c-added/);
    });
  });

  describe("explicit target SHA", () => {
    it("rolls back to the commit where prod held that SHA", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
        { commit: "c-older", contents: valuesFile(OLDER) },
      ]);

      const { rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: OLDER.prodRef,
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(rollbacks[0].rolledBackRef).toBe(OLDER.prodRef);
      expect(rollbacks[0].rolledBackTag).toBe(OLDER.prodTag);
      expect(rollbacks[0].resolvedFromCommit).toBe("c-older");
    });

    it("throws when the explicit SHA never appeared in prod", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
      ]);

      await expect(
        rollback({
          contents: valuesFile(CURRENT),
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "deadbeef00000000000000000000000000000000",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/has never been deployed/);
    });

    it("throws when explicit SHA is the current SHA (no-op)", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
      ]);

      await expect(
        rollback({
          contents: valuesFile(CURRENT),
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: CURRENT.prodRef,
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/would be a no-op/);
    });

    it("is not confused by staging holding the target SHA at some point", async () => {
      // PREVIOUS.prodRef was once staging's ref — but we're asking for a rollback
      // of prod, so we should only find it in prod's history.
      const stagingHadPrevPromoted = valuesFile({
        ...CURRENT,
        stagingRef: PREVIOUS.prodRef,
        stagingTag: PREVIOUS.prodTag,
      });
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        // Staging briefly held PREVIOUS.prodRef — but prod did not.
        { commit: "c-staging-had-it", contents: stagingHadPrevPromoted },
      ]);

      await expect(
        rollback({
          contents: valuesFile(CURRENT),
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: PREVIOUS.prodRef,
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/has never been deployed/);
    });
  });

  describe("env selection", () => {
    it("rolls back staging when targetEnv=staging and staging has promote.from", async () => {
      const dualPromote = (prodRef: string, stagingRef: string): string =>
        `global:
  namespace: apollo-default
  gitConfig:
    repoURL: https://github.com/x/y.git
    path: charts/app

dev:
  track: main
  gitConfig:
    ref: dev-ref-111
  dockerImage:
    tag: main---0001-gdev-ref-111

staging:
  gitConfig:
    ref: ${stagingRef}
  dockerImage:
    tag: main---0002-g${stagingRef}
  promote:
    from: dev

prod:
  gitConfig:
    ref: ${prodRef}
  dockerImage:
    tag: main---0003-g${prodRef}
  promote:
    from: staging
`;
      const reader = new FakeGitHistoryReader([
        {
          commit: "c-head",
          contents: dualPromote("prod-current", "staging-current"),
        },
        {
          commit: "c-prev",
          contents: dualPromote("prod-current", "staging-previous"),
        },
      ]);

      const { rollbacks } = await rollback({
        contents: dualPromote("prod-current", "staging-current"),
        filename: "a/application-values.yaml",
        targetEnv: "staging",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(rollbacks).toHaveLength(1);
      expect(rollbacks[0].environment).toBe("staging");
      expect(rollbacks[0].rolledBackRef).toBe("staging-previous");
    });

    it("passes through (no change, no rollback) when the file does not contain the target env", async () => {
      const noProdFile = `global:
  namespace: apollo-default

dev:
  track: main
  gitConfig:
    ref: dev-ref
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: noProdFile },
      ]);

      const { newContents, rollbacks } = await rollback({
        contents: noProdFile,
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(newContents).toBe(noProdFile);
      expect(rollbacks).toEqual([]);
    });

    it("passes through when the target env has no promote.from (roll forward, not rollback)", async () => {
      // prod here tracks main directly, no promote block — not a rollback candidate.
      const tracksMainFile = `global:
  namespace: apollo-default
  gitConfig:
    repoURL: https://github.com/x/y.git
    path: charts/app

prod:
  track: main
  gitConfig:
    ref: some-ref
  dockerImage:
    tag: main---0001-gsome-ref
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: tracksMainFile },
        {
          commit: "c-prev",
          contents: tracksMainFile.replace(/some-ref/g, "older-ref"),
        },
      ]);

      const { newContents, rollbacks } = await rollback({
        contents: tracksMainFile,
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(newContents).toBe(tracksMainFile);
      expect(rollbacks).toEqual([]);
    });

    it("respects frozenEnvironments", async () => {
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: valuesFile(CURRENT) },
        { commit: "c-prev", contents: valuesFile(PREVIOUS) },
      ]);

      const { newContents, rollbacks } = await rollback({
        contents: valuesFile(CURRENT),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(["prod"]),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(newContents).toBe(valuesFile(CURRENT));
      expect(rollbacks).toEqual([]);
    });
  });

  describe("structural validation of the current file", () => {
    it("throws when prod has no gitConfig block", async () => {
      const broken = `global: {}

prod:
  promote:
    from: staging
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: broken },
      ]);

      await expect(
        rollback({
          contents: broken,
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/missing `gitConfig` block/);
    });

    it("throws when gitConfig.ref is missing", async () => {
      const broken = `global: {}

prod:
  gitConfig:
    repoURL: https://example.com/x.git
  promote:
    from: staging
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: broken },
      ]);

      await expect(
        rollback({
          contents: broken,
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/`gitConfig.ref` is not set/);
    });

    it("throws when current has a dockerImage.tag but historical does not", async () => {
      const withTag = valuesFile(CURRENT);
      const historicalWithoutTag = `global: {}

staging:
  track: main
  gitConfig:
    ref: s
prod:
  gitConfig:
    ref: ${PREVIOUS.prodRef}
  promote:
    from: staging
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: withTag },
        { commit: "c-prev", contents: historicalWithoutTag },
      ]);

      await expect(
        rollback({
          contents: withTag,
          filename: "a/application-values.yaml",
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        }),
      ).rejects.toThrow(/historical file .* does not/);
    });
  });

  describe("YAML preservation", () => {
    it("preserves comments, quoting style, and non-target lines unchanged", async () => {
      const withFormatting = `# top of file
global:
  namespace: apollo-default          # inline comment
  gitConfig:
    repoURL: "https://github.com/x/y.git"
    path: charts/app

# Production deploy — promoted from staging
prod:
  gitConfig:
    ref: ${CURRENT.prodRef}
  dockerImage:
    tag: ${CURRENT.prodTag}
  promote:
    from: staging
`;
      const historical = withFormatting
        .replace(CURRENT.prodRef, PREVIOUS.prodRef)
        .replace(CURRENT.prodTag, PREVIOUS.prodTag);

      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: withFormatting },
        { commit: "c-prev", contents: historical },
      ]);

      const { newContents } = await rollback({
        contents: withFormatting,
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      // Comments and quotes untouched.
      expect(newContents).toContain("# top of file");
      expect(newContents).toContain("# inline comment");
      expect(newContents).toContain(
        "# Production deploy — promoted from staging",
      );
      expect(newContents).toContain('repoURL: "https://github.com/x/y.git"');
      // The edit happened.
      expect(newContents).toContain(`ref: ${PREVIOUS.prodRef}`);
      expect(newContents).toContain(`tag: ${PREVIOUS.prodTag}`);
    });
  });

  describe("ChildProcessGitHistoryReader against a real git repo", () => {
    it("reads history and rolls back using real git", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rollback-integ-"));
      try {
        // Init a throwaway repo with a deterministic commit graph.
        await git(dir, ["init", "-q", "-b", "main"]);
        await git(dir, ["config", "user.email", "test@example.com"]);
        await git(dir, ["config", "user.name", "Test"]);
        await git(dir, ["config", "commit.gpgsign", "false"]);

        const file = "teams/foundation/widget/application-values.yaml";
        const { mkdir } = await import("node:fs/promises");
        await mkdir(join(dir, "teams/foundation/widget"), { recursive: true });

        // Commit 1: PREVIOUS prod ref.
        await writeFile(join(dir, file), valuesFile(PREVIOUS));
        await git(dir, ["add", file]);
        await git(dir, ["commit", "-q", "-m", "first deploy to prod"]);

        // Commits 2, 3: auto-update commits that only change staging — they
        // also touch the file so they'll appear in `git log -- <file>`.
        await writeFile(
          join(dir, file),
          valuesFile({
            ...PREVIOUS,
            stagingRef: "staging-111",
            stagingTag: "main---1-gstaging-111",
          }),
        );
        await git(dir, ["add", file]);
        await git(dir, [
          "commit",
          "-q",
          "-m",
          "argocd-config-updater: staging",
        ]);

        await writeFile(
          join(dir, file),
          valuesFile({
            ...PREVIOUS,
            stagingRef: "staging-222",
            stagingTag: "main---2-gstaging-222",
          }),
        );
        await git(dir, ["add", file]);
        await git(dir, [
          "commit",
          "-q",
          "-m",
          "argocd-config-updater: staging",
        ]);

        // Commit 4: promote the CURRENT ref to prod.
        await writeFile(
          join(dir, file),
          valuesFile({
            ...CURRENT,
            stagingRef: "staging-222",
            stagingTag: "main---2-gstaging-222",
          }),
        );
        await git(dir, ["add", file]);
        await git(dir, ["commit", "-q", "-m", "promote widget to prod"]);

        // Read the HEAD version and roll it back.
        const { readFile } = await import("node:fs/promises");
        const headContents = await readFile(join(dir, file), "utf-8");

        const reader = new ChildProcessGitHistoryReader(dir);
        const { newContents, rollbacks } = await rollback({
          contents: headContents,
          filename: file,
          targetEnv: "prod",
          gitSha: "",
          frozenEnvironments: new Set(),
          gitHistoryReader: reader,
          _logger: logger,
        });

        // Rollback walked past the 2 auto-update commits to the original deploy.
        expect(rollbacks).toHaveLength(1);
        expect(rollbacks[0].rolledBackRef).toBe(PREVIOUS.prodRef);
        expect(rollbacks[0].rolledBackTag).toBe(PREVIOUS.prodTag);
        expect(newContents).toContain(`ref: ${PREVIOUS.prodRef}`);
        expect(newContents).toContain(`tag: ${PREVIOUS.prodTag}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("no dockerImage block on env", () => {
    it("rolls back just ref when env has no dockerImage.tag", async () => {
      const minimal = (ref: string): string => `global: {}

staging:
  track: main
  gitConfig:
    ref: s

prod:
  gitConfig:
    ref: ${ref}
  promote:
    from: staging
`;
      const reader = new FakeGitHistoryReader([
        { commit: "c-head", contents: minimal("r-new") },
        { commit: "c-prev", contents: minimal("r-old") },
      ]);

      const { newContents, rollbacks } = await rollback({
        contents: minimal("r-new"),
        filename: "a/application-values.yaml",
        targetEnv: "prod",
        gitSha: "",
        frozenEnvironments: new Set(),
        gitHistoryReader: reader,
        _logger: logger,
      });

      expect(newContents).toContain("ref: r-old");
      expect(rollbacks[0].previousTag).toBeNull();
      expect(rollbacks[0].rolledBackTag).toBeNull();
    });
  });
});
