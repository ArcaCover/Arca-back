import { describe, expect, it, vi } from 'vitest';
import { DNS_RETRY_DELAYS_MS, publicAddresses } from '../../src/pipeline/network.js';

const failure = (code: string) => Object.assign(new Error(`getaddrinfo ${code} www.firm.example`), { code });
const answer = (address: string) => [{ address, family: 4 }];
const instant = { delaysMs: [0, 0] };

describe('DNS lookup retry', () => {
  it('waits a quarter of a second, then three quarters, before giving up on a name', () => {
    expect(DNS_RETRY_DELAYS_MS).toEqual([250, 750]);
  });

  it('asks again after a lookup that found nothing, and uses the answer that came', async () => {
    const lookup = vi.fn().mockRejectedValueOnce(failure('ENOTFOUND')).mockResolvedValueOnce(answer('93.184.216.34'));
    await expect(publicAddresses('https://www.firm.example/robots.txt', { ...instant, lookup })).resolves.toEqual(answer('93.184.216.34'));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('retries a temporary resolver failure and a lookup timeout', async () => {
    for (const code of ['EAI_AGAIN', 'ETIMEOUT']) {
      const lookup = vi.fn().mockRejectedValueOnce(failure(code)).mockResolvedValueOnce(answer('93.184.216.34'));
      await expect(publicAddresses('https://www.firm.example/', { ...instant, lookup })).resolves.toEqual(answer('93.184.216.34'));
      expect([code, lookup.mock.calls.length]).toEqual([code, 2]);
    }
  });

  it('gives up after three lookups that all failed, with the last error', async () => {
    const lookup = vi.fn().mockRejectedValue(failure('ENOTFOUND'));
    await expect(publicAddresses('https://www.firm.example/', { ...instant, lookup })).rejects.toThrow('ENOTFOUND');
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other failure', async () => {
    const lookup = vi.fn().mockRejectedValue(failure('ENODATA'));
    await expect(publicAddresses('https://www.firm.example/', { ...instant, lookup })).rejects.toThrow('ENODATA');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('still refuses a private address that a retried lookup returned', async () => {
    const lookup = vi.fn().mockRejectedValueOnce(failure('ENOTFOUND')).mockResolvedValueOnce(answer('10.0.0.1'));
    await expect(publicAddresses('https://www.firm.example/', { ...instant, lookup })).rejects.toThrow('Non-public network target');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('stops waiting to retry when the caller gives up', async () => {
    const controller = new AbortController();
    const lookup = vi.fn().mockImplementation(async () => { controller.abort(); throw failure('ENOTFOUND'); });
    await expect(publicAddresses('https://www.firm.example/', { delaysMs: [60_000, 60_000], lookup, signal: controller.signal }))
      .rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
