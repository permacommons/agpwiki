import config from 'config';

type EmailProvider = 'resend';

type ResendConfig = {
  apiKey?: string;
  baseUrl?: string;
};

type EmailConfig = {
  enabled: boolean;
  provider?: EmailProvider | null;
  fromEmail?: string;
  fromName?: string;
  resend?: ResendConfig;
};

type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

const defaultResendConfig: ResendConfig = {
  baseUrl: 'https://api.resend.com',
};

const defaultEmailConfig: EmailConfig = {
  enabled: false,
  provider: null,
  resend: defaultResendConfig,
};

export const getEmailConfig = (): EmailConfig => {
  if (typeof config.has === 'function' && config.has('email')) {
    const configured = config.get<EmailConfig>('email');
    return {
      ...defaultEmailConfig,
      ...configured,
      resend: {
        ...defaultResendConfig,
        ...configured.resend,
      },
    };
  }
  return defaultEmailConfig;
};

const sendWithResend = async (email: EmailConfig, message: EmailMessage) => {
  const resend = {
    ...defaultResendConfig,
    ...email.resend,
  };
  if (!resend.apiKey || !email.fromEmail) {
    throw new Error('Email is enabled but Resend configuration is incomplete.');
  }

  const fromName = email.fromName?.trim();
  const from = fromName
    ? `${fromName} <${email.fromEmail}>`
    : email.fromEmail;
  const response = await fetch(`${resend.baseUrl}/emails`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend request failed (${response.status}): ${text}`);
  }
};

export const sendMail = async (message: EmailMessage) => {
  const email = getEmailConfig();
  if (!email.enabled) {
    return { delivered: false, skipped: true as const };
  }

  switch (email.provider) {
    case 'resend':
      await sendWithResend(email, message);
      break;
    default:
      throw new Error('Email is enabled but no supported provider is configured.');
  }

  return { delivered: true as const, skipped: false as const };
};
