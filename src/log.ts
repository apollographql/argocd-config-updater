import * as core from '@actions/core';

export class PrefixingLogger {
  private silent = false;

  constructor(private prefix = '') {}

  static silent(): PrefixingLogger {
    const logger = new PrefixingLogger();
    logger.silent = true;
    return logger;
  }

  info(message: string): void {
    if (!this.silent) {
      core.info(this.prefix + message);
    }
  }
  warning(message: string): void {
    if (!this.silent) {
      core.warning(this.prefix + message);
    }
  }
  error(message: string): void {
    if (!this.silent) {
      core.error(this.prefix + message);
    }
  }

  withExtendedPrefix(extension: string): PrefixingLogger {
    const logger = new PrefixingLogger(this.prefix + extension);
    logger.silent = this.silent;
    return logger;
  }
}
