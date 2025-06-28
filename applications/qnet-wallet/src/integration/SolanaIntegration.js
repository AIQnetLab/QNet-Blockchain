/**
 * Solana Integration for QNet Wallet
 * Handles 1DEV token burning and activation bridge communication
 */

import { 
    Connection, 
    PublicKey, 
    Transaction, 
    Keypair,
    SystemProgram,
    LAMPORTS_PER_SOL
} from '@solana/web3.js';

import {
    getOrCreateAssociatedTokenAccount,
    createBurnInstruction,
    TOKEN_PROGRAM_ID,
    getAccount
} from '@solana/spl-token';

export class SolanaIntegration {
    constructor(networkManager) {
        this.networkManager = networkManager;
        this.connection = null;
        this.oneDevMint = new PublicKey('9GcdXAo2EyjNdNLuQoScSVbfJSnh9RdkSS8YYKnGQ8Pf');
        this.burnContractProgram = new PublicKey('QNETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    }

    /**
     * Initialize Solana integration
     */
    async initialize() {
        this.connection = this.networkManager.getSolanaConnection();
        if (!this.connection) {
            throw new Error('Solana connection not available');
        }
    }

    /**
     * Get SOL balance
     */
    async getSOLBalance(publicKey) {
        try {
            const balance = await this.connection.getBalance(new PublicKey(publicKey));
            return balance / LAMPORTS_PER_SOL;
        } catch (error) {
            console.error('Failed to get SOL balance:', error);
            return 0;
        }
    }

    /**
     * Get 1DEV token balance
     */
    async getOneDevBalance(publicKey) {
        try {
            const tokenAccounts = await this.connection.getTokenAccountsByOwner(
                new PublicKey(publicKey),
                { mint: this.oneDevMint }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            const accountInfo = await this.connection.getTokenAccountBalance(
                tokenAccounts.value[0].pubkey
            );

            return accountInfo.value.uiAmount || 0;
        } catch (error) {
            console.error('Failed to get 1DEV balance:', error);
            return 0;
        }
    }

    /**
     * Burn 1DEV tokens for node activation
     */
    async burnOneDevForActivation(keypair, nodeType, amount) {
        try {
            // Get or create associated token account
            const tokenAccount = await getOrCreateAssociatedTokenAccount(
                this.connection,
                keypair,
                this.oneDevMint,
                keypair.publicKey
            );

            // Verify sufficient balance
            const accountInfo = await getAccount(this.connection, tokenAccount.address);
            const balance = Number(accountInfo.amount) / Math.pow(10, 6); // 1DEV has 6 decimals

            if (balance < amount) {
                throw new Error(`Insufficient 1DEV balance. Required: ${amount}, Available: ${balance}`);
            }

            // Calculate burn amount in smallest units
            const burnAmount = Math.floor(amount * Math.pow(10, 6));

            // Create burn instruction
            const burnInstruction = createBurnInstruction(
                tokenAccount.address,
                this.oneDevMint,
                keypair.publicKey,
                burnAmount,
                [],
                TOKEN_PROGRAM_ID
            );

            // Create transaction
            const transaction = new Transaction().add(burnInstruction);
            
            // Get recent blockhash
            const { blockhash } = await this.connection.getRecentBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = keypair.publicKey;

            // Sign and send transaction
            transaction.sign(keypair);
            const signature = await this.connection.sendTransaction(transaction, [keypair]);

            // Wait for confirmation
            await this.connection.confirmTransaction(signature, 'confirmed');

            console.log(`Burned ${amount} 1DEV tokens. Signature: ${signature}`);

            return {
                success: true,
                signature,
                amount,
                nodeType,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('Failed to burn 1DEV tokens:', error);
            throw error;
        }
    }

    /**
     * Call burn contract for node activation
     */
    async burnOneDevForNodeActivation(keypair, nodeType, amount, qnetNodePubkey) {
        try {
            // First burn the tokens
            const burnResult = await this.burnOneDevForActivation(keypair, nodeType, amount);

            // Then call the smart contract to register the burn
            const contractResult = await this.callBurnContract(
                keypair,
                nodeType,
                amount,
                burnResult.signature,
                qnetNodePubkey
            );

            return {
                ...burnResult,
                contractCall: contractResult
            };

        } catch (error) {
            console.error('Failed to execute burn contract call:', error);
            throw error;
        }
    }

    /**
     * Call Solana burn contract
     */
    async callBurnContract(keypair, nodeType, amount, burnTxSignature, qnetNodePubkey) {
        try {
            // This would call the actual Solana smart contract
            // For now, we'll simulate the contract call
            
            const contractData = {
                nodeType,
                amount: Math.floor(amount * Math.pow(10, 6)),
                burnTxSignature,
                qnetNodePubkey,
                timestamp: Date.now()
            };

            console.log('Contract call data:', contractData);

            // In production, this would be a real program instruction
            // For now, return success with the data
            return {
                success: true,
                contractData,
                timestamp: Date.now()
            };

        } catch (error) {
            console.error('Contract call failed:', error);
            throw error;
        }
    }

    /**
     * Get current 1DEV burn pricing
     */
    async getCurrentBurnPricing(nodeType) {
        try {
            // Get current burn percentage
            const burnPercent = await this.getBurnPercentage();
            
            // Calculate dynamic pricing
            const baseCost = 1500; // Base cost in 1DEV
            const minCost = 150;   // Minimum cost in 1DEV
            
            // Linear reduction based on burn progress
            const cost = Math.max(minCost, baseCost - (burnPercent * (baseCost - minCost) / 100));
            
            return {
                nodeType,
                cost: Math.round(cost),
                baseCost,
                minCost,
                burnPercent,
                savings: Math.round(baseCost - cost),
                savingsPercent: Math.round(((baseCost - cost) / baseCost) * 100)
            };

        } catch (error) {
            console.error('Failed to get burn pricing:', error);
            return {
                nodeType,
                cost: 1500, // Fallback to base cost
                error: error.message
            };
        }
    }

    /**
     * Get current burn percentage from blockchain
     */
    async getBurnPercentage() {
        try {
            // Query the burn tracker contract for current statistics
            // This would read from the actual Solana program account
            // For now, return mock data based on development progress
            
            const totalSupply = 1000000000; // 1B 1DEV total supply
            const burned = 250000000;       // 250M burned (25%)
            
            return (burned / totalSupply) * 100;

        } catch (error) {
            console.error('Failed to get burn percentage:', error);
            return 25; // Default to 25% for development
        }
    }

    /**
     * Verify burn transaction on blockchain
     */
    async verifyBurnTransaction(signature) {
        try {
            const transaction = await this.connection.getTransaction(signature, {
                commitment: 'confirmed'
            });

            if (!transaction) {
                return { verified: false, error: 'Transaction not found' };
            }

            // Check if transaction was successful
            if (transaction.meta?.err) {
                return { verified: false, error: 'Transaction failed', details: transaction.meta.err };
            }

            // Extract burn details from transaction
            const burnInfo = this.extractBurnInfo(transaction);

            return {
                verified: true,
                transaction,
                burnInfo,
                blockTime: transaction.blockTime,
                slot: transaction.slot
            };

        } catch (error) {
            console.error('Failed to verify burn transaction:', error);
            return { verified: false, error: error.message };
        }
    }

    /**
     * Extract burn information from transaction
     */
    extractBurnInfo(transaction) {
        try {
            // Parse transaction logs and instructions to extract burn details
            const instructions = transaction.transaction.message.instructions;
            const accounts = transaction.transaction.message.accountKeys;
            
            // Find burn instruction
            const burnInstruction = instructions.find(ix => {
                const programId = accounts[ix.programIdIndex];
                return programId.equals(TOKEN_PROGRAM_ID);
            });

            if (!burnInstruction) {
                return null;
            }

            // Extract burn amount from instruction data
            // This would need proper instruction parsing
            return {
                amount: 0, // Would be extracted from instruction data
                mint: this.oneDevMint.toString(),
                authority: null, // Would be extracted
                timestamp: transaction.blockTime
            };

        } catch (error) {
            console.error('Failed to extract burn info:', error);
            return null;
        }
    }

    /**
     * Get transaction history for address
     */
    async getTransactionHistory(publicKey, limit = 10) {
        try {
            const signatures = await this.connection.getSignaturesForAddress(
                new PublicKey(publicKey),
                { limit }
            );

            const transactions = [];
            for (const sig of signatures) {
                try {
                    const tx = await this.connection.getTransaction(sig.signature, {
                        commitment: 'confirmed'
                    });
                    
                    if (tx) {
                        transactions.push({
                            signature: sig.signature,
                            blockTime: tx.blockTime,
                            slot: tx.slot,
                            fee: tx.meta?.fee || 0,
                            success: !tx.meta?.err,
                            type: this.detectTransactionType(tx)
                        });
                    }
                } catch (txError) {
                    console.warn(`Failed to fetch transaction ${sig.signature}:`, txError);
                }
            }

            return transactions;

        } catch (error) {
            console.error('Failed to get transaction history:', error);
            return [];
        }
    }

    /**
     * Detect transaction type
     */
    detectTransactionType(transaction) {
        const instructions = transaction.transaction.message.instructions;
        const accounts = transaction.transaction.message.accountKeys;

        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];
            
            if (programId.equals(TOKEN_PROGRAM_ID)) {
                // Check instruction data to determine if it's a burn
                // This would need proper instruction parsing
                return 'token_operation';
            } else if (programId.equals(SystemProgram.programId)) {
                return 'sol_transfer';
            }
        }

        return 'unknown';
    }

    /**
     * Estimate transaction fee
     */
    async estimateTransactionFee(transaction) {
        try {
            const { feeCalculator } = await this.connection.getRecentBlockhash();
            return transaction.signatures.length * feeCalculator.lamportsPerSignature;
        } catch (error) {
            console.error('Failed to estimate transaction fee:', error);
            return 5000; // Default fee estimate
        }
    }

    /**
     * Get network status
     */
    async getNetworkStatus() {
        try {
            const health = await this.connection.getHealth();
            const version = await this.connection.getVersion();
            const slot = await this.connection.getSlot();
            const blockHeight = await this.connection.getBlockHeight();

            return {
                health,
                version,
                slot,
                blockHeight,
                connected: true
            };

        } catch (error) {
            console.error('Failed to get network status:', error);
            return {
                connected: false,
                error: error.message
            };
        }
    }
} 