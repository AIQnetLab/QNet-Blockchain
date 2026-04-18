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

  // ---------------------------------------------------------------------------
  // v14.5: REDACTED ERROR LOGGING
  // ---------------------------------------------------------------------------
  // Previous implementation stored full `error.stack` and `componentStack`
  // in plaintext AsyncStorage. Stack traces frequently embed file paths,
  // local variables (React renders values inline), and sometimes secrets
  // (addresses, tokens, JSON bodies). On a lost / compromised device these
  // logs become an info-leak surface.
  //
  // New rule: record ONLY non-sensitive summary fields and a SHA-256 hash of
  // the stack for support-side deduplication. The raw stack is never written
  // to disk. If the user explicitly opts in later (debug flag), a session-
  // scoped in-memory copy can be generated — but never persisted plaintext.
  // ---------------------------------------------------------------------------
  redactStack(raw) {
    if (!raw || typeof raw !== 'string') return '';
    // Strip anything that looks like an address, a JSON value, or a hex blob.
    return raw
      .replace(/0x[a-fA-F0-9]{10,}/g, '0x…')
      .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '…base64…')
      .replace(/"[^"]{32,}"/g, '"…"')
      .split('\n')
      .slice(0, 5) // keep only top 5 frames
      .map((line) => line.replace(/\([^)]*\)/g, '(…)')) // drop args
      .join('\n');
  }

  async computeStackFingerprint(stack) {
    try {
      const { sha256 } = await import('js-sha256');
      return sha256(stack || '').slice(0, 16);
    } catch {
      // Fallback: simple length-based tag (no sensitive content).
      return `len:${(stack || '').length}`;
    }
  }

  async logErrorToStorage(error, errorInfo) {
    try {
      const rawStack = error?.stack || '';
      const rawComponentStack = errorInfo?.componentStack || '';
      const errorLog = {
        timestamp: new Date().toISOString(),
        // Safe summary: error name + first line of message (no stack data).
        name: error?.name || 'Error',
        summary: (error?.message || error?.toString() || '').split('\n')[0].slice(0, 200),
        // Fingerprint for de-dup / support correlation — not reversible.
        stackFp: await this.computeStackFingerprint(rawStack),
        componentStackFp: await this.computeStackFingerprint(rawComponentStack),
        // Sanitised top frames only, for triage without PII leak.
        stackTopRedacted: this.redactStack(rawStack),
        errorCount: this.state.errorCount + 1,
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

            {this.state.error && (
              <View style={styles.errorDetails}>
                <Text style={styles.errorTitle}>Error Details:</Text>
                <Text style={styles.errorText}>
                  {this.state.error.toString()}
                </Text>
                {this.state.error.stack && (
                  <Text style={styles.errorStack}>
                    {this.state.error.stack.slice(0, 800)}
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
