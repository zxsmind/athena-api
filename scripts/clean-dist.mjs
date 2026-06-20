#!/usr/bin/env node
import { rmSync, existsSync } from 'fs';
const target = process.argv[2];
if (target && existsSync(target)) rmSync(target, { recursive: true, force: true });
