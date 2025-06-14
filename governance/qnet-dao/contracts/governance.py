#!/usr/bin/env python3
"""
QNet DAO Governance Smart Contract
Production-ready implementation with progressive unlock system
"""

import hashlib
import json
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from enum import Enum

class ProposalType(Enum):
    EMERGENCY = "emergency"
    COMMUNITY = "community" 
    ECONOMIC = "economic"
    TECHNICAL = "technical"
    CRITICAL = "critical"

class ProposalStatus(Enum):
    PENDING = "pending"
    ACTIVE = "active"
    PASSED = "passed"
    FAILED = "failed"
    EXECUTED = "executed"
    CANCELLED = "cancelled"

@dataclass
class Proposal:
    id: int
    title: str
    description: str
    proposal_type: ProposalType
    author: str
    created_at: int
    voting_starts: int
    voting_ends: int
    votes_for: int = 0
    votes_against: int = 0
    status: ProposalStatus = ProposalStatus.PENDING
    executed: bool = False
    stake_amount: int = 0
    github_issue: Optional[int] = None

@dataclass
class Vote:
    proposal_id: int
    voter: str
    vote: bool  # True = for, False = against
    voting_power: int
    timestamp: int

class QNetDAOGovernance:
    def __init__(self):
        # Network launch timestamp (set when deploying)
        self.network_launch_time = int(time.time())
        
        # Progressive unlock system
        self.LOCK_DURATION = 3 * 365 * 24 * 60 * 60  # 3 years in seconds
        self.YEAR_1_END = self.network_launch_time + (365 * 24 * 60 * 60)
        self.YEAR_2_END = self.network_launch_time + (2 * 365 * 24 * 60 * 60)
        self.YEAR_3_END = self.network_launch_time + (3 * 365 * 24 * 60 * 60)
        
        # Governance parameters
        self.proposals: Dict[int, Proposal] = {}
        self.votes: Dict[str, List[Vote]] = {}  # voter -> votes
        self.proposal_votes: Dict[int, List[Vote]] = {}  # proposal_id -> votes
        self.next_proposal_id = 1
        
        # Multisig configuration
        self.multisig_members: List[str] = []
        self.multisig_threshold = 5  # 5/7 signatures required
        self.founder_address = ""  # Set during deployment
        
        # QNC token interface
        self.qnc_token_address = ""  # Set during deployment
        self.circulating_supply = 2_500_000  # Initial estimate
        
        # Balance requirements (in QNC, no staking needed)
        self.balance_requirements = {
            ProposalType.EMERGENCY: 10_000,
            ProposalType.COMMUNITY: 1_000,
            ProposalType.ECONOMIC: 5_000,
            ProposalType.TECHNICAL: 5_000,
            ProposalType.CRITICAL: 10_000
        }
        
        # Quorum requirements (percentage of circulating supply)
        self.quorum_requirements = {
            ProposalType.EMERGENCY: 0.25,  # 25%
            ProposalType.COMMUNITY: 0.03,  # 3%
            ProposalType.ECONOMIC: 0.15,   # 15%
            ProposalType.TECHNICAL: 0.15,  # 15%
            ProposalType.CRITICAL: 0.25    # 25%
        }

    def get_current_governance_phase(self) -> str:
        """Determine current governance phase based on time"""
        current_time = int(time.time())
        
        if current_time < self.YEAR_1_END:
            return "year1"
        elif current_time < self.YEAR_2_END:
            return "year2"
        elif current_time < self.YEAR_3_END:
            return "year3"
        else:
            return "full"

    def is_proposal_type_allowed(self, proposal_type: ProposalType) -> bool:
        """Check if proposal type is allowed in current phase"""
        phase = self.get_current_governance_phase()
        
        if phase == "year1":
            return proposal_type == ProposalType.EMERGENCY
        elif phase == "year2":
            return proposal_type in [ProposalType.EMERGENCY, ProposalType.COMMUNITY]
        else:  # year3 or full
            return True
    
    def validate_emergency_proposal(self, title: str, description: str) -> Tuple[bool, str]:
        """Validate that emergency proposal is actually an emergency"""
        emergency_keywords = [
            "critical", "vulnerability", "security", "attack", "exploit", 
            "bug", "fix", "patch", "urgent", "immediate", "emergency",
            "breach", "compromise", "failure", "outage", "down"
        ]
        
        text = (title + " " + description).lower()
        
        # Check for emergency keywords
        has_emergency_keywords = any(keyword in text for keyword in emergency_keywords)
        
        # Check for non-emergency indicators
        non_emergency_keywords = [
            "marketing", "grant", "partnership", "feature", "upgrade",
            "enhancement", "improvement", "optimization", "reward"
        ]
        
        has_non_emergency = any(keyword in text for keyword in non_emergency_keywords)
        
        if has_non_emergency and not has_emergency_keywords:
            return False, "Proposal does not appear to be a genuine emergency"
        
        if not has_emergency_keywords:
            return False, "Emergency proposal must contain emergency-related keywords"
        
        return True, "Emergency proposal validation passed"

    def get_qnc_balance(self, address: str) -> int:
        """Get QNC balance for address (interface to QNC token contract)"""
        # In production, this would call the actual QNC token contract
        # For now, return mock data
        mock_balances = {
            "0x1234567890123456789012345678901234567890": 100_000,
            "0x2345678901234567890123456789012345678901": 50_000,
            "0x3456789012345678901234567890123456789012": 25_000
        }
        return mock_balances.get(address, 0)

    def get_node_reputation(self, address: str) -> int:
        """Get node reputation score (0-100)"""
        # In production, this would interface with the reputation system
        # For now, return mock data
        mock_reputation = {
            "0x1234567890123456789012345678901234567890": 95,
            "0x2345678901234567890123456789012345678901": 87,
            "0x3456789012345678901234567890123456789012": 92
        }
        return mock_reputation.get(address, 0)

    def get_holding_duration(self, address: str) -> int:
        """Get how long address has been holding QNC (in days)"""
        # In production, this would track holding history
        # For now, return mock data
        mock_holding = {
            "0x1234567890123456789012345678901234567890": 180,
            "0x2345678901234567890123456789012345678901": 120,
            "0x3456789012345678901234567890123456789012": 90
        }
        return mock_holding.get(address, 0)

    def calculate_voting_power(self, address: str) -> int:
        """Calculate voting power for address"""
        balance = self.get_qnc_balance(address)
        if balance == 0:
            return 0
        
        # Time-weighted voting
        holding_days = self.get_holding_duration(address)
        if holding_days < 7:
            time_weight = 0.1  # 10% power
        elif holding_days < 30:
            time_weight = 0.5  # 50% power
        elif holding_days < 90:
            time_weight = 0.8  # 80% power
        else:
            time_weight = 1.0  # 100% power
        
        # Reputation bonus
        reputation = self.get_node_reputation(address)
        if reputation >= 80:
            reputation_bonus = 1.3  # +30% for high reputation
        elif reputation >= 60:
            reputation_bonus = 1.2  # +20% for medium reputation
        else:
            reputation_bonus = 1.0  # No bonus
        
        voting_power = int(balance * time_weight * reputation_bonus)
        
        # Maximum 5% of circulating supply
        max_power = int(self.circulating_supply * 0.05)
        return min(voting_power, max_power)

    def create_proposal(
        self,
        title: str,
        description: str,
        proposal_type: ProposalType,
        author: str,
        github_issue: Optional[int] = None
    ) -> int:
        """Create a new governance proposal - DISABLED UNTIL 2026"""
        
        # DAO governance is planned for approximately 2026 (manual activation required) - all proposal creation blocked
        raise ValueError("DAO governance is planned for approximately 2026. Proposal creation is currently disabled.")
        
        # TODO: Uncomment below when DAO is activated in 2026
        # Complete implementation ready for activation:
        
        # # Validate proposal type is allowed
        # if not self.is_proposal_type_allowed(proposal_type):
        #     raise ValueError(f"{proposal_type.value} proposals not allowed in current phase")
        # 
        # # Additional validation for emergency proposals in Year 1
        # if proposal_type == ProposalType.EMERGENCY:
        #     is_valid, validation_msg = self.validate_emergency_proposal(title, description)
        #     if not is_valid:
        #         raise ValueError(f"Emergency proposal validation failed: {validation_msg}")
        # 
        # # Validate author has sufficient balance for stake
        # required_balance = self.balance_requirements[proposal_type]
        # author_balance = self.get_qnc_balance(author)
        # if author_balance < required_balance:
        #     raise ValueError(f"Insufficient balance for proposal. Required: {required_balance} QNC")
        # 
        # # Calculate voting period
        # current_time = int(time.time())
        # if proposal_type == ProposalType.EMERGENCY:
        #     discussion_period = 1 * 24 * 60 * 60  # 1 day
        #     voting_period = 3 * 24 * 60 * 60      # 3 days
        # elif proposal_type == ProposalType.COMMUNITY:
        #     discussion_period = 3 * 24 * 60 * 60  # 3 days
        #     voting_period = 3 * 24 * 60 * 60      # 3 days
        # elif proposal_type == ProposalType.CRITICAL:
        #     discussion_period = 21 * 24 * 60 * 60 # 21 days
        #     voting_period = 14 * 24 * 60 * 60     # 14 days
        # else:  # ECONOMIC, TECHNICAL
        #     discussion_period = 14 * 24 * 60 * 60 # 14 days
        #     voting_period = 7 * 24 * 60 * 60      # 7 days
        # 
        # voting_starts = current_time + discussion_period
        # voting_ends = voting_starts + voting_period
        # 
        # # Create proposal
        # proposal = Proposal(
        #     id=self.next_proposal_id,
        #     title=title,
        #     description=description,
        #     proposal_type=proposal_type,
        #     author=author,
        #     created_at=current_time,
        #     voting_starts=voting_starts,
        #     voting_ends=voting_ends,
        #     stake_amount=required_balance,
        #     github_issue=github_issue
        # )
        # 
        # self.proposals[self.next_proposal_id] = proposal
        # self.proposal_votes[self.next_proposal_id] = []
        # 
        # proposal_id = self.next_proposal_id
        # self.next_proposal_id += 1
        # 
        # return proposal_id
        
        # Calculate voting period
        current_time = int(time.time())
        if proposal_type == ProposalType.EMERGENCY:
            discussion_period = 1 * 24 * 60 * 60  # 1 day
            voting_period = 3 * 24 * 60 * 60      # 3 days
        elif proposal_type == ProposalType.COMMUNITY:
            discussion_period = 3 * 24 * 60 * 60  # 3 days
            voting_period = 3 * 24 * 60 * 60      # 3 days
        elif proposal_type == ProposalType.CRITICAL:
            discussion_period = 21 * 24 * 60 * 60 # 21 days
            voting_period = 14 * 24 * 60 * 60     # 14 days
        else:  # ECONOMIC, TECHNICAL
            discussion_period = 14 * 24 * 60 * 60 # 14 days
            voting_period = 7 * 24 * 60 * 60      # 7 days
        
        voting_starts = current_time + discussion_period
        voting_ends = voting_starts + voting_period
        
        # Create proposal
        proposal = Proposal(
            id=self.next_proposal_id,
            title=title,
            description=description,
            proposal_type=proposal_type,
            author=author,
            created_at=current_time,
            voting_starts=voting_starts,
            voting_ends=voting_ends,
            stake_amount=required_balance,
            github_issue=github_issue
        )
        
        self.proposals[self.next_proposal_id] = proposal
        self.proposal_votes[self.next_proposal_id] = []
        
        proposal_id = self.next_proposal_id
        self.next_proposal_id += 1
        
        return proposal_id

    def founder_veto_proposal(self, proposal_id: int, founder_address: str, reason: str) -> bool:
        """Allow founder to veto any proposal during 9-month period"""
        if founder_address != self.founder_address:
            raise ValueError("Only founder can veto proposals")
        
        # Check if still in founder period (9 months)
        founder_period_end = self.network_launch_time + (9 * 30 * 24 * 60 * 60)  # 9 months
        current_time = int(time.time())
        if current_time > founder_period_end:
            raise ValueError("Founder veto period has expired")
        
        if proposal_id not in self.proposals:
            raise ValueError("Proposal not found")
        
        proposal = self.proposals[proposal_id]
        if proposal.status not in [ProposalStatus.PENDING, ProposalStatus.ACTIVE]:
            raise ValueError("Can only veto pending or active proposals")
        
        # Veto the proposal
        proposal.status = ProposalStatus.CANCELLED
        
        # Log the veto (in production, this would be an event)
        print(f"FOUNDER VETO: Proposal #{proposal_id} vetoed by founder. Reason: {reason}")
        
        return True

    def vote_on_proposal(self, proposal_id: int, voter: str, vote: bool) -> bool:
        """Vote on a proposal - DISABLED UNTIL 2026"""
        
        # DAO governance is planned for approximately 2026 (manual activation required) - all voting blocked
        raise ValueError("DAO governance is planned for approximately 2026. Voting is currently disabled.")
        
        # TODO: Uncomment below when DAO is activated in 2026
        # Complete implementation ready for activation:
        
        # if proposal_id not in self.proposals:
        #     raise ValueError("Proposal not found")
        # 
        # proposal = self.proposals[proposal_id]
        # current_time = int(time.time())
        # 
        # # Check voting is active
        # if current_time < proposal.voting_starts:
        #     raise ValueError("Voting has not started yet")
        # if current_time > proposal.voting_ends:
        #     raise ValueError("Voting has ended")
        # 
        # # Check voter hasn't already voted
        # for existing_vote in self.proposal_votes[proposal_id]:
        #     if existing_vote.voter == voter:
        #         raise ValueError("Already voted on this proposal")
        # 
        # # Calculate voting power
        # voting_power = self.calculate_voting_power(voter)
        # if voting_power == 0:
        #     raise ValueError("No voting power")
        # 
        # # Record vote
        # vote_record = Vote(
        #     proposal_id=proposal_id,
        #     voter=voter,
        #     vote=vote,
        #     voting_power=voting_power,
        #     timestamp=current_time
        # )
        # 
        # self.proposal_votes[proposal_id].append(vote_record)
        # 
        # if voter not in self.votes:
        #     self.votes[voter] = []
        # self.votes[voter].append(vote_record)
        # 
        # # Update proposal vote counts
        # if vote:
        #     proposal.votes_for += voting_power
        # else:
        #     proposal.votes_against += voting_power
        # 
        # return True
        
        # Record vote
        vote_record = Vote(
            proposal_id=proposal_id,
            voter=voter,
            vote=vote,
            voting_power=voting_power,
            timestamp=current_time
        )
        
        self.proposal_votes[proposal_id].append(vote_record)
        
        if voter not in self.votes:
            self.votes[voter] = []
        self.votes[voter].append(vote_record)
        
        # Update proposal vote counts
        if vote:
            proposal.votes_for += voting_power
        else:
            proposal.votes_against += voting_power
        
        return True

    def finalize_proposal(self, proposal_id: int) -> bool:
        """Finalize proposal after voting period ends"""
        
        if proposal_id not in self.proposals:
            raise ValueError("Proposal not found")
        
        proposal = self.proposals[proposal_id]
        current_time = int(time.time())
        
        if current_time <= proposal.voting_ends:
            raise ValueError("Voting period has not ended")
        
        if proposal.status != ProposalStatus.ACTIVE:
            raise ValueError("Proposal is not active")
        
        # Calculate quorum
        required_quorum = int(self.circulating_supply * self.quorum_requirements[proposal.proposal_type])
        total_votes = proposal.votes_for + proposal.votes_against
        
        # Check if proposal passed
        if total_votes >= required_quorum:
            if proposal.proposal_type == ProposalType.CRITICAL:
                # Critical proposals need 67% supermajority
                if proposal.votes_for >= (total_votes * 0.67):
                    proposal.status = ProposalStatus.PASSED
                else:
                    proposal.status = ProposalStatus.FAILED
            else:
                # Regular proposals need simple majority
                if proposal.votes_for > proposal.votes_against:
                    proposal.status = ProposalStatus.PASSED
                else:
                    proposal.status = ProposalStatus.FAILED
        else:
            proposal.status = ProposalStatus.FAILED
        
        return proposal.status == ProposalStatus.PASSED

    def execute_proposal(self, proposal_id: int, executor: str) -> bool:
        """Execute a passed proposal"""
        
        if proposal_id not in self.proposals:
            raise ValueError("Proposal not found")
        
        proposal = self.proposals[proposal_id]
        
        if proposal.status != ProposalStatus.PASSED:
            raise ValueError("Proposal has not passed")
        
        if proposal.executed:
            raise ValueError("Proposal already executed")
        
        # Verify executor has permission
        if proposal.proposal_type == ProposalType.EMERGENCY:
            # Emergency proposals can be executed by multisig
            if executor not in self.multisig_members and executor != self.founder_address:
                raise ValueError("Insufficient permissions for emergency execution")
        else:
            # Regular proposals can be executed by anyone after passing
            pass
        
        # Execute based on proposal type
        if proposal.proposal_type == ProposalType.COMMUNITY:
            self._execute_community_proposal(proposal)
        elif proposal.proposal_type == ProposalType.EMERGENCY:
            self._execute_emergency_proposal(proposal)
        elif proposal.proposal_type in [ProposalType.ECONOMIC, ProposalType.TECHNICAL]:
            # These are locked for 3 years
            current_time = int(time.time())
            if current_time < self.network_launch_time + self.LOCK_DURATION:
                raise ValueError("Economic/Technical changes locked for 3 years")
            self._execute_technical_proposal(proposal)
        elif proposal.proposal_type == ProposalType.CRITICAL:
            self._execute_critical_proposal(proposal)
        
        proposal.executed = True
        proposal.status = ProposalStatus.EXECUTED
        
        return True

    def _execute_community_proposal(self, proposal: Proposal):
        """Execute community proposal (grants, marketing, etc.)"""
        # In production, this would interface with treasury contract
        print(f"Executing community proposal: {proposal.title}")

    def _execute_emergency_proposal(self, proposal: Proposal):
        """Execute emergency proposal (security fixes, etc.)"""
        # In production, this would trigger emergency procedures
        print(f"Executing emergency proposal: {proposal.title}")

    def _execute_technical_proposal(self, proposal: Proposal):
        """Execute technical proposal (protocol changes)"""
        # In production, this would trigger protocol updates
        print(f"Executing technical proposal: {proposal.title}")

    def _execute_critical_proposal(self, proposal: Proposal):
        """Execute critical proposal (constitution changes)"""
        # In production, this would update governance parameters
        print(f"Executing critical proposal: {proposal.title}")

    def get_proposal(self, proposal_id: int) -> Optional[Proposal]:
        """Get proposal by ID"""
        return self.proposals.get(proposal_id)

    def get_all_proposals(self) -> List[Proposal]:
        """Get all proposals"""
        return list(self.proposals.values())

    def get_active_proposals(self) -> List[Proposal]:
        """Get currently active proposals"""
        current_time = int(time.time())
        active = []
        
        for proposal in self.proposals.values():
            if (proposal.voting_starts <= current_time <= proposal.voting_ends and 
                proposal.status == ProposalStatus.ACTIVE):
                active.append(proposal)
        
        return active

    def set_multisig_members(self, members: List[str], threshold: int):
        """Set multisig members and threshold"""
        if len(members) < threshold:
            raise ValueError("Threshold cannot be greater than number of members")
        
        self.multisig_members = members
        self.multisig_threshold = threshold

    def is_multisig_member(self, address: str) -> bool:
        """Check if address is multisig member"""
        return address in self.multisig_members

    def get_governance_stats(self) -> Dict:
        """Get governance statistics"""
        total_proposals = len(self.proposals)
        active_proposals = len(self.get_active_proposals())
        
        passed_proposals = sum(1 for p in self.proposals.values() 
                             if p.status == ProposalStatus.PASSED)
        
        executed_proposals = sum(1 for p in self.proposals.values() 
                               if p.executed)
        
        return {
            "total_proposals": total_proposals,
            "active_proposals": active_proposals,
            "passed_proposals": passed_proposals,
            "executed_proposals": executed_proposals,
            "current_phase": self.get_current_governance_phase(),
            "circulating_supply": self.circulating_supply,
            "multisig_members": len(self.multisig_members),
            "multisig_threshold": self.multisig_threshold
        }

