import { Command } from 'commander';
import chalk from 'chalk';
import { promptSecret, promptSelect, promptText } from '../utils/prompts.js';
import type { SelectChoice } from '../utils/prompts.js';
import {
  normalizeApiUrl,
  saveInitProfile,
  validateApiKey,
  validateNetwork,
  type InitNetwork,
} from '../config/profiles.js';

const NETWORK_CHOICES: readonly SelectChoice<InitNetwork>[] = [
  { value: 'testnet', label: 'Testnet' },
  { value: 'mainnet', label: 'Mainnet' },
  { value: 'futurenet', label: 'Futurenet' },
];

const DEFAULT_API_URL = process.env.STELLAR_ALERTS_API_URL || 'http://localhost:3001';

export interface InitCommandOptions {
  apiUrl?: string;
  profile?: string;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Configure the CLI by choosing a network, API URL, and credentials')
    .option('-u, --api-url <url>', 'API base URL', DEFAULT_API_URL)
    .option('-p, --profile <name>', 'Profile name to create or update', 'default')
    .action(async (options: InitCommandOptions) => {
      try {
        const apiUrl = normalizeApiUrl(
          await promptText('API URL', {}, { defaultValue: options.apiUrl ?? DEFAULT_API_URL }),
        );
        const apiKey = await promptSecret('API key');
        await validateApiKey(apiUrl, apiKey);

        const network = await promptSelect('Select network', NETWORK_CHOICES);
        const profileName = await promptText('Profile name', {}, {
          defaultValue: options.profile ?? 'default',
        });
        const vaultPassword = await promptSecret('Vault password');

        validateNetwork(network);
        const profile = await saveInitProfile({
          name: profileName,
          apiUrl,
          network,
          apiKey,
        }, vaultPassword);

        console.log(chalk.green(`✅ Configuration profile '${profile.name}' saved and activated.`));
        console.log(`   API URL: ${profile.apiUrl}`);
        console.log(`   Network: ${profile.network}`);
      } catch (error) {
        console.error(chalk.red(`❌ ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });
}
