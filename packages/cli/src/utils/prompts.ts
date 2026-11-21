import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface PromptIO {
  input?: Readable;
  output?: Writable;
}

export interface TextPromptOptions {
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}

async function ask(message: string, io: PromptIO = {}): Promise<string> {
  const rl = createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
    terminal: false,
  });

  return new Promise<string>((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptText(
  message: string,
  io: PromptIO = {},
  options: TextPromptOptions = {},
): Promise<string> {
  while (true) {
    const answer = await ask(message, io);
    const value = answer.length === 0 ? (options.defaultValue ?? '') : answer;
    const error = options.validate?.(value);

    if (error) {
      (io.output ?? process.stdout).write(`${error}\n`);
      continue;
    }

    return value;
  }
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
}

export async function promptSelect<T extends string>(
  message: string,
  choices: readonly SelectChoice<T>[],
  io: PromptIO = {},
): Promise<T> {
  if (choices.length === 0) throw new Error('At least one choice is required');

  (io.output ?? process.stdout).write(`${message}\n`);
  choices.forEach((choice, index) => {
    (io.output ?? process.stdout).write(`  ${index + 1}) ${choice.label}\n`);
  });

  while (true) {
    const answer = await ask('Select 1-' + choices.length + ': ', io);
    const byNumber = Number(answer);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length) {
      return choices[byNumber - 1]!.value;
    }

    const byValue = choices.find((choice) => choice.value === answer.toLowerCase());
    if (byValue) return byValue.value;

    (io.output ?? process.stdout).write('Invalid selection.\n');
  }
}

export async function promptSecret(message: string, io: PromptIO = {}): Promise<string> {
  return ask(`${message}: `, io);
}

export async function promptConfirm(
  message: string,
  io: PromptIO = {},
  defaultValue = false,
): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = await ask(`${message} (${hint}): `, io);
  if (answer.length === 0) return defaultValue;
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}
