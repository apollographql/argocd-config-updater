import { describe, it, expect, beforeEach } from "vitest";
import { join } from "path";
import {
  LinkTemplateMap,
  readLinkTemplateMapFile,
  renderLinkTemplate,
} from "../templates.js";

function fixtureFilename(filename: string): string {
  return join(__dirname, "__fixtures__", "templates", filename);
}

describe("templates", () => {
  let templateMap: LinkTemplateMap;

  beforeEach(async () => {
    templateMap = await readLinkTemplateMapFile(
      fixtureFilename("templates.yaml"),
    );
  });

  it("renders a template", () => {
    expect(
      renderLinkTemplate(
        templateMap,
        "link-one",
        new Map([
          ["foo", "hooray"],
          ["bla", "another"],
        ]),
      ),
    ).toStrictEqual({
      text: "Link to hooray",
      url: "https://some-site.example/logs/query?foo=hooray&bar=yay",
    });
  });

  it("renders without a url", () => {
    expect(
      renderLinkTemplate(templateMap, "link-two", new Map()),
    ).toStrictEqual({
      text: "Don't forget to do the thing",
    });
  });
});
