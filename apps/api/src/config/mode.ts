export const ARCA_MODES = ['production', 'live-debug', 'mock'] as const;
export type ArcaMode = typeof ARCA_MODES[number];
// The debug modes open /__debug routes, so they never listen beyond loopback. Production returns
// undefined to keep the server's default of every interface.
export function listenHostname(mode: ArcaMode): string | undefined {
  return mode === 'production' ? undefined : '127.0.0.1';
}
