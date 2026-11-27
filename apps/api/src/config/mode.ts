export const ARCA_MODES = ['production', 'live-debug', 'mock'] as const;
export type ArcaMode = typeof ARCA_MODES[number];
// The debug modes open /__debug routes, so they never listen beyond loopback. Production returns
// undefined to keep the server's default of every interface. So does pilot (DN-14 §5): it runs in its own container, reached
// only through Caddy, and every request but /health needs its access token.
export function listenHostname(mode: ArcaMode, pilot = false): string | undefined {
  return mode === 'production' || pilot ? undefined : '127.0.0.1';
}
