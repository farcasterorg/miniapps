/**
 * Codemod to update package imports from frame to miniapp packages
 */

const packageMappings = {
  '@farcaster/frame-sdk': '@farcasterorg/miniapp-sdk',
  '@farcaster/frame-core': '@farcasterorg/miniapp-core',
  '@farcaster/frame-host': '@farcasterorg/miniapp-host',
  '@farcaster/frame-node': '@farcasterorg/miniapp-node',
  '@farcaster/frame-wagmi-connector': '@farcasterorg/miniapp-wagmi-connector',
  '@farcaster/frame-host-react-native': '@farcasterorg/miniapp-host-react-native',
};

export default function transformer(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);
  let hasChanges = false;

  // Update import declarations
  root.find(j.ImportDeclaration).forEach((path) => {
    const importSource = path.node.source.value;
    
    if (packageMappings[importSource]) {
      path.node.source.value = packageMappings[importSource];
      hasChanges = true;
    }
  });

  // Update require calls
  root.find(j.CallExpression, {
    callee: { name: 'require' }
  }).forEach((path) => {
    const arg = path.node.arguments[0];
    if (arg && arg.type === 'Literal' && packageMappings[arg.value]) {
      arg.value = packageMappings[arg.value];
      hasChanges = true;
    }
  });

  // Update dynamic imports
  root.find(j.ImportExpression).forEach((path) => {
    const arg = path.node.source;
    if (arg && arg.type === 'Literal' && packageMappings[arg.value]) {
      arg.value = packageMappings[arg.value];
      hasChanges = true;
    }
  });

  return hasChanges ? root.toSource() : null;
}