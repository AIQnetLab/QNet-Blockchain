import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { 
      hasError: false, 
      error: null,
      errorInfo: null,
      errorCount: 0
    };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    // Log error details for debugging
    console.error('ErrorBoundary caught:', error, errorInfo);
    
    // Save error to state for display
    this.setState({
      error: error,
      errorInfo: errorInfo,
      errorCount: this.state.errorCount + 1
    });

    // Log to AsyncStorage for debugging
    this.logErrorToStorage(error, errorInfo);
  }

  async logErrorToStorage(error, errorInfo) {
    try {
      const errorLog = {
        timestamp: new Date().toISOString(),
        message: error.toString(),
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        errorCount: this.state.errorCount + 1
      };
      
      // Keep last 10 errors
      const existingLogs = await AsyncStorage.getItem('qnet_error_logs');
      let logs = existingLogs ? JSON.parse(existingLogs) : [];
      logs.unshift(errorLog);
      logs = logs.slice(0, 10);
      
      await AsyncStorage.setItem('qnet_error_logs', JSON.stringify(logs));
    } catch (e) {
      console.error('Failed to log error:', e);
    }
  }

  handleReset = () => {
    this.setState({ 
      hasError: false, 
      error: null, 
      errorInfo: null 
    });
  };

  handleClearCache = async () => {
    try {
      // Clear problematic cached data
      const keysToRemove = [
        'blockchain_check_',
        'qnet_node_rewards_',
        'qnet_activation_meta_'
      ];
      
      const allKeys = await AsyncStorage.getAllKeys();
      const keysToDelete = allKeys.filter(key => 
        keysToRemove.some(prefix => key.startsWith(prefix))
      );
      
      if (keysToDelete.length > 0) {
        await AsyncStorage.multiRemove(keysToDelete);
      }
      
      Alert.alert(
        'Cache Cleared',
        'App cache has been cleared. The app will now restart.',
        [
          {
            text: 'OK',
            onPress: () => {
              // Reset the error boundary
              this.handleReset();
            }
          }
        ]
      );
    } catch (error) {
      Alert.alert('Error', 'Failed to clear cache: ' + error.message);
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>Oops! Something went wrong</Text>
            
            <Text style={styles.subtitle}>
              The app encountered an unexpected error. You can try to continue or clear the cache if the problem persists.
            </Text>

            {__DEV__ && this.state.error && (
              <View style={styles.errorDetails}>
                <Text style={styles.errorTitle}>Error Details (Dev Mode):</Text>
                <Text style={styles.errorText}>
                  {this.state.error.toString()}
                </Text>
                {this.state.error.stack && (
                  <Text style={styles.errorStack}>
                    {this.state.error.stack.slice(0, 500)}...
                  </Text>
                )}
              </View>
            )}

            <View style={styles.buttonContainer}>
              <TouchableOpacity 
                style={[styles.button, styles.primaryButton]}
                onPress={this.handleReset}
              >
                <Text style={styles.buttonText}>Try Again</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[styles.button, styles.secondaryButton]}
                onPress={this.handleClearCache}
              >
                <Text style={styles.buttonText}>Clear Cache</Text>
              </TouchableOpacity>
            </View>

            {this.state.errorCount > 2 && (
              <Text style={styles.warning}>
                The app has crashed {this.state.errorCount} times. 
                Consider clearing the cache or reinstalling the app.
              </Text>
            )}
          </ScrollView>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ff4444',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#b0b0b0',
    textAlign: 'center',
    marginBottom: 30,
    lineHeight: 22,
  },
  errorDetails: {
    backgroundColor: '#1a1a2e',
    padding: 15,
    borderRadius: 10,
    marginBottom: 20,
    width: '100%',
  },
  errorTitle: {
    color: '#ff4444',
    fontWeight: 'bold',
    marginBottom: 5,
  },
  errorText: {
    color: '#fff',
    fontSize: 12,
    marginBottom: 10,
  },
  errorStack: {
    color: '#888',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
  },
  button: {
    paddingHorizontal: 30,
    paddingVertical: 15,
    borderRadius: 25,
    minWidth: 120,
  },
  primaryButton: {
    backgroundColor: '#00d4ff',
  },
  secondaryButton: {
    backgroundColor: '#16213e',
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  warning: {
    color: '#ff9900',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 20,
    fontStyle: 'italic',
  },
});

export default ErrorBoundary;
