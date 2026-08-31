/**
 * Runtime configuration.
 *
 * Every value here comes from the environment or a gitignored config file —
 * never from a committed default. The repo ships `.env.example` and
 * `config/*.example.json`; the real files are added to the deployment.
 * See docs/SECURITY.md.
 */

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  host: process.env.HAVEN_HOST ?? '0.0.0.0',
  port: int(process.env.HAVEN_PORT, 8080),
  dbPath: process.env.HAVEN_DB_PATH ?? './data/haven.db',
  logLevel: process.env.HAVEN_LOG_LEVEL ?? 'info',

  /**
   * Key used to encrypt widget credentials at rest in SQLite. Absent in
   * development; required before any connector stores a credential.
   */
  secretKey: process.env.HAVEN_SECRET_KEY ?? null,

  /** Version reported by /api/health. Injected at image build time. */
  version: process.env.HAVEN_VERSION ?? 'dev',
};
