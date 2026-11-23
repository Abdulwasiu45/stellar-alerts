# SEP-0010 Web Authentication

Wallet login uses the [SEP-0010](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
challenge/response flow ([`sep10.service.ts`](../apps/api/src/modules/auth/sep10.service.ts)).

```
GET  /auth/sep10/challenge?account=G...[&memo=123]   -> { transaction, networkPassphrase }
POST /auth/sep10/verify   { transaction }            -> { token, accessToken, refreshToken, user }
```

`publicKey` is accepted as an alias of `account`. Request and response contracts live in
[`packages/shared/src/schemas/auth.ts`](../packages/shared/src/schemas/auth.ts).

## Challenge

A server-signed transaction with:

- sequence number `0`, source = the server account, time bounds of 5 minutes (never more than 15)
- op 1: `manageData` sourced from the client, key `<home domain> auth`, value = a 64-byte random nonce
- op 2: `manageData` sourced from the server, key `web_auth_domain`
- optional `MEMO_ID` for shared / custodial accounts

## Verification

1. Structure: sequence `0`, server source, valid time bounds, exactly the two operations above,
   64-byte nonce, `web_auth_domain` equal to ours, memo (if any) is `MEMO_ID`.
2. The server's signature is present. Signatures are over the network-specific hash, so a challenge
   built for another network passphrase fails here.
3. The client's signatures are weighed against the account's **on-chain signers**:
   - every non-server signature must belong to a signer of the account (otherwise rejected),
   - signers with weight `0` do not count — a master key that was set to weight 0 cannot log in,
   - the combined weight must reach the account's **medium threshold**,
   - an unfunded account (Horizon 404) can only be authenticated by its own master key.
   If the signers cannot be loaded (Horizon outage) verification **fails closed**.
4. **Replay protection:** the challenge hash is consumed with Redis `SET NX EX` once the signatures
   are valid, so each challenge logs in exactly once. If Redis cannot confirm, login is refused
   outside development / test.
5. The wallet's user is found or created and a session is issued by the same issuer as the other
   login methods (rotating refresh tokens with reuse detection).

## Errors

| Status | Code                               | Meaning |
| ------ | ---------------------------------- | ------- |
| 400    | `VALIDATION_ERROR` / `INVALID_ACCOUNT` | Bad query or body |
| 401    | `INVALID_SEP10_CHALLENGE`          | Malformed, expired, wrong server/network, or bad signature |
| 401    | `SEP10_INSUFFICIENT_SIGNER_WEIGHT` | Signatures are valid but below the medium threshold |
| 401    | `SEP10_CHALLENGE_REPLAYED`         | The challenge was already redeemed |
| 503    | `SIGNER_LOOKUP_FAILED` / `REPLAY_STORE_UNAVAILABLE` | Horizon or Redis unavailable |

## Configuration

| Variable                   | Default                  | Purpose |
| -------------------------- | ------------------------ | ------- |
| `STELLAR_SERVER_SECRET`    | derived from `JWT_SECRET` | Server signing key. **Set this in production** — the derived fallback is for development only |
| `SEP10_HOME_DOMAIN`        | `stellar-alerts.org`     | Domain in the `<domain> auth` key |
| `SEP10_WEB_AUTH_DOMAIN`    | the home domain          | Value of `web_auth_domain` |
| `STELLAR_NETWORK_PASSPHRASE` | testnet                | Network the challenges are valid on |
