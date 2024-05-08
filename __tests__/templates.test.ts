import { join } from 'path';
import { readLinkTemplateMapFile, renderLinkTemplate } from '../src/templates';

function fixtureFilename(filename: string): string {
  return join(__dirname, '__fixtures__', 'templates', filename);
}

describe('templates', () => {
  it('renders a template', async () => {
    const templateMap = await readLinkTemplateMapFile(
      fixtureFilename('templates.yaml'),
    );
    expect(
      renderLinkTemplate(
        templateMap,
        'link-one',
        new Map([
          ['foo', 'hooray'],
          ['bla', 'another'],
        ]),
      ),
    ).toStrictEqual({
      text: 'Link to hooray',
      url: 'https://some-site.example/logs/query?foo=hooray&bar=yay',
    });
  });
});
