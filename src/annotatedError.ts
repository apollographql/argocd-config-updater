// Error class that can annotate line/column information from YAML
import * as yaml from 'yaml';

export class AnnotatedError extends Error {
  startLine: number | undefined;
  startColumn: number | undefined;
  endLine: number | undefined;
  endColumn: number | undefined;

  constructor(
    message: string,
    {
      range,
      lineCounter,
    }: { range: yaml.Range | null | undefined; lineCounter: yaml.LineCounter },
  ) {
    super(message);
    if (range) {
      ({ line: this.startLine, col: this.startColumn } = lineCounter.linePos(
        range[0],
      ));
      // End is exclusive, so subtract 1
      ({ line: this.endLine, col: this.endColumn } = lineCounter.linePos(
        range[2] - 1,
      ));
    }
  }
}
