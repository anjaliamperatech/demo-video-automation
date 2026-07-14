#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './lib/env.mjs';
import { interpolateValue } from './lib/interpolate.mjs';
import { ensureDir, readJson, slugify, timestampForFolder } from './lib/fs-utils.mjs';
import { validateStory } from './lib/validate.mjs';
import { createLogger } from './lib/logger.mjs';

function parseArgs(argv) {
  const args = {
    headed: false,
    validateOnly: false,
    story: null,
    output: './output'
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case '--story':
        args.story = argv[index + 1];
        index += 1;
        break;
      case '--output':
        args.output = argv[index + 1];
        index += 1;
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--validate-only':
        args.validateOnly = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Unknown flag: ${token}`);
        }
    }
  }

  return args;
}

function printHelp() {
  console.log(`\nPlaywright Demo Video POC\n\nUsage:\n  node ./src/cli.mjs --story ./stories/customer-onboarding.json [--output ./output] [--headed] [--validate-only]\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.story) {
    throw new Error('Missing required --story argument.');
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  loadDotEnv(projectRoot);

  const storyPath = path.resolve(process.cwd(), args.story);
  const rawStory = readJson(storyPath);
  const story = interpolateValue(rawStory);
  const errors = validateStory(args.validateOnly ? rawStory : story);

  if (errors.length) {
    throw new Error(`Story validation failed:\n- ${errors.join('\n- ')}`);
  }

  if (args.validateOnly) {
    console.log('Story is valid.');
    return;
  }

  const runFolder = `${slugify(story.title)}-${timestampForFolder()}`;
  const outputDir = ensureDir(path.resolve(process.cwd(), args.output, runFolder));
  const logger = createLogger(path.join(outputDir, 'run.log'));

  try {
    const { runDemo } = await import('./demo-runner.mjs');
    const manifest = await runDemo({
      story,
      storyPath,
      outputDir,
      headed: args.headed,
      logger
    });

    console.log(`\nDone. Final video: ${manifest.files.finalVideo}`);
  } finally {
    logger.close();
  }
}

main().catch(error => {
  console.error(`\nDemo generation failed: ${error.message}`);
  process.exitCode = 1;
});
