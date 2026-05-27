# Webhook Signature Verification

YieldVault signs webhook payloads using HMAC-SHA256 when an endpoint is configured with a secret.

## Outgoing Delivery Signature

For each delivery, the backend computes:

`signature = HMAC_SHA256(secret, JSON.stringify(envelope))`

Where `envelope` is the exact JSON body sent to the consumer:

- `eventType`
- `sentAt`
- `payload`

The signature is sent in the `X-YieldVault-Signature` header as lowercase hex.

If no secret is configured for an endpoint, the signature header is omitted.

## Consumer Verification Steps

1. Read the raw request body as a string.
2. Compute `HMAC-SHA256(secret, rawBody)`.
3. Hex-encode the result.
4. Compare with `X-YieldVault-Signature` using a constant-time compare.

## Test Endpoint

Use `POST /webhooks/verify` to verify your secret/signature wiring before production.

Request body:

```json
{
  "secret": "your-shared-secret",
  "payload": { "eventType": "transaction.deposit.created", "sentAt": "...", "payload": {} },
  "signature": "hex-signature"
}
```

Response:

```json
{
  "valid": true,
  "algorithm": "HMAC-SHA256",
  "encoding": "hex"
}
```
