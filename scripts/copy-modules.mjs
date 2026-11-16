import { cp, mkdir } from 'node:fs/promises';
await mkdir('packages/core/dist/modules', { recursive: true });
await cp('modules', 'packages/core/dist/modules', { recursive: true });
