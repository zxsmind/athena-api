/**
 * Keeps stdout clean for the MCP protocol.
 *
 * An MCP client on stdio parses JSON-RPC frames off stdout, so anything the
 * server prints there is indistinguishable from a malformed frame: the client
 * reports a protocol error instead of a log it could have ignored. Everything
 * the CLI prints travels on stderr instead, which the client ignores.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: Parameters<typeof console.log>) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.debug = toStderr;
}
