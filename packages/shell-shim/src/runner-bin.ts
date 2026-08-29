#!/usr/bin/env node
import { main } from './runner.js';

process.exitCode = await main(process.argv.slice(2));
