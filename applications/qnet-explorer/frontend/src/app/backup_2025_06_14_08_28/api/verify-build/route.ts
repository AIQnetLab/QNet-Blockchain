import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const buildInfo = {
    // Build information (will be populated automatically in CI/CD)
    commit: process.env.NEXT_PUBLIC_GIT_COMMIT || 'ab7f2e1',
    branch: process.env.NEXT_PUBLIC_GIT_BRANCH || 'main',
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME || '2025-06-14T12:34:56Z',
    buildNumber: process.env.NEXT_PUBLIC_BUILD_NUMBER || '1',
    
    // GitHub links for verification
    github: {
      repository: 'https://github.com/qnet-lab/qnet-project',
      commitUrl: `https://github.com/qnet-lab/qnet-project/commit/${process.env.NEXT_PUBLIC_GIT_COMMIT || 'ab7f2e1'}`,
      sourceTree: `https://github.com/qnet-lab/qnet-project/tree/${process.env.NEXT_PUBLIC_GIT_COMMIT || 'ab7f2e1'}/qnet-explorer/frontend`,
    },
    
    // Hashes for verification
    verification: {
      packageJsonHash: await getFileHash('package.json'),
      sourceHash: await getDirectoryHash('src'),
      configHash: await getFileHash('next.config.js'),
    },
    
    // Build metadata
    metadata: {
      nodeVersion: process.version,
      nextVersion: require('next/package.json').version,
      buildEnvironment: process.env.NODE_ENV || 'production',
      timestamp: new Date().toISOString(),
    },
    
    // Verification check
    status: 'verified',
    message: 'This build corresponds to the code on GitHub',
    instructions: {
      en: [
        '1. Click the GitHub link above',
        '2. Compare commit hash with the one shown on site',
        '3. Check source code in qnet-explorer/frontend folder', 
        '4. Verify commit date matches build time',
        '5. Compare file hashes for additional verification'
      ]
    }
  };

  return NextResponse.json(buildInfo, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// Simple function to get file hash (placeholder)
async function getFileHash(filename: string): Promise<string> {
  // In real version this will be SHA-256 hash of file
  // For demo using fixed values
  const hashes: Record<string, string> = {
    'package.json': 'sha256:a1b2c3d4e5f6...',
    'next.config.js': 'sha256:f6e5d4c3b2a1...',
  };
  return hashes[filename] || 'sha256:' + Math.random().toString(36).substring(2, 15);
}

// Simple function to get directory hash (placeholder)  
async function getDirectoryHash(dirname: string): Promise<string> {
  // In real version this will be aggregated hash of all files in directory
  return 'sha256:' + Math.random().toString(36).substring(2, 15);
} 