/**
 * An answer to aiqnet.io still on its way once its request's sheet is no longer on screen (it gave way to the next
 * link, or was closed): the line under the wallet's header, on the lock screen and on the welcome screen says so until
 * it arrives or fails (services/LinkAnswers).
 */
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { answersAway, watchAnswersAway } from '../services/LinkAnswers';

/** The session ids of the answers on their way, kept current. */
export function useAnswersAway() {
  const [ids, setIds] = useState(answersAway);
  useEffect(() => {
    const stop = watchAnswersAway(() => setIds(answersAway()));
    setIds(answersAway());
    return stop;
  }, []);
  return ids;
}

export default function AnswerAway({ t, style }) {
  const ids = useAnswersAway();
  if (ids.length === 0) return null;
  return <Text style={style} accessibilityLiveRegion="polite" testID="answer-away">{t('link_working_send')}</Text>;
}
