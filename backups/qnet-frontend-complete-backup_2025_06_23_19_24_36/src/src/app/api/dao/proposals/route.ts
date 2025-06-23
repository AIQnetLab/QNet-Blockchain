import { type NextRequest, NextResponse } from 'next/server';

// Production DAO integration
interface GovernanceContract {
  getProposals(): Promise<Proposal[]>;
  createProposal(data: ProposalData): Promise<number>;
  getCurrentPhase(): Promise<string>;
  getVotingPower(address: string): Promise<number>;
  getQNCBalance(address: string): Promise<number>;
}

interface Proposal {
  id: number;
  title: string;
  description: string;
  type: string;
  status: string;
  author: string;
  created: string;
  votingStarts: string;
  votingEnds: string;
  votesFor: number;
  votesAgainst: number;
  quorumRequired: number;
  balanceRequired: number;
  githubIssue?: number;
}

interface ProposalData {
  title: string;
  description: string;
  type: string;
  author: string;
  githubIssue?: number;
}

// Mock governance contract for development
// In production, this would connect to actual blockchain
class MockGovernanceContract implements GovernanceContract {
  private proposals: Proposal[] = [];
  private nextId = 1;

  async getProposals(): Promise<Proposal[]> {
    return this.proposals;
  }

  async createProposal(data: ProposalData): Promise<number> {
    // DAO governance is planned for approximately 2026 (manual activation required) - all proposal creation blocked
    throw new Error('DAO governance is planned for approximately 2026. Proposal creation is currently disabled.');
    
    // TODO: Uncomment below when DAO is activated in 2026
    // Complete implementation ready for activation:
    
    // const currentPhase = await this.getCurrentPhase();
    // 
    // // Validate proposal type based on current phase
    // if (currentPhase === 'year1' && data.type !== 'emergency') {
    //   throw new Error('Only emergency proposals allowed in Year 1');
    // }
    // 
    // const balanceRequired = this.getBalanceRequirement(data.type);
    // const quorumRequired = this.getQuorumRequirement(data.type);
    // 
    // const proposal: Proposal = {
    //   id: this.nextId++,
    //   title: data.title,
    //   description: data.description,
    //   type: data.type,
    //   status: 'pending',
    //   author: data.author,
    //   created: new Date().toISOString(),
    //   votingStarts: new Date(Date.now() + this.getDiscussionPeriod(data.type)).toISOString(),
    //   votingEnds: new Date(Date.now() + this.getDiscussionPeriod(data.type) + this.getVotingPeriod(data.type)).toISOString(),
    //   votesFor: 0,
    //   votesAgainst: 0,
    //   quorumRequired,
    //   balanceRequired,
    //   githubIssue: data.githubIssue
    // };
    // 
    // this.proposals.push(proposal);
    // return proposal.id;
  }

  async getCurrentPhase(): Promise<string> {
    // In production, this would check actual network launch time
    return 'year1'; // Currently in Year 1 - emergency only
  }

  async getVotingPower(address: string): Promise<number> {
    const balance = await this.getQNCBalance(address);
    // Simplified voting power calculation
    return Math.min(balance, 125000); // Max 5% of 2.5M supply
  }

  async getQNCBalance(address: string): Promise<number> {
    // TODO: In production, integrate with actual QNC token contract
    // This should call the same balance system used by hybrid contracts
    try {
      // Integration point with existing QNet balance system
      const response = await fetch(`/api/v1/balances/${address}`);
      if (response.ok) {
        const data = await response.json();
        return data.qnc_balance || 0;
      }
    } catch (error) {
      console.error('Failed to fetch QNC balance:', error);
    }
    
    // Fallback to mock for development
    const mockBalances: { [key: string]: number } = {
      '0x1234567890123456789012345678901234567890': 100000,
      '0x2345678901234567890123456789012345678901': 50000,
      '0x3456789012345678901234567890123456789012': 25000
    };
    return mockBalances[address] || 0;
  }

  private getBalanceRequirement(type: string): number {
    const requirements: { [key: string]: number } = {
      'emergency': 10000,
      'community': 1000,
      'economic': 5000,
      'technical': 5000,
      'critical': 10000
    };
    return requirements[type] || 1000;
  }

  private getQuorumRequirement(type: string): number {
    const circulatingSupply = 2500000; // 2.5M QNC
    const percentages: { [key: string]: number } = {
      'emergency': 0.25,  // 25%
      'community': 0.03,  // 3%
      'economic': 0.15,   // 15%
      'technical': 0.15,  // 15%
      'critical': 0.25    // 25%
    };
    return Math.floor(circulatingSupply * (percentages[type] || 0.03));
  }

  private getDiscussionPeriod(type: string): number {
    const periods: { [key: string]: number } = {
      'emergency': 1 * 24 * 60 * 60 * 1000,  // 1 day
      'community': 3 * 24 * 60 * 60 * 1000,  // 3 days
      'economic': 14 * 24 * 60 * 60 * 1000,  // 14 days
      'technical': 14 * 24 * 60 * 60 * 1000, // 14 days
      'critical': 21 * 24 * 60 * 60 * 1000   // 21 days
    };
    return periods[type] || 3 * 24 * 60 * 60 * 1000;
  }

  private getVotingPeriod(type: string): number {
    const periods: { [key: string]: number } = {
      'emergency': 3 * 24 * 60 * 60 * 1000,  // 3 days
      'community': 3 * 24 * 60 * 60 * 1000,  // 3 days
      'economic': 7 * 24 * 60 * 60 * 1000,   // 7 days
      'technical': 7 * 24 * 60 * 60 * 1000,  // 7 days
      'critical': 14 * 24 * 60 * 60 * 1000   // 14 days
    };
    return periods[type] || 3 * 24 * 60 * 60 * 1000;
  }
}

// Global governance contract instance
const governance = new MockGovernanceContract();

export async function GET(request: NextRequest) {
  try {
    // Get proposals from governance contract
    const proposals = await governance.getProposals();
    
    return NextResponse.json({
      success: true,
      proposals: proposals,
      totalCount: proposals.length,
      currentPhase: await governance.getCurrentPhase()
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to fetch proposals' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { title, description, type, walletAddress } = body;

    // Validate required fields
    if (!title || !description || !type || !walletAddress) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Create proposal through governance contract
    const proposalId = await governance.createProposal({
      title,
      description,
      type,
      author: walletAddress,
      githubIssue: body.githubIssue
    });

    // Get the created proposal
    const proposals = await governance.getProposals();
    const newProposal = proposals.find(p => p.id === proposalId);

    return NextResponse.json({
      success: true,
      proposal: newProposal
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Failed to create proposal' },
      { status: 500 }
    );
  }
}

 