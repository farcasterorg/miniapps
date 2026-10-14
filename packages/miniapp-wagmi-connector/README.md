# @farcasterorg/miniapp-wagmi-connector

A [Wagmi connector](https://wagmi.sh/) for interacting with wallets in Mini Apps.


## Installation

[Install and setup wagmi](https://wagmi.sh/react/getting-started#manual-installation).

```bash
pnpm add @farcasterorg/miniapp-wagmi-connector
```

## Usage

Connect to users wallet:

```
import { useConnect } from 'wagmi'
import { farcasterMiniApp } from "@farcasterorg/miniapp-wagmi-connector";

function App() {
  const { connect } = useConnect()

  return (
    <button onClick={() => connect({ connector: farcasterMiniApp() })}>
      Connect
    </button>
  )
}
```

You can now interact with the users connected wallet via Wagmi.
