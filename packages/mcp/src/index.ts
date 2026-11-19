#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { operations, type Operation } from '@siftable/contracts';
import { SiftClient } from '@siftable/client';
import { formatToolError, formatToolResultText, toolAnnotations } from './format.js';
const config = process.env.SIFT_CONFIG;
if (!config) throw new Error('SIFT_CONFIG must name a protected credential file');
const client = await SiftClient.fromFile(config);
const profile = process.env.SIFT_TOOLS?.split(',');
const visible = async () =>
  (await client.catalog()).filter((x) => !profile || profile.includes(x.module));
const server = new Server(
  { name: 'siftable', version: '0.1.0' },
  {
    capabilities: { tools: { listChanged: false } },
    instructions:
      'Local context, project and work management. Mutations require a stable requestKey. Retry the same request with the same key after a lost response. Work claims are stored in local credential custody. Evidence is a submitter claim, not independent verification.',
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (await visible()).map((t) => {
    const name = t.name as Operation;
    const op = operations[name];
    const schema = z.toJSONSchema(op.input, { io: 'input' }) as {
      properties: Record<string, unknown>;
      required?: string[];
      type: 'object';
    };
    delete schema.properties.claimSecret;
    delete schema.properties.epoch;
    schema.required = (schema.required ?? []).filter((x) => !['claimSecret', 'epoch'].includes(x));
    if (op.write) {
      schema.properties.requestKey = { type: 'string', minLength: 1, maxLength: 128 };
      schema.required.push('requestKey');
    }
    return {
      name: t.name.replaceAll('.', '_'),
      description: `${t.name}. ${op.write ? 'Writes durable state.' : 'Reads state.'}${op.operator ? ' Operator credential required.' : ''}`,
      inputSchema: schema,
      annotations: toolAnnotations(name),
    };
  }),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const found = (await visible()).find(
      (t) => t.name.replaceAll('.', '_') === request.params.name,
    );
    if (!found) throw new Error('Tool is unavailable for this module profile or credential');
    const operation = found.name as Operation;
    const { requestKey, ...args } = request.params.arguments ?? {};
    const data = await client.invoke(
      operation,
      args,
      typeof requestKey === 'string' ? requestKey : undefined,
    );
    return {
      content: [{ type: 'text', text: formatToolResultText(operation, data) }],
      structuredContent: { data },
    };
  } catch (e) {
    return formatToolError(e);
  }
});
await server.connect(new StdioServerTransport());
