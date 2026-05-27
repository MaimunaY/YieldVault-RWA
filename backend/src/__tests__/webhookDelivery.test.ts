import request from 'supertest';
import app from '../index';
import {
  registerWebhookEndpoint,
  emitTransactionEvent,
  resetWebhookState,
  listWebhookEndpoints,
  computeWebhookSignature,
} from '../webhookDelivery';

describe('webhook delivery signatures', () => {
  beforeEach(() => {
    resetWebhookState();
    (global.fetch as unknown as jest.Mock) = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  });

  it('attaches X-YieldVault-Signature when endpoint has a secret', async () => {
    registerWebhookEndpoint({
      url: 'https://example.com/webhook',
      secret: 'top-secret',
      eventTypes: ['transaction.deposit.created'],
    });

    await emitTransactionEvent('transaction.deposit.created', {
      transactionId: 'tx-1',
      amount: '100.00',
      asset: 'USDC',
      walletAddress: 'GABC',
      transactionHash: 'hash-1',
      status: 'completed',
      timestamp: new Date().toISOString(),
    });

    expect(global.fetch).toHaveBeenCalled();
    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    const body = options.body as string;
    const signature = options.headers['X-YieldVault-Signature'];

    expect(signature).toBe(computeWebhookSignature('top-secret', body));
  });

  it('omits signature header when endpoint has no secret', async () => {
    registerWebhookEndpoint({
      url: 'https://example.com/webhook',
      eventTypes: ['transaction.deposit.created'],
    });

    await emitTransactionEvent('transaction.deposit.created', {
      transactionId: 'tx-2',
      amount: '50.00',
      asset: 'USDC',
      walletAddress: 'GDEF',
      transactionHash: 'hash-2',
      status: 'completed',
      timestamp: new Date().toISOString(),
    });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0];
    expect(options.headers['X-YieldVault-Signature']).toBeUndefined();
  });

  it('does not expose secret in endpoint listings', () => {
    registerWebhookEndpoint({
      url: 'https://example.com/webhook',
      secret: 'hidden-secret',
      eventTypes: ['transaction.deposit.created'],
    });

    const endpoints = listWebhookEndpoints();
    expect(endpoints[0].hasSecret).toBe(true);
    expect((endpoints[0] as any).secret).toBeUndefined();
  });

  it('verifies signatures with /webhooks/verify endpoint', async () => {
    const payload = {
      eventType: 'transaction.deposit.created',
      sentAt: new Date().toISOString(),
      payload: { transactionId: 'tx-verify' },
    };

    const signature = computeWebhookSignature('verify-secret', JSON.stringify(payload));

    const response = await request(app).post('/webhooks/verify').send({
      secret: 'verify-secret',
      payload,
      signature,
    });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
  });
});
