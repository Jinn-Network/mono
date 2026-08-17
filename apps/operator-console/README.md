# Operator console

Local v1 human surface for a running Jinn operator daemon. Talks to
`http://127.0.0.1:7331` with `x-jinn-ui-token`. Never sends cookies.

```bash
cd apps/operator-console
yarn install
yarn dev
```

Set `JINN_OPERATOR_URL` / `NEXT_PUBLIC_JINN_OPERATOR_URL` to point at a
non-default daemon bind. Set `NEXT_PUBLIC_JINN_UI_TOKEN` or paste the token
on Security. Rotate with `jinn auth rotate`.
