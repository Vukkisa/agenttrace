/** Package version. Kept in sync with package.json (checked by a test). */
export const VERSION = '0.3.2';

/**
 * Bump whenever a parser or analysis change can alter results for unchanged log files.
 * Any change invalidates the whole summary cache.
 */
export const PARSER_VERSION = 3;
