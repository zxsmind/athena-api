import pc from 'picocolors';

/** Colors collapse to plain text when output is piped or the terminal lacks VT. */
export const color = {
  bold: (text: string) => pc.bold(text),
  dim: (text: string) => pc.dim(text),
  green: (text: string) => pc.green(text),
  yellow: (text: string) => pc.yellow(text),
  red: (text: string) => pc.red(text),
  cyan: (text: string) => pc.cyan(text),
  magenta: (text: string) => pc.magenta(text),
};

export const supportsColor = (): boolean => pc.isColorSupported;