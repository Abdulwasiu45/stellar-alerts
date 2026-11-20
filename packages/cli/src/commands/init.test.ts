import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const prompts = vi.hoisted(() => ({
  promptText: vi.fn(),
  promptSelect: vi.fn(),
  promptSecret: vi.fn(),
}));

const config = vi.hoisted(() => ({
  normalizeApiUrl: vi.fn((value: string) => value),
  validateApiKey: vi.fn(),
  validateNetwork: vi.fn(),
  saveInitProfile: vi.fn(),
}));

vi.mock('../utils/prompts.js', () => prompts);
vi.mock('../config/profiles.js', () => config);

import { registerInitCommand } from './init.js';

describe('stellar-alerts init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('collects configuration, validates the API key, and saves a profile', async () => {
    prompts.promptText
      .mockResolvedValueOnce('http://localhost:3001')
      .mockResolvedValueOnce('local');
    prompts.promptSelect.mockResolvedValueOnce('testnet');
    prompts.promptSecret
      .mockResolvedValueOnce('test-api-key')
      .mockResolvedValueOnce('vault-password');
    config.validateApiKey.mockResolvedValueOnce(undefined);
    config.saveInitProfile.mockResolvedValueOnce({
      name: 'local',
      apiUrl: 'http://localhost:3001',
      network: 'testnet',
      hasSecrets: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const program = new Command();
    program.exitOverride();
    registerInitCommand(program);

    await program.parseAsync(['node', 'cli', 'init']);

    expect(config.validateApiKey).toHaveBeenCalledWith('http://localhost:3001', 'test-api-key');
    expect(config.saveInitProfile).toHaveBeenCalledWith(
      {
        name: 'local',
        apiUrl: 'http://localhost:3001',
        network: 'testnet',
        apiKey: 'test-api-key',
      },
      'vault-password',
    );
    expect(process.exitCode).toBe(0);
  });

  it('reports validation failures without saving a profile', async () => {
    prompts.promptText.mockResolvedValueOnce('http://localhost:3001');
    prompts.promptSecret.mockResolvedValueOnce('bad-key');
    config.validateApiKey.mockRejectedValueOnce(new Error('API key validation failed (401)'));

    const program = new Command();
    program.exitOverride();
    registerInitCommand(program);

    await program.parseAsync(['node', 'cli', 'init']);

    expect(config.saveInitProfile).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
