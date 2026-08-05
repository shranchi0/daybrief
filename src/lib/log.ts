import pc from "picocolors";

/** Minimal structured CLI logging. Steps go to stderr so stdout stays pipe-clean markdown. */

export const log = {
  step(msg: string): void {
    process.stderr.write(`${pc.cyan("•")} ${msg}\n`);
  },
  ok(msg: string): void {
    process.stderr.write(`${pc.green("✓")} ${msg}\n`);
  },
  warn(msg: string): void {
    process.stderr.write(`${pc.yellow("!")} ${msg}\n`);
  },
  error(msg: string): void {
    process.stderr.write(`${pc.red("✗")} ${msg}\n`);
  },
  detail(msg: string): void {
    process.stderr.write(pc.dim(`  ${msg}\n`));
  },
};
