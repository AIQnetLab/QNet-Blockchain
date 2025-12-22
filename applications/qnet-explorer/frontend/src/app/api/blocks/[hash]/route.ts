import { NextRequest, NextResponse } from 'next/server';
import type { Block } from '@/lib/types';

// QNet Backend API URL
const QNET_API_URL = process.env.QNET_API_URL || 'http://localhost:8000';

// Get block from QNet backend
async function fetchBlockFromBackend(hash: string): Promise<Block | null> {
  try {
    const response = await fetch(`${QNET_API_URL}/api/v1/block/${hash}`, {
      headers: { 'Content-Type': 'application/json' },
      next: { revalidate: 10 },
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.data || data;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;
  
  if (!hash || hash.length < 10) {
    return NextResponse.json(
      { success: false, error: 'Invalid block hash' },
      { status: 400 }
    );
  }
  
  // Fetch from backend only
  const block = await fetchBlockFromBackend(hash);
  
  if (!block) {
    return NextResponse.json({
      success: false,
      error: 'Block not found or backend unavailable',
    }, { status: 404 });
  }
  
  return NextResponse.json({
    success: true,
    data: block,
  });
}

