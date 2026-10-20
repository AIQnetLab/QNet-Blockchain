import React from 'react';
import {
  View,
  Text,
  Alert,
  ScrollView
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import logger from '../utils/logger';
import { tr } from '../i18n';
import Action from './ui/Action';
import { color, size, space, themed } from '../theme';

// The caches "Clear cache" removes, by exact key (services/HistoryCache, services/NodePool, the Node tab's last reads).
export const CACHE_KEYS = Object.freeze(['qnet_node_rewards', 'qnet_cached_server_status', 'qnet_tx_history', 'qnet_node_pool']);

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
    logger.error('ErrorBoundary caught:', error, errorInfo);
    
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
      .replace(/QNET-[A-Z0-9]{4,6}-[A-Z0-9]{3,6}-[A-Z0-9]{5,6}/gi, 'QNET-…')
      .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, '…base64…')
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
        // Safe summary: error name + first line of message (no stack data), with addresses, codes and
        // key-like strings masked the same way as the frames.
        name: error?.name || 'Error', // i18n-ignore: a stored log field, never shown
        summary: this.redactStack((error?.message || error?.toString() || '').split('\n')[0]).slice(0, 200),
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
      logger.error('Failed to log error:', e);
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
      // Only what the app reads again from the network by itself: the node balance and server status it last showed,
      // the confirmed history rows and the read pool. The wallet, its node record and its settings stay.
      const allKeys = await AsyncStorage.getAllKeys();
      const keysToDelete = allKeys.filter((key) => CACHE_KEYS.includes(key));
      if (keysToDelete.length > 0) await AsyncStorage.multiRemove(keysToDelete);
      // Success is said only for a cache that was there and is gone now.
      const removed = keysToDelete.length > 0;
      Alert.alert(
        removed ? tr('crash_cache_cleared_title') : '',
        tr(removed ? 'crash_cache_cleared_body' : 'crash_cache_empty'),
        [
          {
            text: tr('common_ok'),
            onPress: () => {
              // Reset the error boundary
              this.handleReset();
            }
          }
        ]
      );
    } catch (error) {
      Alert.alert(tr('error'), `${tr('crash_clear_failed')}\n${tr('err_detail', { detail: (error && error.message) || '' })}`);
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>{tr('crash_title')}</Text>
            
            <Text style={styles.subtitle}>{tr('crash_body')}</Text>

            {/* Raw error text / stack can embed file paths, inlined values and
                secrets — only render it in dev builds, never in production UI. */}
            {__DEV__ && this.state.error && (
              <View style={styles.errorDetails}>
                <Text style={styles.errorTitle}>{tr('crash_details')}</Text>
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
              <Action kind="solid" label={tr('common_try_again')} onPress={this.handleReset} />
              <Action kind="text" label={tr('crash_clear_cache')} onPress={this.handleClearCache} />
            </View>

            {this.state.errorCount > 2 && (
              <Text style={styles.warning}>{tr('crash_count', { count: this.state.errorCount })}</Text>
            )}
          </ScrollView>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = themed((type) => ({
  container: {
    flex: 1,
    backgroundColor: color.ink,
  },
  // Fills the screen so short content sits in the middle, start-aligned, but can outgrow it and scroll.
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'stretch',
    width: '100%',
    maxWidth: size.column,
    alignSelf: 'center',
    padding: space.gut,
  },
  title: {
    ...type('title'),
    color: color.paper,
    marginBottom: space.s12,
  },
  subtitle: {
    ...type('body'),
    color: color.text,
    marginBottom: space.s24,
  },
  errorDetails: {
    paddingVertical: space.s12,
    borderTopWidth: 1,
    borderTopColor: color.rule,
    marginBottom: space.s16,
  },
  errorTitle: {
    ...type('label'),
    color: color.fog,
    marginBottom: space.s4,
  },
  errorText: {
    ...type('data', 12),
    color: color.paper,
    marginBottom: space.s8,
  },
  errorStack: {
    ...type('data', 10),
    color: color.fog,
  },
  buttonContainer: {
    alignSelf: 'stretch',
    gap: space.s8,
    marginTop: space.s16,
  },
  warning: {
    ...type('note'),
    color: color.ember,
    marginTop: space.s16,
  },
}));

export default ErrorBoundary;
