import { type NextRequest, NextResponse } from 'next/server';

// Import governance contract (same as proposals)
// In production, this would be a shared service
class MockGovernanceContract {
  private votes: { [proposalId: number]: { [voter: string]: { vote: boolean; power: number; timestamp: number } } } = {};

  async vote(proposalId: number, voter: string, vote: boolean): Promise<boolean> {
      // DAO governance is planned for approximately 2026 (manual activation required) - all voting blocked
  throw new Error('DAO governance is planned for approximately 2026. Voting is currently disabled.');
    
    // TODO: Uncomment below when DAO is activated in 2026
    // Complete implementation ready for activation:
    
    // // Validate proposal exists
    // if (!this.proposalExists(proposalId)) {
    //   throw new Error('Proposal not found');
    // }
    //
    // // Check if already voted
    // if (this.votes[proposalId]?.[voter]) {
    //   throw new Error('Already voted on this proposal');
    // }
    //
    // // Calculate voting power
    // const votingPower = await this.getVotingPower(voter);
    // if (votingPower === 0) {
    //   throw new Error('No voting power');
    // }
    //
    // // Record vote
    // if (!this.votes[proposalId]) {
    //   this.votes[proposalId] = {};
    // }
    //
    // this.votes[proposalId][voter] = {
    //   vote,
    //   power: votingPower,
    //   timestamp: Date.now()
    // };
    //
    // return true;
  }

  async getVotingPower(address: string): Promise<number> {
    const balance = await this.getQNCBalance(address);
    const holdingDays = await this.getHoldingDuration(address);
    const reputation = await this.getNodeReputation(address);

    // Time-weighted voting
    let timeWeight = 0.1; // 10% for new holders
    if (holdingDays >= 90) timeWeight = 1.0;      // 100% for 90+ days
    else if (holdingDays >= 30) timeWeight = 0.8; // 80% for 30+ days
    else if (holdingDays >= 7) timeWeight = 0.5;  // 50% for 7+ days

    // Reputation bonus
    let reputationBonus = 1.0;
    if (reputation >= 80) reputationBonus = 1.3;      // +30% for high reputation
    else if (reputation >= 60) reputationBonus = 1.2; // +20% for medium reputation

    const votingPower = Math.floor(balance * timeWeight * reputationBonus);

    // Maximum 5% of circulating supply
    const maxPower = Math.floor(2500000 * 0.05); // 125,000 QNC max
    return Math.min(votingPower, maxPower);
  }

  async getQNCBalance(address: string): Promise<number> {
    // Mock balances
    const mockBalances: { [key: string]: number } = {
      '0x1234567890123456789012345678901234567890': 100000,
      '0x2345678901234567890123456789012345678901': 50000,
      '0x3456789012345678901234567890123456789012': 25000
    };
    return mockBalances[address] || 0;
  }

  async getHoldingDuration(address: string): Promise<number> {
    // Mock holding duration in days
    const mockHolding: { [key: string]: number } = {
      '0x1234567890123456789012345678901234567890': 180,
      '0x2345678901234567890123456789012345678901': 120,
      '0x3456789012345678901234567890123456789012': 90
    };
    return mockHolding[address] || 0;
  }

  async getNodeReputation(address: string): Promise<number> {
    // Mock reputation scores (0-100)
    const mockReputation: { [key: string]: number } = {
      '0x1234567890123456789012345678901234567890': 95,
      '0x2345678901234567890123456789012345678901': 87,
      '0x3456789012345678901234567890123456789012': 92
    };
    return mockReputation[address] || 0;
  }

  private proposalExists(proposalId: number): boolean {
    // In production, this would check the actual proposals
    return proposalId > 0; // Simple validation for mock
  }

  async getVoteResults(proposalId: number): Promise<{ votesFor: number; votesAgainst: number; totalVotes: number }> {
    const proposalVotes = this.votes[proposalId] || {};
    
    let votesFor = 0;
    let votesAgainst = 0;
    
    for (const vote of Object.values(proposalVotes)) {
      if (vote.vote) {
        votesFor += vote.power;
      } else {
        votesAgainst += vote.power;
      }
    }
    
    return {
      votesFor,
      votesAgainst,
      totalVotes: votesFor + votesAgainst
    };
  }

  async hasVoted(proposalId: number, voter: string): Promise<boolean> {
    return !!(this.votes[proposalId]?.[voter]);
  }
}

// Global governance instance
const governance = new MockGovernanceContract();

