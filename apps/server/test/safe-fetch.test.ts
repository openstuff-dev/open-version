import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isInternalAddress, safeFetch } from '../src/safe-fetch.js';

const PUBLIC = { mode: 'public', allow: [] } as const;
const PRIVATE = { mode: 'private', allow: [] } as const;

describe('isInternalAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('blocks %s', (address) => {
    expect(isInternalAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isInternalAddress(address)).toBe(false);
  });
});

describe('safeFetch', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end('moved');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
  });

  it('refuses internal addresses by default, as literals and by name', async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`, PUBLIC)).rejects.toThrow(/internal address/);
    await expect(safeFetch(`http://localhost:${port}/`, PUBLIC)).rejects.toThrow(/internal address/);
    await expect(safeFetch('http://[::1]/', PUBLIC)).rejects.toThrow(/internal address/);
    await expect(safeFetch('http://169.254.169.254/latest/meta-data', PUBLIC)).rejects.toThrow(/internal address/);
  });

  it('refuses other schemes and credentials in the URL', async () => {
    await expect(safeFetch('ftp://example.com/', PUBLIC)).rejects.toThrow(/http and https/);
    await expect(safeFetch('https://user:pw@example.com/', PUBLIC)).rejects.toThrow(/user name and password/);
  });

  it('reaches internal addresses with OPENVERSION_FETCH=private, and never follows redirects', async () => {
    const response = await safeFetch(`http://localhost:${port}/`, PRIVATE);
    expect(response.status).toBe(302);
    expect(response.body).toBe('moved');
  });

  it('keeps to the allowlist when one is set', async () => {
    const only = { mode: 'private', allow: ['announce.internal'] } as const;
    await expect(safeFetch(`http://localhost:${port}/`, only)).rejects.toThrow(/internal address/);
    const allowed = { mode: 'private', allow: ['localhost'] } as const;
    expect((await safeFetch(`http://localhost:${port}/`, allowed)).status).toBe(302);
  });
});
