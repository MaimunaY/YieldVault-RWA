type RpcMethod = 'getLatestLedger' | 'getEvents';

interface RpcRequest {
  method: RpcMethod;
  params?: any;
}

type RpcHandler = (request: RpcRequest) => Promise<any>;

export function createStellarRpcFetchMock(handler: RpcHandler): jest.Mock {
  return jest.fn(async (_url: string, options: any) => {
    const body = JSON.parse(options.body || '{}');
    const payload = await handler({ method: body.method, params: body.params });
    return {
      json: async () => payload,
    };
  });
}