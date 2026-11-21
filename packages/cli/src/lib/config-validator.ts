import {
  isValidProfileName,
  ProfileConfig,
  ProfileError,
  ProfilesFile,
} from './profile-types.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failValidation(filePath: string, detail: string): never {
  throw new ProfileError(
    'CONFIG_READ_ERROR',
    `Invalid profiles configuration in ${filePath}: ${detail}`,
  );
}

function validateProfileEntry(
  key: string,
  entry: unknown,
  filePath: string,
): ProfileConfig {
  if (FORBIDDEN_KEYS.has(key) || !isValidProfileName(key)) {
    failValidation(filePath, `invalid profile key '${key}'.`);
  }
  if (!isPlainRecord(entry)) {
    failValidation(filePath, `profile '${key}' must be an object.`);
  }
  if (typeof entry.name !== 'string' || !isValidProfileName(entry.name)) {
    failValidation(filePath, `profile '${key}' has an invalid 'name'.`);
  }
  if (typeof entry.apiUrl !== 'string' || entry.apiUrl.length === 0) {
    failValidation(filePath, `profile '${key}' must have a non-empty string 'apiUrl'.`);
  }
  if (entry.network !== undefined && typeof entry.network !== 'string') {
    failValidation(filePath, `profile '${key}' field 'network' must be a string.`);
  }
  if (
    entry.logLevel !== undefined &&
    (typeof entry.logLevel !== 'string' || !VALID_LOG_LEVELS.has(entry.logLevel))
  ) {
    failValidation(
      filePath,
      `profile '${key}' field 'logLevel' must be debug, info, warn, or error.`,
    );
  }
  if (typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string') {
    failValidation(filePath, `profile '${key}' must include ISO timestamp strings.`);
  }
  if (typeof entry.hasSecrets !== 'boolean') {
    failValidation(filePath, `profile '${key}' must have a boolean 'hasSecrets' flag.`);
  }

  return entry as unknown as ProfileConfig;
}

/**
 * Validates parsed `profiles.json` content against the CLI profile configuration schema.
 * Throws `ProfileError('CONFIG_READ_ERROR')` when any required field or type is invalid.
 */
export function validateProfilesFile(parsed: unknown, filePath: string): ProfilesFile {
  if (!isPlainRecord(parsed)) {
    failValidation(filePath, 'root value must be a JSON object.');
  }
  if (parsed.version !== 1) {
    failValidation(filePath, 'unsupported or missing config version (expected 1).');
  }
  if (parsed.activeProfile !== null && typeof parsed.activeProfile !== 'string') {
    failValidation(filePath, "'activeProfile' must be a string or null.");
  }
  if (!isPlainRecord(parsed.profiles)) {
    failValidation(filePath, "'profiles' must be an object map.");
  }

  for (const [key, entry] of Object.entries(parsed.profiles)) {
    validateProfileEntry(key, entry, filePath);
  }

  return parsed as unknown as ProfilesFile;
}
