import { REQUIRED_CAPABILITIES, SUPPORTED_API_VERSION, type CloudMeta } from '../cloud/client.js';
import { PUBLIC_WORKFLOW_TOOLS } from '../tools/workflow.js';

/**
 * `GET /v1/meta` in the shape `fetchMeta` parses: the hub speaks the API
 * version and capability names of the client contract in `cloud/client.ts`,
 * and its `/mcp` serves exactly the five workflow tools.
 */

/** The workflow tools the hub serves over `/mcp`, as the local server registers them. */
export const HUB_MCP_TOOLS: readonly string[] = PUBLIC_WORKFLOW_TOOLS;

export function hubMeta(): CloudMeta {
  return {
    apiVersion: SUPPORTED_API_VERSION,
    capabilities: [...REQUIRED_CAPABILITIES],
    mcp: { endpoint: '/mcp', tools: [...HUB_MCP_TOOLS] },
  };
}
