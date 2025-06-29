/**
 * QNet Mobile - Dual Network Manager Component
 * React Native implementation for switching between Solana and QNet networks
 * Production-ready mobile interface with touch-optimized controls
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  ScrollView,
  RefreshControl
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NetworkService } from '../services/NetworkService';

export const DualNetworkManager = ({ onNetworkChange }) => {
  const [currentNetwork, setCurrentNetwork] = useState('solana');
  const [currentPhase, setCurrentPhase] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [networkData, setNetworkData] = useState(null);

  useEffect(() => {
    initializeNetworks();
  }, []);

  const initializeNetworks = async () => {
    try {
      setIsLoading(true);
      await NetworkService.initialize();
      const phase = await NetworkService.detectCurrentPhase();
      setCurrentPhase(phase);
      
      const savedNetwork = await AsyncStorage.getItem('currentNetwork');
      await switchNetwork(savedNetwork || 'solana', false);
    } catch (error) {
      console.error('Failed to initialize networks:', error);
      Alert.alert('Error', 'Failed to initialize wallet networks');
    } finally {
      setIsLoading(false);
    }
  };

  const switchNetwork = useCallback(async (network, showLoading = true) => {
    if (currentNetwork === network && !showLoading) return;
    
    try {
      if (showLoading) setIsLoading(true);
      
      let data;
      if (network === 'solana') {
        data = await NetworkService.switchToSolana();
      } else if (network === 'qnet') {
        data = await NetworkService.switchToQNet();
      }
      
      setCurrentNetwork(network);
      setNetworkData(data);
      
      await AsyncStorage.setItem('currentNetwork', network);
      
      if (onNetworkChange) {
        onNetworkChange({ network, phase: currentPhase, data });
      }
      
    } catch (error) {
      console.error(`Failed to switch to ${network}:`, error);
      Alert.alert('Network Error', `Failed to switch to ${network} network`);
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [currentNetwork, currentPhase, onNetworkChange]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await switchNetwork(currentNetwork, false);
    setRefreshing(false);
  }, [currentNetwork, switchNetwork]);

  if (isLoading && !networkData) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Connecting to networks...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
      }
    >
      {/* Network Switcher */}
      <View style={styles.networkSwitcher}>
        <TouchableOpacity
          style={[
            styles.networkButton,
            currentNetwork === 'solana' && styles.activeNetworkButton
          ]}
          onPress={() => switchNetwork('solana')}
          disabled={isLoading}
        >
          <Text style={styles.networkIcon}>🔥</Text>
          <Text style={[
            styles.networkText,
            currentNetwork === 'solana' && styles.activeNetworkText
          ]}>
            Solana
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.networkButton,
            currentNetwork === 'qnet' && styles.activeNetworkButton
          ]}
          onPress={() => switchNetwork('qnet')}
          disabled={isLoading}
        >
          <Text style={styles.networkIcon}>💎</Text>
          <Text style={[
            styles.networkText,
            currentNetwork === 'qnet' && styles.activeNetworkText
          ]}>
            QNet
          </Text>
        </TouchableOpacity>
      </View>

      {/* Phase Indicator */}
      <View style={styles.phaseContainer}>
        <View style={[
          styles.phaseBadge,
          currentPhase === 2 && styles.phase2Badge
        ]}>
          <Text style={styles.phaseText}>Phase {currentPhase}</Text>
        </View>
      </View>

      {/* Network Information */}
      {networkData && (
        <View style={styles.networkInfo}>
          <Text style={styles.addressLabel}>
            {currentNetwork === 'solana' ? 'Solana Address' : 'EON Address'}:
          </Text>
          <Text style={styles.addressText}>
            {networkData.address || 'Not connected'}
          </Text>

          {/* Balances */}
          <View style={styles.balancesContainer}>
            {currentNetwork === 'solana' && networkData.balances && (
              <>
                <View style={styles.balanceItem}>
                  <Text style={styles.balanceLabel}>SOL</Text>
                  <Text style={styles.balanceValue}>
                    {networkData.balances.SOL?.toFixed(3) || '0.00'}
                  </Text>
                </View>
                <View style={styles.balanceItem}>
                  <Text style={styles.balanceLabel}>1DEV</Text>
                  <Text style={styles.balanceValue}>
                    {networkData.balances['1DEV'] || '0'}
                  </Text>
                </View>
              </>
            )}
            
            {currentNetwork === 'qnet' && networkData.balances && (
              <View style={styles.balanceItem}>
                <Text style={styles.balanceLabel}>QNC</Text>
                <Text style={styles.balanceValue}>
                  {networkData.balances.QNC || '0'}
                </Text>
              </View>
            )}
          </View>

          {/* Node Information */}
          {currentNetwork === 'qnet' && networkData.nodeInfo && (
            <View style={styles.nodeInfo}>
              <Text style={styles.nodeTitle}>🤖 Active Node</Text>
              <Text style={styles.nodeDetail}>Code: {networkData.nodeInfo.code}</Text>
              <Text style={styles.nodeDetail}>Type: {networkData.nodeInfo.type} Node</Text>
              <Text style={styles.nodeDetail}>Status: {networkData.nodeInfo.status}</Text>
            </View>
          )}
        </View>
      )}
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
    marginTop: 12,
    fontSize: 16,
    color: '#666666',
    textAlign: 'center',
  },
  networkSwitcher: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: '#F8F9FA',
  },
  networkButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 8,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#E9ECEF',
  },
  activeNetworkButton: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F8FF',
  },
  networkIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  networkText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
  },
  activeNetworkText: {
    color: '#007AFF',
  },
  phaseContainer: {
    padding: 16,
    alignItems: 'center',
  },
  phaseBadge: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#FFC107',
  },
  phase2Badge: {
    backgroundColor: '#4CAF50',
  },
  phaseText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  networkInfo: {
    padding: 16,
  },
  addressLabel: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 4,
  },
  addressText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333333',
    fontFamily: 'monospace',
    marginBottom: 16,
  },
  balancesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  balanceItem: {
    flex: 1,
    backgroundColor: '#F8F9FA',
    borderRadius: 12,
    padding: 16,
    margin: 8,
    alignItems: 'center',
  },
  balanceLabel: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 4,
  },
  balanceValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333333',
  },
  nodeInfo: {
    backgroundColor: '#F0F8FF',
    borderRadius: 12,
    padding: 16,
  },
  nodeTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333333',
    marginBottom: 8,
  },
  nodeDetail: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 4,
  },
});

export default DualNetworkManager;
