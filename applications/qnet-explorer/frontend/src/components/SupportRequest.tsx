'use client';

// The device-check request form of the Support page (src/lib/support-request.ts): it writes the message into the
// visitor's email app and sends nothing from this page.

import { useState } from 'react';
import { t, type MessageKey } from '@/lib/texts';
import { DEVICE_CASES, NOTE_MAX_CHARS, SUPPORT_ADDRESS, deviceCheckMail, type DeviceCase } from '@/lib/support-request';

const CASE_TEXT: Record<DeviceCase, MessageKey> = {
  paused: 'support_case_paused',
  cant_run: 'support_case_cant_run',
  other: 'support_case_other',
};

export default function SupportRequest() {
  const [ref, setRef] = useState('');
  const [kind, setKind] = useState<DeviceCase>('paused');
  const [note, setNote] = useState('');
  const mail = deviceCheckMail({ ref, kind, note });

  return (
    <form className="support-request" onSubmit={(e) => e.preventDefault()}>
      <label>
        {t('support_form_ref')}
        <input
          type="text"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          maxLength={16}
          autoComplete="off"
          spellCheck={false}
          placeholder="ab12cd34"
        />
      </label>
      <label>
        {t('support_form_kind')}
        <select value={kind} onChange={(e) => setKind(e.target.value as DeviceCase)}>
          {DEVICE_CASES.map((c) => (
            <option key={c} value={c}>{t(CASE_TEXT[c])}</option>
          ))}
        </select>
      </label>
      <label>
        {t('support_form_note')}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX_CHARS} rows={3} />
      </label>
      {mail.ok ? (
        <a className="qnet-button activate-primary" href={mail.href}>{t('support_form_write')}</a>
      ) : (
        <p className="activate-note" role="status">
          {t(mail.reason === 'phrase' ? 'support_form_phrase' : 'support_form_ref_missing')}
        </p>
      )}
      <p className="activate-note">{t('support_form_mail_note', { address: SUPPORT_ADDRESS })}</p>
    </form>
  );
}
