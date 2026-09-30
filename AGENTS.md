# Project architecture

- Bundle the Solana SDK with the `node` package-export condition because the server runtime enables Node compatibility and `rpc-websockets` has no default export condition.