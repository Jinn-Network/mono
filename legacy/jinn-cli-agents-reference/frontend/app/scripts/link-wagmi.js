#!/usr/bin/env node
// Symlink wagmi and viem to RainbowKit's bundled copies so there's a single
// module instance (single React context). Without this, monorepo hoisting
// creates duplicate copies that break WagmiProvider context sharing.
const fs = require('fs');
const path = require('path');

const appModules = path.resolve(__dirname, '..', 'node_modules');

// Find RainbowKit's wagmi
let rkWagmi;
try {
  rkWagmi = path.dirname(require.resolve('wagmi/package.json', {
    paths: [require.resolve('@rainbow-me/rainbowkit')]
  }));
} catch {
  console.log('link-wagmi: @rainbow-me/rainbowkit not found, skipping');
  process.exit(0);
}

// Find RainbowKit's viem (through its wagmi)
let rkViem;
try {
  rkViem = path.dirname(require.resolve('viem/package.json', {
    paths: [rkWagmi]
  }));
} catch {
  console.log('link-wagmi: viem not found in RainbowKit tree, skipping');
  process.exit(0);
}

const links = [
  [path.join(appModules, 'wagmi'), rkWagmi],
  [path.join(appModules, 'viem'), rkViem],
];

for (const [linkPath, target] of links) {
  const rel = path.relative(path.dirname(linkPath), target);
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      // Already a symlink — check if it points to the right place
      const existing = fs.readlinkSync(linkPath);
      if (existing === rel) continue;
      fs.unlinkSync(linkPath);
    } else {
      fs.rmSync(linkPath, { recursive: true });
    }
  } catch {
    // doesn't exist, that's fine
  }
  fs.symlinkSync(rel, linkPath);
  console.log(`link-wagmi: ${path.basename(linkPath)} → ${rel}`);
}
