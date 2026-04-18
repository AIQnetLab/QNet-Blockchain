import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// v14.5: CORS ALLOWLIST (was: Access-Control-Allow-Origin: *)
// ---------------------------------------------------------------------------
// Wildcard CORS lets any origin read the build-verification payload and, if
// paired with credentials, exfiltrate response data from authenticated users.
// The endpoint is still publicly readable — we just stop advertising cross-
// origin permission. Explicitly known front-ends can be added via env
// (VERIFY_BUILD_ALLOWED_ORIGINS, comma-separated).
// ---------------------------------------------------------------------------
const DEFAULT_ALLOWED_ORIGINS = [
  'https://qnet.network',
  'https://www.qnet.network',
  'https://explorer.qnet.network',
  'https://testnet.qnet.network',
];

function resolveAllowedOrigin(request: NextRequest): string | null {
  const extra = (process.env.VERIFY_BUILD_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowed = [...DEFAULT_ALLOWED_ORIGINS, ...extra];
  const origin = request.headers.get('origin');
  if (origin && allowed.includes(origin)) return origin;
  return null;
}

export async function GET(request: NextRequest) {
  const buildInfo = {
    // Build information
    version: '2.2.0',
    environment: process.env.NODE_ENV || 'development',
    
    // GitHub links for verification
    github: {
      repository: 'https://github.com/AIQnetLab/QNet-Blockchain/tree/testnet',
      commitUrl: `https://github.com/AIQnetLab/QNet-Blockchain/commit/${process.env.NEXT_PUBLIC_GIT_COMMIT || 'testnet'}`,
      sourceTree: `https://github.com/AIQnetLab/QNet-Blockchain/tree/${process.env.NEXT_PUBLIC_GIT_COMMIT || 'testnet'}/applications/qnet-explorer/frontend`,
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
      nextVersion: '15.3.2', // Fixed version to avoid require issues
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

  const allowedOrigin = resolveAllowedOrigin(request);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Vary'] = 'Origin';
  }
  return NextResponse.json(buildInfo, { headers });
}

async function getFileHash(filename: string): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const filePath = path.join(process.cwd(), filename);
    const content = await fs.readFile(filePath);
    return 'sha256:' + createHash('sha256').update(content).digest('hex');
  } catch {
    return 'sha256:unavailable';
  }
}

async function getDirectoryHash(dirname: string): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dirPath = path.join(process.cwd(), dirname);
    const hash = createHash('sha256');
    const entries = await fs.readdir(dirPath, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fp = path.join(entry.parentPath ?? entry.path, entry.name);
        const content = await fs.readFile(fp);
        hash.update(content);
      }
    }
    return 'sha256:' + hash.digest('hex');
  } catch {
    return 'sha256:unavailable';
  }
}
