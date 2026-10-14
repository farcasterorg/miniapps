// Deprecation warning
if (typeof console !== 'undefined' && console.warn) {
  console.warn(
    '@farcasterorg/frame-node is deprecated. Please use @farcasterorg/miniapp-node instead.',
  )
}

// Re-export everything from miniapp-node
export * from '@farcasterorg/miniapp-node'
