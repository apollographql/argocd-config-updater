import * as yaml from 'yaml';
import { readFile } from 'fs/promises';

export interface TemplateLiteral {
  literal: string;
}

export interface TemplateVariable {
  variable: string;
}

export type TemplatePart = TemplateLiteral | TemplateVariable;

export interface LinkTemplate {
  text: TemplatePart[];
  url?: TemplatePart[];
}

export interface Link {
  text: string;
  url?: string;
}

export type LinkTemplateMap = Map<string, LinkTemplate>;

function renderTemplate(
  template: TemplatePart[],
  variables: Map<string, string>,
): string {
  return template
    .map((part: TemplatePart) => {
      if ('literal' in part) {
        return part.literal;
      }
      const variableValue = variables.get(part.variable);
      if (variableValue === undefined) {
        throw Error(`Unknown template variable ${part.variable}`);
      }
      return variableValue;
    })
    .join('');
}

export function renderLinkTemplate(
  templateMap: LinkTemplateMap,
  name: string,
  variables: Map<string, string>,
): Link {
  const template = templateMap.get(name);
  if (!template) {
    throw Error(`Unknown template ${name}`);
  }
  const text = renderTemplate(template.text, variables);
  if (template.url) {
    return { text, url: renderTemplate(template.url, variables) };
  }
  return { text };
}

export async function readLinkTemplateMapFile(
  filename: string,
): Promise<LinkTemplateMap> {
  const contents = await readFile(filename, 'utf-8');
  const templateMap = new Map<string, LinkTemplate>();
  const parsed = yaml.parse(contents) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw Error(`Template map file ${filename} must be a map at the top level`);
  }
  for (const [name, parsedLinkTemplateAny] of Object.entries(parsed)) {
    const parsedLinkTemplate = parsedLinkTemplateAny as unknown;
    if (typeof parsedLinkTemplate !== 'object' || parsedLinkTemplate === null) {
      throw Error(`Template ${name} in ${filename} must be a map`);
    }
    if (!('text' in parsedLinkTemplate)) {
      throw Error(`Template ${name} in ${filename} must contain a 'text' key`);
    }
    const linkTemplate: LinkTemplate = {
      text: ensureTemplate(
        parsedLinkTemplate.text,
        `Template ${name}.text in ${filename}`,
      ),
    };
    if ('url' in parsedLinkTemplate) {
      linkTemplate.url = ensureTemplate(
        parsedLinkTemplate.url,
        `Template ${name}.url in ${filename}`,
      );
    }
    templateMap.set(name, linkTemplate);
  }
  return templateMap;
}

function ensureTemplate(
  parsedTemplate: unknown,
  errorPrefix: string,
): TemplatePart[] {
  if (!Array.isArray(parsedTemplate)) {
    throw Error(`${errorPrefix} must be a list`);
  }
  const template: TemplatePart[] = [];
  for (const partAny of parsedTemplate) {
    const part = partAny as unknown;
    if (typeof part !== 'object' || part === null) {
      throw Error(`${errorPrefix} contains a non-map part`);
    }
    if ('literal' in part && typeof part.literal === 'string') {
      template.push({ literal: part.literal });
    } else if ('variable' in part && typeof part.variable === 'string') {
      template.push({ variable: part.variable });
    } else {
      throw Error(`${errorPrefix} contains a part without literal or variable`);
    }
  }
  return template;
}
