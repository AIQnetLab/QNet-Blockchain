/**
 * QNet Mobile Wallet
 * React Native Application
 */

import React from 'react';
import {StatusBar} from 'react-native';
import WalletScreen from './src/screens/WalletScreen';

function App(): React.JSX.Element {
  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor="#1a1a2e" />
      <WalletScreen />
    </>
  );
}

export default App;