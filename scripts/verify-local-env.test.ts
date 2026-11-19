import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(__dirname, 'verify-local-env.sh');

describe('verify-local-env.sh', () => {
  it('displays usage and exits with 0 on --help', async () => {
    const { stdout } = await execFileAsync(scriptPath, ['--help']);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--timeout=SECONDS');
    expect(stdout).toContain('--skip-migrations');
  });

  it('fails gracefully with timeout safeguard when target containers are stopped or nonexistent', async () => {
    try {
      await execFileAsync(scriptPath, ['--timeout=1', '--skip-migrations'], {
        env: {
          ...process.env,
          POSTGRES_CONTAINER: 'non_existent_test_postgres',
          REDIS_CONTAINER: 'non_existent_test_redis',
        },
      });
      expect.unreachable('Should have timed out and failed');
    } catch (err: any) {
      expect(err.code).toBe(1);
      const output = err.stdout + (err.stderr || '');
      expect(output).toContain('Health Probe');
      expect(output).toMatch(/(timed out|ERROR|PostgreSQL)/);
    }
  });

  it('supports custom timeout flag', async () => {
    const start = Date.now();
    try {
      await execFileAsync(scriptPath, ['--timeout=1', '--skip-migrations'], {
        env: {
          ...process.env,
          POSTGRES_CONTAINER: 'non_existent_test_postgres',
        },
      });
    } catch (err: any) {
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(4000); // 1s timeout should terminate quickly
      expect(err.code).toBe(1);
    }
  });
});
