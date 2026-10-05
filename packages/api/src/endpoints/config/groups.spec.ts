import { FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { createEndpointGroupsResolver } from './groups';

describe('account-scoped routing groups', () => {
  const config: AppConfig = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      custom: [
        {
          name: 'ZhiFlo',
          baseURL: 'https://api.example/v1',
          apiKey: '',
          models: { default: ['static-fallback'], fetch: true },
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
          modelGroups: { path: 'zhiflo/groups', header: 'X-ZhiFlo-Group', timeoutMs: 5000 },
        },
      ],
    },
  };

  const userRequest = (id: string, token: string) =>
    ({
      user: {
        id,
        provider: 'openid',
        federatedTokens: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 600 },
      },
    }) as unknown as ServerRequest;

  it('isolates groups, credentials and model fallbacks when switching accounts', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ success: true, data: { auto: {}, premium: {} } })
      .mockResolvedValueOnce({ success: true, data: { default: {} } });
    const resolve = createEndpointGroupsResolver({ request });
    const first = await resolve(userRequest('a', 'token-a'), config);
    const second = await resolve(userRequest('b', 'token-b'), config);
    expect(first.endpoints?.custom?.map((e) => e.name)).toEqual(['ZhiFlo', 'ZhiFlo / premium']);
    expect(second.endpoints?.custom?.map((e) => e.name)).toEqual(['ZhiFlo / default']);
    expect(first.endpoints?.custom?.[1].headers?.['X-ZhiFlo-Group']).toBe('premium');
    expect(first.endpoints?.custom?.[1].models?.default).toEqual([]);
    expect(request.mock.calls[0][0]).toMatchObject({
      url: 'https://api.example/v1/zhiflo/groups',
      headers: { Authorization: 'Bearer token-a' },
    });
    expect(request.mock.calls[1][0].headers.Authorization).toBe('Bearer token-b');
    expect(config.endpoints?.custom?.[0].models?.default).toEqual(['static-fallback']);
    expect(config.endpoints?.custom).toHaveLength(1);
  });

  it('fails closed on failed discovery rather than showing static models', async () => {
    const resolve = createEndpointGroupsResolver({
      request: jest.fn().mockResolvedValue({ success: false }),
    });
    await expect(resolve(userRequest('a', 'token-a'), config)).rejects.toThrow(
      'Invalid routing-group response',
    );
  });

  it('encodes Unicode group names for HTTP headers', async () => {
    const resolve = createEndpointGroupsResolver({
      request: jest.fn().mockResolvedValue({ success: true, data: { 公益分组: {} } }),
    });
    const result = await resolve(userRequest('a', 'token-a'), config);
    expect(result.endpoints?.custom?.[0].name).toBe('ZhiFlo / 公益分组');
    expect(result.endpoints?.custom?.[0].headers?.['X-ZhiFlo-Group']).toBe(
      encodeURIComponent('公益分组'),
    );
  });
});
