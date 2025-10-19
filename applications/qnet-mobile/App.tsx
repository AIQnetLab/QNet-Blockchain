/**
 * QNet Mobile Wallet
 * React Native Application
 */

import React from 'react';
import {StatusBar} from 'react-native';
import WalletScreen from './src/screens/WalletScreen';
import ErrorBoundary from './src/components/ErrorBoundary';

function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
      <WalletScreen />
    </ErrorBoundary>
  );
}

export default App;