/**
 * The Copy button under a secret on screen (the recovery phrase, a private key): an outlined action with its label alone,
 * the secret above it copying nothing. A copy that landed turns it Signal with Copied for COPIED_MS, as every copy of the
 * app does (ui/Copyable useCopied), then it is the Copy button again. The copy goes through DeviceSecurity copySecret:
 * off the clipboard after SECRET_CLIPBOARD_SECONDS if still there, and when the wallet is deleted.
 */
import React from 'react';
import Action from './Action';
import { COPIED_MS, useCopied } from './Copyable';
import { copySecret } from '../../services/DeviceSecurity';
import { tr } from '../../i18n';

export default function SecretCopy({ secret, label, t = tr, style, testID }) {
  const [done, copy] = useCopied(COPIED_MS, t);
  const shown = done ? t('common_copied') : label;
  return (
    <Action
      kind="text"
      align="center"
      done={done}
      label={shown}
      accessibilityLabel={shown}
      onPress={() => copy(() => copySecret(secret))}
      style={style}
      testID={testID}
    />
  );
}
