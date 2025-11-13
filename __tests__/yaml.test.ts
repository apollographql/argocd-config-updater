import { describe, it, expect } from 'vitest';
import { parseYAML } from '../src/yaml';

describe('yaml', () => {
  describe('parseYAML', () => {
    it('throws on parse error', () => {
      expect(() => parseYAML('foo: :')).toThrow(
        'Error parsing YAML file: YAMLParseError: Nested mappings are not allowed in compact mappings',
      );
    });
  });
});
