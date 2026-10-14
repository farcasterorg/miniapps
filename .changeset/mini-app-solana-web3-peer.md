---
'@farcasterorg/mini-app-solana': minor
---

Declare `@solana/web3.js` (`^1.98.2`) as an explicit peer dependency. Previously it was only pulled in incidentally via the Solana wallet-adapter ecosystem and via `@farcasterorg/miniapp-core`'s (now optional) dependency. Making it explicit ensures the peer is present now that `@farcasterorg/miniapp-core` no longer forces `@solana/web3.js` into the tree.
