// Deprecation warning
if (typeof console !== 'undefined' && console.warn) {
  console.warn(
    '@farcasterorg/frame-host-react-native is deprecated. Please use @farcasterorg/miniapp-host-react-native instead.',
  )
}

// Re-export everything from miniapp-host-react-native
export * from '@farcasterorg/miniapp-host-react-native'
