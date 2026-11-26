import {
  digestMessage, emailChangeMessage, inviteMessage, resetMessage, signInMessage, teamMessage, testMessage, type MailMessage,
} from '../../server/services/mailMessages.ts';

/**
 * Every message Vantage sends, built from plain samples through its own composer: what the look tests render, in Node
 * and in a browser. Each kind is one of the seven the mailer retries (email.ts RETRY_WINDOW_MINUTES).
 */
const origin = 'https://vantage.example.mil';
const marking = 'CUI//PRVCY';

export const MAIL_SAMPLES: Record<string, MailMessage> = {
  reset: resetMessage({ firstName: 'Avery', username: 'avery.stone', url: `${origin}/reset?token=sample-reset`, origin }),
  email_change: emailChangeMessage({ username: 'avery.stone', email: 'avery.stone@usmc.mil', url: `${origin}/settings?verify=sample-verify`, origin }),
  invite: inviteMessage({ inviter: 'SSgt Blake Rivers', unitName: 'G-8 Comptroller', unitShortName: 'G8', url: `${origin}/invite?token=sample-invite`, origin }),
  test: testMessage({ appUrl: origin, provider: 'smtp', from: 'Vantage <no-reply@vantage.example.mil>', sentAt: 'Nov 24, 2026, 9:00 AM EST', origin }),
  sign_in: signInMessage({
    greeting: 'SSgt Stone', username: 'avery.stone', returning: false, senderName: 'Cpl John Boletz', unitName: 'G-8 Comptroller',
    host: 'vantage.example.mil', url: `${origin}/reset?token=sample-sign-in`, expires: 'in 72 hours, on Nov 27 at 9:00 AM', origin,
  }),
  team_message: teamMessage({
    unitLabel: 'G8', unitName: 'G-8 Comptroller', subject: 'Close-out Friday', body: 'Line one.\nLine two.\n\nA second paragraph.',
    senderName: 'SSgt Blake Rivers', replies: true, messageUrl: `${origin}/team/messages/sample-message`, marking, origin,
    files: [{ name: 'Close-out checklist.pdf', mime: 'application/pdf', size: 248_320 }, { name: 'Funds status.csv', mime: 'text/csv', size: 3_412 }], keptDays: 180,
  }),
  digest: digestMessage({
    firstName: 'Avery', logged: 4, impact: '$1.2M', overdue: 2, dueSoon: 3,
    sections: [{ heading: 'Overdue', lines: ['Quarterly certification', 'Annual training'] }, { heading: 'Due in 14 days', lines: ['Unit funds review'] }],
    appUrl: origin, marking, origin,
  }),
};

/** The marking the two messages that carry one were given. */
export const SAMPLE_MARKING = marking;
