import { extractEnvVariable } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { resolveConfigSecret } from '~/admin/secrets';
import { resolveHeaders } from '~/utils/env';

export interface GroupDiscoveryRequest {
  url: string;
  headers: Record<string, string>;
  timeout: number;
}

/** The provider returns { success: true, data: { groupName: { desc, ratio } } }. */
export function createEndpointGroupsResolver(deps: {
  request: (options: GroupDiscoveryRequest) => Promise<unknown>;
}): (req: ServerRequest, config: AppConfig) => Promise<AppConfig> {
  return async function resolveEndpointGroups(
    req: ServerRequest,
    config: AppConfig,
  ): Promise<AppConfig> {
    const endpoints = config.endpoints?.custom;
    if (!endpoints?.some((endpoint) => endpoint.modelGroups)) {
      return config;
    }
    if (!req.user?.id) {
      throw new Error('Group discovery requires an authenticated account');
    }
    const expanded = await Promise.all(
      endpoints.map(async (endpoint) => {
        const discovery = endpoint.modelGroups;
        if (!discovery) {
          return [endpoint];
        }
        if (!endpoint.baseURL) {
          throw new Error('Group discovery requires an administrator-configured URL');
        }
        const baseURL = extractEnvVariable(endpoint.baseURL);
        if (baseURL === 'user_provided') {
          throw new Error('Group discovery requires an administrator-configured URL');
        }
        const url = new URL(discovery.path, `${baseURL.replace(/\/$/, '')}/`);
        const headers = resolveHeaders({ headers: endpoint.headers, user: req.user });
        const apiKey = resolveConfigSecret(endpoint.apiKey);
        if (!headers.Authorization && !headers.authorization && apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }
        let response: { success?: boolean; data?: Record<string, unknown> };
        try {
          response = (await deps.request({
            url: url.toString(),
            headers,
            timeout: discovery.timeoutMs,
          })) as typeof response;
        } catch {
          // HTTP errors can carry credential-bearing request headers.
          throw new Error(`Routing-group discovery failed for ${endpoint.name}`);
        }
        if (
          response?.success !== true ||
          !response.data ||
          typeof response.data !== 'object' ||
          Array.isArray(response.data)
        ) {
          throw new Error(`Invalid routing-group response for ${endpoint.name}`);
        }
        // Build request-owned config. Never add one user's groups to the shared
        // role/tenant config, and never retain a static model fallback here.
        return Object.keys(response.data)
          .sort((a, b) => {
            if (a === 'auto') return -1;
            if (b === 'auto') return 1;
            return a.localeCompare(b);
          })
          .map((group) => ({
            ...endpoint,
            name: group === 'auto' ? endpoint.name : `${endpoint.name} / ${group}`,
            modelGroups: undefined,
            models: { ...endpoint.models, default: [], fetch: true },
            headers: { ...endpoint.headers, [discovery.header]: encodeURIComponent(group) },
          }));
      }),
    );
    return {
      ...config,
      endpoints: { ...config.endpoints, custom: expanded.flat() },
    };
  };
}
