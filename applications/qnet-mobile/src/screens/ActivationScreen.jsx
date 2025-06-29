/**
 * QNet Mobile - Activation Screen
 * Production-ready activation interface for Phase 1 and Phase 2
 * Handles 1DEV burn and QNC spend-to-Pool3 activation flows
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
  Dimensions
} from 'react-native';
import { NetworkService } from '../services/NetworkService';
import { BridgeService } from '../services/BridgeService';

const { width: screenWidth } = Dimensions.get('window');

export const ActivationScreen = ({ navigation }) => {
  const [currentPhase, setCurrentPhase] = useState(1);
  const [currentNetwork, setCurrentNetwork] = useState('solana');
  const [isLoading, setIsLoading] = useState(false);
  const [activationStep, setActivationStep] = useState('select'); // select, confirm, processing, complete
  
  // Phase 1 state
  const [devTokenBalance, setDevTokenBalance] = useState(0);
  const [burnAmount, setBurnAmount] = useState('');
  const [selectedNodeType, setSelectedNodeType] = useState('Light');
  
  // Phase 2 state
  const [qncBalance, setQNCBalance] = useState(0);
  const [requiredQNC, setRequiredQNC] = useState(5000);
  const [eonAddress, setEonAddress] = useState('');
  const [networkSize, setNetworkSize] = useState(0);
  
  // Activation progress
  const [activationId, setActivationId] = useState(null);
  const [nodeCode, setNodeCode] = useState('');
  const [activationProgress, setActivationProgress] = useState(0);
  
  const nodeTypes = [
    { type: 'Light', name: 'Light Node', description: 'Basic node with minimal requirements', baseCost: 5000 },
    { type: 'Full', name: 'Full Node', description: 'Standard node with full functionality', baseCost: 7500 },
    { type: 'Super', name: 'Super Node', description: 'High-performance node with maximum rewards', baseCost: 10000 }
  ];

  useEffect(() => {
    initializeActivation();
  }, []);

  const initializeActivation = async () => {
    try {
      setIsLoading(true);
      
      // Initialize services
      await NetworkService.initialize();
      await BridgeService.initialize();
      
      // Detect current phase
      const phase = await NetworkService.detectCurrentPhase();
      setCurrentPhase(phase);
      
      // Load balances
      await loadBalances();
      
      // Calculate required QNC for Phase 2
      if (phase === 2) {
        await calculateRequiredQNC();
      }
      
    } catch (error) {
      console.error('Failed to initialize activation:', error);
      Alert.alert('Error', 'Failed to initialize activation system');
    } finally {
      setIsLoading(false);
    }
  };

  const loadBalances = async () => {
    try {
      if (currentPhase === 1) {
        // Load 1DEV balance for Phase 1
        const solanaData = await NetworkService.switchToSolana();
        setDevTokenBalance(solanaData.balances['1DEV'] || 0);
      } else if (currentPhase === 2) {
        // Load QNC balance for Phase 2
        const qnetData = await NetworkService.switchToQNet();
        setQNCBalance(qnetData.balances.QNC || 0);
        setEonAddress(qnetData.address);
      }
    } catch (error) {
      console.warn('Failed to load balances:', error);
    }
  };

  const calculateRequiredQNC = async () => {
    try {
      const networkStats = await BridgeService.getNetworkStats();
      setNetworkSize(networkStats.networkSize || 0);
      
      // Calculate required QNC based on network size
      const baseCost = nodeTypes.find(n => n.type === selectedNodeType)?.baseCost || 5000;
      let multiplier = 1.0;
      
      if (networkStats.networkSize < 100000) {
        multiplier = 0.5;
      } else if (networkStats.networkSize < 1000000) {
        multiplier = 1.0;
      } else if (networkStats.networkSize < 10000000) {
        multiplier = 2.0;
      } else {
        multiplier = 3.0;
      }
      
      setRequiredQNC(Math.floor(baseCost * multiplier));
    } catch (error) {
      console.warn('Failed to calculate required QNC:', error);
    }
  };

  const startActivation = useCallback(async () => {
    try {
      setIsLoading(true);
      setActivationStep('processing');
      
      // MOBILE RESTRICTION: Only Light nodes can be fully activated
      // Full/Super nodes can only get activation codes
      if (selectedNodeType === 'Light') {
        if (currentPhase === 1) {
          await startPhase1LightNodeActivation();
        } else if (currentPhase === 2) {
          await startPhase2LightNodeActivation();
        }
      } else {
        // Full/Super nodes: Generate activation code only
        await generateActivationCodeOnly();
      }
      
    } catch (error) {
      console.error('Activation failed:', error);
      Alert.alert('Activation Failed', error.message);
      setActivationStep('select');
    } finally {
      setIsLoading(false);
    }
  }, [currentPhase, burnAmount, selectedNodeType, eonAddress]);

  const startPhase1LightNodeActivation = async () => {
    const burnAmountNum = parseFloat(burnAmount);
    
    if (!burnAmountNum || burnAmountNum <= 0) {
      throw new Error('Invalid burn amount');
    }
    
    if (burnAmountNum > devTokenBalance) {
      throw new Error('Insufficient 1DEV balance');
    }

    // Get wallet address
    const solanaData = await NetworkService.switchToSolana();
    
    // MOBILE: Full Light node activation
    const result = await BridgeService.startPhase1Activation(
      solanaData.address,
      burnAmountNum
    );

    if (result.success) {
      setActivationId(result.activationId);
      setNodeCode(result.nodeCode);
      setActivationStep('complete');
      
      Alert.alert(
        'Light Node Activated!',
        `Node Code: ${result.nodeCode}\nType: Light Node\nBurn Amount: ${burnAmountNum} 1DEV`
      );
    }
  };

  const startPhase2LightNodeActivation = async () => {
    if (qncBalance < requiredQNC) {
      throw new Error(`Insufficient QNC. Required: ${requiredQNC}, Available: ${qncBalance}`);
    }

    // MOBILE: Full Light node Phase 2 activation
    const result = await BridgeService.startPhase2Activation(
      eonAddress,
      'Light',
      requiredQNC
    );

    if (result.success) {
      setActivationId(result.activationId);
      setNodeCode(result.nodeCode);
      setActivationStep('complete');
      
      Alert.alert(
        'Light Node Phase 2 Activated!',
        `Node Code: ${result.nodeCode}\nQNC Spent to Pool 3: ${result.qncSpentToPool3}\nEstimated Daily Rewards: ${result.estimatedDailyRewards} QNC`
      );
    }
  };

  const generateActivationCodeOnly = async () => {
    // MOBILE RESTRICTION: Full/Super nodes only get activation codes
    // Must be activated on actual servers
    
    Alert.alert(
      'Server Activation Required',
      `${selectedNodeType} nodes must be activated on dedicated servers.\n\nMobile devices can only activate Light nodes.\n\nWould you like to generate an activation code for server use?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Generate Code', onPress: async () => {
          try {
            const codeResult = await BridgeService.generateActivationCodeOnly(
              selectedNodeType,
              currentPhase === 1 ? burnAmount : requiredQNC
            );
            
            setNodeCode(codeResult.activationCode);
            setActivationStep('complete');
            
            Alert.alert(
              'Activation Code Generated',
              `Code: ${codeResult.activationCode}\n\nUse this code on a server to activate your ${selectedNodeType} node.`
            );
          } catch (error) {
            throw new Error(`Failed to generate activation code: ${error.message}`);
          }
        }}
      ]
    );
  };

  const renderPhaseIndicator = () => (
    <View style={styles.phaseContainer}>
      <View style={[
        styles.phaseBadge,
        currentPhase === 2 && styles.phase2Badge
      ]}>
        <Text style={styles.phaseText}>Phase {currentPhase}</Text>
      </View>
      <Text style={styles.phaseDescription}>
        {currentPhase === 1 ? '1DEV Burn Activation' : 'QNC Pool 3 Activation'}
      </Text>
    </View>
  );

  const renderNodeTypeSelector = () => (
    <View style={styles.nodeTypeContainer}>
      <Text style={styles.sectionTitle}>Select Node Type</Text>
      {nodeTypes.map((nodeType) => (
        <TouchableOpacity
          key={nodeType.type}
          style={[
            styles.nodeTypeCard,
            selectedNodeType === nodeType.type && styles.selectedNodeType
          ]}
          onPress={() => {
            setSelectedNodeType(nodeType.type);
            if (currentPhase === 2) {
              setTimeout(calculateRequiredQNC, 100);
            }
          }}
        >
          <View style={styles.nodeTypeHeader}>
            <Text style={styles.nodeTypeName}>{nodeType.name}</Text>
            <Text style={styles.nodeTypeCost}>
              {currentPhase === 1 ? `${nodeType.baseCost} 1DEV` : `${requiredQNC} QNC`}
            </Text>
          </View>
          <Text style={styles.nodeTypeDescription}>{nodeType.description}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const renderPhase1Interface = () => (
    <View style={styles.activationInterface}>
      <View style={styles.balanceContainer}>
        <Text style={styles.balanceLabel}>Available 1DEV Balance:</Text>
        <Text style={styles.balanceValue}>{devTokenBalance.toFixed(0)} 1DEV</Text>
      </View>

      <View style={styles.inputContainer}>
        <Text style={styles.inputLabel}>Burn Amount (1DEV):</Text>
        <TextInput
          style={styles.input}
          value={burnAmount}
          onChangeText={setBurnAmount}
          placeholder="Enter amount to burn"
          keyboardType="numeric"
          placeholderTextColor="#999"
        />
      </View>

      {renderNodeTypeSelector()}

      <TouchableOpacity
        style={[
          styles.activateButton,
          (!burnAmount || isLoading) && styles.disabledButton
        ]}
        onPress={() => setActivationStep('confirm')}
        disabled={!burnAmount || isLoading}
      >
        <Text style={styles.activateButtonText}>
          {isLoading ? 'Processing...' : 
           selectedNodeType === 'Light' ? 'Activate Light Node' : 'Generate Activation Code'}
        </Text>
      </TouchableOpacity>

      {selectedNodeType !== 'Light' && (
        <Text style={styles.warningText}>
          📱 Mobile devices can only activate Light nodes.{'\n'}
          {selectedNodeType} nodes require server activation.
        </Text>
      )}
    </View>
  );

  const renderPhase2Interface = () => (
    <View style={styles.activationInterface}>
      <View style={styles.balanceContainer}>
        <Text style={styles.balanceLabel}>Available QNC Balance:</Text>
        <Text style={styles.balanceValue}>{qncBalance.toFixed(0)} QNC</Text>
      </View>

      <View style={styles.networkInfoContainer}>
        <Text style={styles.networkInfoLabel}>Network Size: {networkSize.toLocaleString()} nodes</Text>
        <Text style={styles.networkInfoLabel}>EON Address: {eonAddress}</Text>
      </View>

      {renderNodeTypeSelector()}

      <View style={styles.costBreakdown}>
        <Text style={styles.costBreakdownTitle}>Cost Breakdown:</Text>
        <Text style={styles.costBreakdownItem}>
          Base Cost: {nodeTypes.find(n => n.type === selectedNodeType)?.baseCost || 5000} QNC
        </Text>
        <Text style={styles.costBreakdownItem}>
          Network Multiplier: {networkSize < 100000 ? '0.5x' : networkSize < 1000000 ? '1.0x' : networkSize < 10000000 ? '2.0x' : '3.0x'}
        </Text>
        <Text style={styles.costBreakdownTotal}>
          Total Required: {requiredQNC} QNC
        </Text>
      </View>

      <TouchableOpacity
        style={[
          styles.activateButton,
          (qncBalance < requiredQNC || isLoading) && styles.disabledButton
        ]}
        onPress={() => setActivationStep('confirm')}
        disabled={qncBalance < requiredQNC || isLoading}
      >
        <Text style={styles.activateButtonText}>
          {isLoading ? 'Processing...' : 
           selectedNodeType === 'Light' ? 'Activate Light Node' : 'Generate Activation Code'}
        </Text>
      </TouchableOpacity>

      {selectedNodeType !== 'Light' && (
        <Text style={styles.warningText}>
          📱 Mobile devices can only activate Light nodes.{'\n'}
          {selectedNodeType} nodes require server activation.
        </Text>
      )}

      {qncBalance < requiredQNC && (
        <Text style={styles.warningText}>
          Insufficient QNC balance. Need {(requiredQNC - qncBalance).toFixed(0)} more QNC.
        </Text>
      )}
    </View>
  );

  const renderConfirmation = () => (
    <Modal visible={activationStep === 'confirm'} animationType="slide" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Confirm Activation</Text>
          
          <View style={styles.confirmationDetails}>
            <Text style={styles.confirmationItem}>Phase: {currentPhase}</Text>
            <Text style={styles.confirmationItem}>Node Type: {selectedNodeType}</Text>
            {currentPhase === 1 && (
              <Text style={styles.confirmationItem}>Burn Amount: {burnAmount} 1DEV</Text>
            )}
            {currentPhase === 2 && (
              <>
                <Text style={styles.confirmationItem}>QNC to Spend: {requiredQNC} QNC</Text>
                <Text style={styles.confirmationItem}>Goes to Pool 3 for distribution</Text>
              </>
            )}
          </View>

          <View style={styles.modalButtons}>
            <TouchableOpacity
              style={styles.modalButtonCancel}
              onPress={() => setActivationStep('select')}
            >
              <Text style={styles.modalButtonCancelText}>Cancel</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.modalButtonConfirm}
              onPress={startActivation}
              disabled={isLoading}
            >
              <Text style={styles.modalButtonConfirmText}>
                {isLoading ? 'Processing...' : 'Confirm'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );

  const renderComplete = () => (
    <View style={styles.completeContainer}>
      <Text style={styles.completeTitle}>🎉 Activation Complete!</Text>
      <Text style={styles.completeNodeCode}>Node Code: {nodeCode}</Text>
      <Text style={styles.completeDescription}>
        Your {selectedNodeType} node has been successfully activated!
      </Text>
      
      <TouchableOpacity
        style={styles.completeButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.completeButtonText}>Return to Dashboard</Text>
      </TouchableOpacity>
    </View>
  );

  if (isLoading && activationStep === 'select') {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading activation system...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {renderPhaseIndicator()}
      
      {activationStep === 'select' && (
        <>
          {currentPhase === 1 && renderPhase1Interface()}
          {currentPhase === 2 && renderPhase2Interface()}
        </>
      )}
      
      {activationStep === 'complete' && renderComplete()}
      
      {renderConfirmation()}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666666',
  },
  phaseContainer: {
    padding: 20,
    alignItems: 'center',
    backgroundColor: '#F8F9FA',
    borderBottomWidth: 1,
    borderBottomColor: '#E9ECEF',
  },
  phaseBadge: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 25,
    backgroundColor: '#FFC107',
    marginBottom: 8,
  },
  phase2Badge: {
    backgroundColor: '#4CAF50',
  },
  phaseText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    textTransform: 'uppercase',
  },
  phaseDescription: {
    fontSize: 16,
    color: '#666666',
    textAlign: 'center',
  },
  activationInterface: {
    padding: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333333',
    marginBottom: 16,
  },
  balanceContainer: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  balanceLabel: {
    fontSize: 16,
    color: '#666666',
  },
  balanceValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333333',
  },
  inputContainer: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 16,
    color: '#333333',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E9ECEF',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    backgroundColor: '#FFFFFF',
  },
  nodeTypeContainer: {
    marginBottom: 24,
  },
  nodeTypeCard: {
    borderWidth: 2,
    borderColor: '#E9ECEF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    backgroundColor: '#FFFFFF',
  },
  selectedNodeType: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F8FF',
  },
  nodeTypeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  nodeTypeName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
  },
  nodeTypeCost: {
    fontSize: 16,
    fontWeight: '700',
    color: '#007AFF',
  },
  nodeTypeDescription: {
    fontSize: 14,
    color: '#666666',
  },
  networkInfoContainer: {
    backgroundColor: '#F0F8FF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  networkInfoLabel: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 4,
  },
  costBreakdown: {
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
  },
  costBreakdownTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
    marginBottom: 8,
  },
  costBreakdownItem: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 4,
  },
  costBreakdownTotal: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333333',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#E9ECEF',
  },
  activateButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  disabledButton: {
    backgroundColor: '#CCCCCC',
  },
  activateButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  warningText: {
    fontSize: 14,
    color: '#F44336',
    textAlign: 'center',
    marginTop: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333333',
    textAlign: 'center',
    marginBottom: 20,
  },
  confirmationDetails: {
    marginBottom: 24,
  },
  confirmationItem: {
    fontSize: 16,
    color: '#666666',
    marginBottom: 8,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalButtonCancel: {
    flex: 1,
    padding: 12,
    marginRight: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E9ECEF',
    alignItems: 'center',
  },
  modalButtonCancelText: {
    fontSize: 16,
    color: '#666666',
  },
  modalButtonConfirm: {
    flex: 1,
    padding: 12,
    marginLeft: 8,
    borderRadius: 8,
    backgroundColor: '#007AFF',
    alignItems: 'center',
  },
  modalButtonConfirmText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  completeContainer: {
    padding: 40,
    alignItems: 'center',
  },
  completeTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#4CAF50',
    textAlign: 'center',
    marginBottom: 16,
  },
  completeNodeCode: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333333',
    textAlign: 'center',
    marginBottom: 12,
    fontFamily: 'monospace',
  },
  completeDescription: {
    fontSize: 16,
    color: '#666666',
    textAlign: 'center',
    marginBottom: 32,
  },
  completeButton: {
    backgroundColor: '#4CAF50',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 16,
  },
  completeButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});

export default ActivationScreen; 