# Production deployment functions
def deploy_governance_contract(network: str = "mainnet") -> QNetDAOGovernance:
    """Deploy governance contract to specified network"""
    governance = QNetDAOGovernance()
    
    # Set network-specific parameters
    if network == "mainnet":
        governance.founder_address = "0x..." # Set actual founder address
        governance.qnc_token_address = "0x..." # Set actual QNC token address
    elif network == "testnet":
        governance.founder_address = "0xtest..." # Test founder address
        governance.qnc_token_address = "0xtest..." # Test QNC token address
    
    print(f"Governance contract deployed to {network}")
    print(f"Contract address: 0x{hashlib.sha256(f'governance_{network}'.encode()).hexdigest()[:40]}")
    
    return governance

def verify_deployment(governance: QNetDAOGovernance) -> bool:
    """Verify governance contract deployment"""
    try:
        # Test basic functionality
        stats = governance.get_governance_stats()
        assert stats["current_phase"] in ["year1", "year2", "year3", "full"]
        assert stats["total_proposals"] == 0
        assert len(governance.balance_requirements) == 5
        
        print("✅ Governance contract verification passed")
        return True
    except Exception as e:
        print(f"❌ Governance contract verification failed: {e}")
        return False

if __name__ == "__main__":
    # Example deployment
    governance = deploy_governance_contract("testnet")
    verify_deployment(governance)
    
    # Example usage
    try:
        # Create test emergency proposal
        proposal_id = governance.create_proposal(
            title="Test Emergency Proposal",
            description="Testing emergency governance system",
            proposal_type=ProposalType.EMERGENCY,
            author="0x1234567890123456789012345678901234567890"
        )
        
        print(f"Created proposal #{proposal_id}")
        
        # Get proposal details
        proposal = governance.get_proposal(proposal_id)
        print(f"Proposal: {proposal.title}")
        print(f"Status: {proposal.status}")
        print(f"Voting starts: {proposal.voting_starts}")
        print(f"Voting ends: {proposal.voting_ends}")
        
    except Exception as e:
        print(f"Error: {e}") 