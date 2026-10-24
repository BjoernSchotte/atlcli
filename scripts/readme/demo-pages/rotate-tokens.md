Rotate the API tokens of every CI profile every 90 days.

## Steps

1. Create a new token at *Account settings → Security → API tokens*.
2. Update the CI secret, then run `atlcli doctor --profile ci`.
3. Revoke the old token once the next pipeline run is green.

:::warning
Never paste a token into a page, an issue or a chat. Use the CI secret store.
:::

## Verify

```bash
atlcli doctor --profile ci --json | jq '.checks[] | select(.status != "ok")'
```