// ---------------------------------------------------------------------------
// v14.5: HARD-DISABLE + CRYPTOGRAPHIC SIGNATURE CHECK
// ---------------------------------------------------------------------------
// Prior code accepted votes if the `signature` field was merely present —
// any non-empty string passed. When DAO is activated in 2026 that would let
// anyone vote on any proposal as any wallet. Two defenses:
//
// 1. Early 501 return: the endpoint is explicitly disabled until DAO launch,
//    so NO write path can execute even if upstream validation is bypassed.
// 2. verifyVoteSignature(): real Ed25519 (nacl) verification helper, ready
//    for activation. When DAO is enabled (DAO_ENABLED=1), remove the 501
//    guard and call this helper.
// ---------------------------------------------------------------------------
async function verifyVoteSignature(params: {
  walletAddress: string;
  proposalId: number;
  vote: boolean;
  signature: string;
}): Promise<boolean> {
  try {
    const { walletAddress, proposalId, vote, signature } = params;
    // Canonical vote payload — MUST match frontend signing format exactly.
    const message = `QNET_DAO_VOTE|proposal=${proposalId}|vote=${vote ? 'yes' : 'no'}|voter=${walletAddress}`;
    const nacl = await import('tweetnacl');
    const bs58 = await import('bs58');
    const publicKey = bs58.default.decode(walletAddress);
    // Accept hex or base58 signatures; strip 0x if present.
    let sigBytes: Uint8Array;
    const sigStr = signature.startsWith('0x') ? signature.slice(2) : signature;
    if (/^[0-9a-fA-F]+$/.test(sigStr) && sigStr.length === 128) {
      sigBytes = new Uint8Array(sigStr.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
    } else {
      sigBytes = bs58.default.decode(sigStr);
    }
    if (sigBytes.length !== 64 || publicKey.length !== 32) return false;
    const msgBytes = new TextEncoder().encode(message);
    return nacl.default.sign.detached.verify(msgBytes, sigBytes, publicKey);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  // v14.5: Hard-disable until DAO activation. Prevents any voting logic
  // (including the weak signature-presence check) from running.
  if (process.env.DAO_ENABLED !== '1') {
    return NextResponse.json(
      {
        success: false,
        error: 'DAO voting is not yet active. Scheduled for activation ~2026.',
      },
      { status: 501 }
    );
  }

  try {
    const body = await request.json();
    const { proposalId, vote, walletAddress, signature } = body;

    // Validate required fields
    if (proposalId === undefined || vote === undefined || !walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // v14.5: Cryptographic signature verification (Ed25519).
    // Replaces the previous presence-only check that accepted any string.
    if (!signature) {
      return NextResponse.json(
        { success: false, error: 'Signature required' },
        { status: 401 }
      );
    }
    const sigValid = await verifyVoteSignature({
      walletAddress,
      proposalId: Number(proposalId),
      vote: Boolean(vote),
      signature: String(signature),
    });
    if (!sigValid) {
      return NextResponse.json(
        { success: false, error: 'Invalid signature' },
        { status: 401 }
      );
    }

    // Check if already voted
    const hasVoted = await governance.hasVoted(proposalId, walletAddress);
    if (hasVoted) {
      return NextResponse.json(
        { success: false, error: 'Already voted on this proposal' },
        { status: 400 }
      );
    }

    // Get voting power
    const votingPower = await governance.getVotingPower(walletAddress);
    if (votingPower === 0) {
      return NextResponse.json(
        { success: false, error: 'No voting power' },
        { status: 400 }
      );
    }

    // Submit vote
    await governance.vote(proposalId, walletAddress, vote);

    // Get updated results
    const results = await governance.getVoteResults(proposalId);

    return NextResponse.json({
      success: true,
      votingPower,
      results
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to submit vote';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const proposalId = searchParams.get('proposalId');
    const walletAddress = searchParams.get('walletAddress');

    if (!proposalId) {
      return NextResponse.json(
        { success: false, error: 'Proposal ID required' },
        { status: 400 }
      );
    }

    const proposalIdNum = Number.parseInt(proposalId);
    const results = await governance.getVoteResults(proposalIdNum);

    let hasVoted = false;
    let votingPower = 0;

    if (walletAddress) {
      hasVoted = await governance.hasVoted(proposalIdNum, walletAddress);
      votingPower = await governance.getVotingPower(walletAddress);
    }

    return NextResponse.json({
      success: true,
      proposalId: proposalIdNum,
      results,
      hasVoted,
      votingPower
    });

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to get vote information' },
      { status: 500 }
    );
  }
} 
