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
   * Uploaded app icons. Lives on the data volume, never in the repo — an
   * upload endpoint that writes into the checkout is how a public repo grows
   * private assets.
   */
  iconDir: process.env.HAVEN_ICON_DIR ?? './data/icons',

  /**
   * Seed for the app registry. Read once, on first boot, when the table is
   * empty; the database is the source of truth afterwards.
   */
  appsConfigPath: process.env.HAVEN_APPS_CONFIG ?? './config/apps.json',

  /**
   * Key used to encrypt widget credentials at rest in SQLite. Absent in
   * development; required before any connector stores a credential.
   */
  secretKey: process.env.HAVEN_SECRET_KEY ?? null,

  /**
   * Calendar feeds — one or more ICS URLs.
   *
   * A "secret address in iCal format" is a BEARER CREDENTIAL: holding it is
   * holding read access to the calendar. It therefore lives only here, is
   * never sent to the browser, and is never interpolated into a log line or
   * an error message. See `server/src/connectors/calendar.js`.
   *
   * Accepts `url` or a comma-separated `Name|url` list.
   */
  calendarIcsUrl: process.env.HAVEN_CALENDAR_ICS_URL ?? null,

  /** Version reported by /api/health. Injected at image build time. */
  version: process.env.HAVEN_VERSION ?? 'dev',

  /**
   * GitHub token for the releases API, used by the version connector.
   *
   * Optional: public repos resolve unauthenticated, just at a much lower rate
   * limit (60/hour per IP, shared by everyone behind it). It lives here and
   * never leaves the server — the browser asks `/api/versions`, not GitHub.
   */
  githubToken: process.env.HAVEN_GITHUB_TOKEN ?? null,

  /**
   * Running container versions, as a JSON object of containerId -> version.
   *
   * The old dashboard shelled out to Docker for this. Haven does not mount the
   * Docker socket — handing a web-facing container root-equivalent access to
   * the host is a bad trade for displaying a string — so an operator supplies
   * the map instead. Absent or malformed means "current version unknown",
   * which the card renders quietly rather than as an error.
   */
  containerVersions: parseJsonObject(process.env.HAVEN_CONTAINER_VERSIONS),
};

/**
 * Parses an env var holding a JSON object, tolerating anything else.
 *
 * A typo in this variable must not stop the server booting: an unparseable
 * value degrades to "no known versions", exactly like an absent one.
 */
function parseJsonObject(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
