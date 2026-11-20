import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeApiUrl, saveInitProfile, validateApiKey, validateNetwork } from './profiles.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'stellar-alerts-init-'));
}

describe('CLI init profile helpers', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes API URLs', () => {
    expect(normalizeApiUrl(' http://localhost:3001/ ')).toBe('http://localhost:3001');
    expect(() => normalizeApiUrl('not-a-url')).toThrow('valid URL');
    expect(() => normalizeApiUrl('ftp://localhost')).toThrow('http or https');
  });

  it('validates supported networks', () => {
    expect(validateNetwork('TESTNET')).toBe('testnet');
    expect(validateNetwork('mainnet')).toBe('mainnet');
    expect(() => validateNetwork('regtest')).toThrow();
  });

  it('validates API keys against the API with an x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(validateApiKey('http://localhost:3001/', 'key-123', fetchMock as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3001/wallets', {
      headers: { 'x-api-key': 'key-123' },
    });

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(validateApiKey('http://localhost:3001', 'bad-key', fetchMock as unknown as typeof fetch)).rejects.toThrow('401');
  });

  it('writes profile and vault files with 0600 permissions', async () => {
    const configDir = makeTempDir();
    dirs.push(configDir);

    const profile = await saveInitProfile(
      {
        name: 'local',
        apiUrl: 'http://localhost:3001/',
        network: 'testnet',
        apiKey: 'test-api-key',
      },
      'vault-password',
      configDir,
    );

    expect(profile.name).toBe('local');
    expect(profile.apiUrl).toBe('http://localhost:3001');
    expect(profile.network).toBe('testnet');

    const profilesPath = join(configDir, 'profiles.json');
    const vaultPath = join(configDir, 'vault.enc');
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(statSync(vaultPath).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(readFileSync(profilesPath, 'utf8')) as {
      activeProfile: string;
      profiles: Record<string, { name: string; hasSecrets: boolean }>;
    };
    expect(stored.activeProfile).toBe('local');
    expect(stored.profiles.local?.hasSecrets).toBe(true);
  });
});
