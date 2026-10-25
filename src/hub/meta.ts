import { REQUIRED_CAPABILITIES, SUPPORTED_API_VERSION, type CloudMeta } from '../cloud/client.js';

/**
 * `GET /v1/meta` in the shape `fetchMeta` parses: the hub speaks the API
 * version and capability names of the client contract in `cloud/client.ts`,
 * and its `/mcp` serves exactly the five workflow tools.
 */

/** The workflow tools the hub serves over `/mcp`. */
export const HUB_MCP_TOOLS = [
  'start_work',
  'inspect_work',
  'update_work',
  'transfer_work',
  'finish_work',
] as const;

export function hubMeta(): CloudMeta {
  return {
    apiVersion: SUPPORTED_API_VERSION,
    capabilities: [...REQUIRED_CAPABILITIES],
    mcp: { endpoint: '/mcp', tools: [...HUB_MCP_TOOLS] },
  };
}
